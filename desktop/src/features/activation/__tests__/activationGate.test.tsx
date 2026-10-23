// @vitest-environment jsdom
/** 首启强制激活门禁：未激活整屏阻断、激活后进入应用、失败留在门禁。 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { ActivationOperationResult, ActivationSnapshot } from '@dramaclip/protocol';
import { ActivationGate } from '../ActivationGate';

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

const ACTIVE: ActivationSnapshot = {
  status: 'active',
  plan: 'pro',
  expiresAt: '2027-01-01T00:00:00Z',
  lastVerifiedAt: '2026-10-22T12:00:00Z',
  maskedCode: '••••1234',
  gatewayUrl: 'http://gw.test',
};

function renderGate(): void {
  render(
    <ActivationGate>
      <div data-testid="app-shell">应用内容</div>
    </ActivationGate>,
  );
}

beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
    onchange: null,
  }));
});

beforeEach(() => {
  api.status.mockReset();
  api.redeem.mockReset();
  api.unbind.mockReset();
  api.onChange.mockReset();
  api.onChange.mockReturnValue(() => undefined);
});

afterEach(cleanup);

it('未激活时整屏阻断，不渲染应用内容', async () => {
  api.status.mockResolvedValue(INACTIVE);
  renderGate();
  expect(await screen.findByText('激活 DramaClip')).toBeTruthy();
  expect(screen.queryByTestId('app-shell')).toBeNull();
  expect(screen.queryByPlaceholderText('输入激活码（8–128 个字符）')).toBeTruthy();
});

it('已激活直接进入应用', async () => {
  api.status.mockResolvedValue(ACTIVE);
  renderGate();
  expect(await screen.findByTestId('app-shell')).toBeTruthy();
  expect(screen.queryByText('激活 DramaClip')).toBeNull();
});

it('兑换成功后门禁消失并进入应用', async () => {
  api.status.mockResolvedValue(INACTIVE);
  api.redeem.mockResolvedValue({ ok: true, snapshot: ACTIVE });
  renderGate();
  const input = await screen.findByPlaceholderText('输入激活码（8–128 个字符）');
  fireEvent.change(input, { target: { value: 'DC-AAAA-BBBB-CCCC-DDDD' } });
  fireEvent.click(screen.getByRole('button', { name: /激\s*活/ }));
  expect(await screen.findByTestId('app-shell')).toBeTruthy();
  expect(api.redeem).toHaveBeenCalledWith('DC-AAAA-BBBB-CCCC-DDDD');
});

it('兑换失败留在门禁并显示错误', async () => {
  api.status.mockResolvedValue(INACTIVE);
  api.redeem.mockResolvedValue({ ok: false, message: '激活码无效或已过期', snapshot: INACTIVE });
  renderGate();
  fireEvent.change(await screen.findByPlaceholderText('输入激活码（8–128 个字符）'), {
    target: { value: 'bad-code' },
  });
  fireEvent.click(screen.getByRole('button', { name: /激\s*活/ }));
  expect(await screen.findByText('激活码无效或已过期')).toBeTruthy();
  await waitFor(() => {
    expect(screen.queryByTestId('app-shell')).toBeNull();
  });
});

it('暂停态不阻断（断网时仍可用本地能力）', async () => {
  api.status.mockResolvedValue({ ...ACTIVE, status: 'suspended', reason: 'network' });
  renderGate();
  expect(await screen.findByTestId('app-shell')).toBeTruthy();
  expect(screen.queryByText('激活 DramaClip')).toBeNull();
});
