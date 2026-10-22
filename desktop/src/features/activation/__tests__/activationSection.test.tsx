// @vitest-environment jsdom
/** 设置页 → 激活区块四态与错误提示（desktop-activation 9.1）：主进程快照驱动，前端不推断状态。 */
import { App as AntdApp } from 'antd';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { ActivationOperationResult, ActivationSnapshot } from '@dramaclip/protocol';
import { ActivationSection } from '../ActivationSection';

const api = vi.hoisted(() => ({
  status: vi.fn<(recheck?: boolean) => Promise<ActivationSnapshot>>(),
  redeem: vi.fn<(code: string) => Promise<ActivationOperationResult>>(),
  unbind: vi.fn<() => Promise<ActivationOperationResult>>(),
  onChange: vi.fn<(callback: (snapshot: ActivationSnapshot) => void) => () => void>(),
}));

vi.mock('../../../services/client', () => ({
  activationApi: {
    status: (recheck?: boolean) => api.status(recheck),
    redeem: (code: string) => api.redeem(code),
    unbind: () => api.unbind(),
    onChange: (callback: (snapshot: ActivationSnapshot) => void): (() => void) =>
      api.onChange(callback),
  },
}));

const INACTIVE: ActivationSnapshot = {
  status: 'inactive',
  plan: '',
  expiresAt: '',
  lastVerifiedAt: '',
  maskedCode: '',
  gatewayUrl: '',
};

const VERIFYING: ActivationSnapshot = {
  ...INACTIVE,
  status: 'verifying',
  plan: 'pro',
  expiresAt: '2027-01-01T00:00:00Z',
  maskedCode: '••••1234',
  gatewayUrl: 'http://gw.test',
};

const ACTIVE: ActivationSnapshot = {
  ...VERIFYING,
  status: 'active',
  lastVerifiedAt: '2026-10-22T12:00:00Z',
};

const SUSPENDED: ActivationSnapshot = {
  ...ACTIVE,
  status: 'suspended',
  reason: 'device_conflict',
};

let lastChangeListener: ((snapshot: ActivationSnapshot) => void) | null = null;

beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }));
  class NoResizeObserver {
    observe(): void {
      // 仅测试挂载
    }

    unobserve(): void {
      // 仅测试挂载
    }

    disconnect(): void {
      // 仅测试挂载
    }
  }
  globalThis.ResizeObserver = NoResizeObserver;
});

function mountWith(snapshot: ActivationSnapshot): void {
  api.status.mockResolvedValue(snapshot);
  api.onChange.mockImplementation((callback: (next: ActivationSnapshot) => void) => {
    lastChangeListener = callback;
    return () => undefined;
  });
  render(
    <AntdApp>
      <ActivationSection />
    </AntdApp>,
  );
}

afterEach(() => {
  cleanup();
  api.status.mockReset();
  api.redeem.mockReset();
  api.unbind.mockReset();
  api.onChange.mockReset();
  lastChangeListener = null;
});

it('未激活：展示码输入、激活按钮与只读网关地址', async () => {
  mountWith(INACTIVE);

  expect(await screen.findByText('未激活')).toBeTruthy();
  expect(screen.getByPlaceholderText(/输入激活码/)).toBeTruthy();
  expect(screen.getByRole('button', { name: /激\s*活/ })).toBeTruthy();
  expect(screen.getByText(/未配置（DRAMACLIP_GATEWAY_URL/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /解\s*绑/ })).toBeNull();
});

it('校验中：显示校验提示与脱敏码，不显示明文信息', async () => {
  mountWith(VERIFYING);

  expect(await screen.findByText('校验中')).toBeTruthy();
  expect(screen.getByText('正在向激活网关校验…')).toBeTruthy();
  expect(screen.getByText('••••1234')).toBeTruthy();
  expect(screen.getByText('http://gw.test')).toBeTruthy();
  expect(screen.queryByText(/1234-5678-ABCD/)).toBeNull();
});

it('已激活：套餐/到期/最近校验 + 解绑入口，无码输入框', async () => {
  mountWith(ACTIVE);

  expect(await screen.findByText('已激活')).toBeTruthy();
  expect(screen.getByText('pro')).toBeTruthy();
  expect(screen.getByText(/2027-01-01/)).toBeTruthy();
  expect(screen.getByText(/2026-10-22/)).toBeTruthy();
  expect(screen.getByRole('button', { name: /解\s*绑/ })).toBeTruthy();
  expect(screen.queryByPlaceholderText(/输入激活码/)).toBeNull();
});

it('已暂停：原因可读，并提示本地功能不受影响', async () => {
  mountWith(SUSPENDED);

  expect(await screen.findByText('已暂停')).toBeTruthy();
  expect(screen.getByText(/激活码已在其他设备使用/)).toBeTruthy();
  expect(screen.getByText(/本地转写、字幕、剪辑与导出不受影响/)).toBeTruthy();
  expect(screen.getByRole('button', { name: '重新校验' })).toBeTruthy();
});

it.each([
  ['401', '激活码无效或已停用（401 invalid_activation_code）'],
  ['403', '激活码已过期（403 activation_expired）'],
  ['429', '网关限流，请稍后重试（429 rate_limited）'],
  ['网络', '无法连接激活网关，请检查网络或网关地址'],
])('%s 失败：提示原文可读，状态不变', async (_kind, message) => {
  const failed: ActivationOperationResult = { ok: false, snapshot: INACTIVE, message };
  api.redeem.mockResolvedValue(failed);
  mountWith(INACTIVE);
  await screen.findByText('未激活');

  fireEvent.change(screen.getByPlaceholderText(/输入激活码/), {
    target: { value: 'CODE-1234-ABCD' },
  });
  fireEvent.click(screen.getByRole('button', { name: /激\s*活/ }));

  expect(await screen.findByText(message)).toBeTruthy();
  expect(screen.getByText('未激活')).toBeTruthy();
  expect(api.redeem).toHaveBeenCalledWith('CODE-1234-ABCD');
});

it('主进程广播 activation:changed 后立即改状态', async () => {
  mountWith(INACTIVE);
  await screen.findByText('未激活');

  act(() => {
    lastChangeListener?.(ACTIVE);
  });

  expect(await screen.findByText('已激活')).toBeTruthy();
});

it('解绑需确认，确认后调用主进程', async () => {
  api.unbind.mockResolvedValue({ ok: true, snapshot: INACTIVE });
  mountWith(ACTIVE);
  await screen.findByText('已激活');

  fireEvent.click(screen.getByRole('button', { name: /解\s*绑/ }));
  fireEvent.click(await screen.findByRole('button', { name: '确认解绑' }));

  expect(api.unbind).toHaveBeenCalledTimes(1);
});
