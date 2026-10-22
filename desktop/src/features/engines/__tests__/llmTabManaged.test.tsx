// @vitest-environment jsdom
/** LLM 受管分支（desktop-activation 9.2）：托管态不挂载手动配置，暂停态给出原因与重校验。 */
import { App as AntdApp } from 'antd';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { ActivationSnapshot, EngineConfig } from '@dramaclip/protocol';
import { LlmTab } from '../LlmTab';

const api = vi.hoisted(() => ({
  status: vi.fn<(recheck?: boolean) => Promise<ActivationSnapshot>>(),
  onChange: vi.fn<(callback: (snapshot: ActivationSnapshot) => void) => () => void>(),
  list: vi.fn<(domain: string) => Promise<{ configs: EngineConfig[] }>>(),
}));

vi.mock('../../../services/client', () => ({
  activationApi: {
    status: (recheck?: boolean) => api.status(recheck),
    redeem: (code: string) => Promise.resolve({ ok: true, snapshot: INACTIVE, message: code }),
    unbind: () => Promise.resolve({ ok: true, snapshot: INACTIVE }),
    onChange: (callback: (snapshot: ActivationSnapshot) => void) => api.onChange(callback),
  },
  engineConfigsApi: {
    list: (domain: string) => api.list(domain),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    enable: vi.fn(),
    enableLocal: vi.fn(),
    test: vi.fn(),
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

const ACTIVE: ActivationSnapshot = {
  status: 'active',
  plan: 'pro',
  expiresAt: '2027-01-01T00:00:00Z',
  lastVerifiedAt: '2026-10-22T12:00:00Z',
  maskedCode: '••••1234',
  gatewayUrl: 'http://gw.test',
};

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
  api.onChange.mockReturnValue(() => undefined);
  api.list.mockResolvedValue({ configs: [] });
  render(
    <AntdApp>
      <LlmTab onChanged={() => undefined} />
    </AntdApp>,
  );
}

afterEach(() => {
  cleanup();
  api.status.mockReset();
  api.onChange.mockReset();
  api.list.mockReset();
});

it('未激活：沿用现有手动配置入口', async () => {
  mountWith(INACTIVE);

  expect(await screen.findByText(/未配置时/)).toBeTruthy();
  expect(await screen.findByText('添加配置')).toBeTruthy();
  expect(screen.queryByText(/受管模式/)).toBeNull();
});

it('已激活：只读托管面板，无 base_url / api_key / model 输入与配置列表', async () => {
  mountWith(ACTIVE);

  expect(await screen.findByText(/受管模式/)).toBeTruthy();
  expect(screen.getByText('default（由网关路由）')).toBeTruthy();
  expect(screen.getByText('pro')).toBeTruthy();
  expect(screen.queryByText('添加配置')).toBeNull();
  expect(screen.queryByText(/未配置时/)).toBeNull();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByRole('button', { name: '启用' })).toBeNull();
  expect(api.list).not.toHaveBeenCalled();
});

it('已暂停：展示暂停原因与「重新校验」，仍不暴露手动配置', async () => {
  mountWith({ ...ACTIVE, status: 'suspended', reason: 'network' });

  expect(await screen.findByText(/已暂停：无法连接激活网关/)).toBeTruthy();
  expect(screen.getByRole('button', { name: '重新校验' })).toBeTruthy();
  expect(screen.queryByText('添加配置')).toBeNull();
  expect(screen.queryByRole('textbox')).toBeNull();
});
