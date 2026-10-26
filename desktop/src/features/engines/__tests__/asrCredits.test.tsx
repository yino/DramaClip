// @vitest-environment jsdom
/**
 * 托管识别积分（spec desktop-cloud-asr §59-71）：
 * 余额只从 sidecar 的 asr.credits 读，渲染层不接触设备令牌；
 * 拿不到余额时给可读原因而不是错误堆栈；进页面、激活状态变化、识别完成都会刷新。
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivationSnapshot, ActivationStatus, AsrCredits } from '@dramaclip/protocol';
import { AsrTab } from '../AsrTab';
import type { ManagedAsrActivation } from '../CloudDomainUI';
import { specsFromHealth } from '../machineFit';
import { reportsOf } from './fixtures';

interface CapturedEvent {
  type: string;
  method: string;
  params: Record<string, unknown>;
}

const mocks = vi.hoisted(() => ({
  credits: vi.fn<() => Promise<AsrCredits>>(),
  listeners: [] as ((event: CapturedEvent) => void)[],
}));

vi.mock('../../../services/client', () => ({
  engineConfigsApi: {
    list: vi.fn(() => Promise.resolve({ configs: [] })),
    create: vi.fn(() => Promise.resolve({})),
    update: vi.fn(() => Promise.resolve({})),
    remove: vi.fn(() => Promise.resolve({ ok: true })),
    enable: vi.fn(() => Promise.resolve({})),
    enableLocal: vi.fn(() => Promise.resolve({ ok: true })),
    test: vi.fn(() => Promise.resolve({ ok: true, latency_s: 0.1, error: null })),
  },
  modelsApi: {
    list: vi.fn(() => Promise.resolve([])),
    verify: vi.fn(() => Promise.resolve([])),
    remove: vi.fn(() => Promise.resolve({})),
    download: vi.fn(() => Promise.resolve({})),
    cleanResidue: vi.fn(() => Promise.resolve({ removed: 0, freed_bytes: 0 })),
    orphanList: vi.fn(() => Promise.resolve([])),
    cleanOrphan: vi.fn(() => Promise.resolve({ ok: true, removed: '', freed_bytes: 0 })),
    relayout: vi.fn(() => Promise.resolve({ path: '', migrated: false })),
  },
  localRuntimeApi: {
    status: vi.fn(() =>
      Promise.resolve({
        installed: true,
        dir: '',
        torch_variant: 'cuda',
        groups: { indextts: true, funasr: true, kokoro: true, torch: true },
      }),
    ),
    install: vi.fn(() => Promise.resolve({ job_id: 'j-local' })),
  },
  enginesApi: {
    selftest: vi.fn(() => Promise.resolve({ ok: true })),
    selftestResults: vi.fn(() => Promise.resolve({})),
  },
  ttsApi: { preview: vi.fn(() => Promise.resolve({})) },
  mediaUrl: (path: string) => `dramaclip://local/${path}`,
  systemApi: { health: vi.fn(() => Promise.resolve({})) },
  runtimeApi: { status: vi.fn(() => Promise.resolve({ installed: true })), install: vi.fn(() => Promise.resolve({})) },
  revealInFolder: vi.fn(() => Promise.resolve({})),
  asrApi: { credits: () => mocks.credits() },
  onServiceEvent: (callback: (event: CapturedEvent) => void) => {
    mocks.listeners.push(callback);
    return (): void => undefined;
  },
}));

const readyCredits: AsrCredits = {
  available: true,
  limit: 100,
  used: 12.5,
  remaining: 87.5,
  unit: 'minute',
  updated_at: '2026-10-22T12:00:00Z',
};

const noop = (): void => {
  // 只验读态，不验写回
};

function snapshot(status: ActivationStatus, over: Partial<ActivationSnapshot> = {}): ActivationSnapshot {
  return {
    status,
    plan: 'pro',
    expiresAt: '2027-01-01T00:00:00Z',
    lastVerifiedAt: '2026-10-23T00:00:00Z',
    maskedCode: '****1234',
    gatewayUrl: 'https://gateway.example/v1',
    ...over,
  };
}

function activation(snap: ActivationSnapshot): ManagedAsrActivation {
  return { snapshot: snap, available: true, busy: false, error: '', recheck: noop };
}

function asr(snap: ActivationSnapshot): React.ReactElement {
  return (
    <AsrTab
      models={[]}
      imported={[]}
      importError=""
      settings={{
        'asr.engine': 'cloud_gateway',
        'asr.model': 'fun-asr-flash',
        'asr.device': 'auto',
        'asr.language': 'zh',
        'asr.diarization': 'auto',
      }}
      reports={reportsOf()}
      selftests={{}}
      machine={specsFromHealth(null)}
      onSave={noop}
      onChanged={noop}
      onVerify={noop}
      onForget={noop}
      onImport={noop}
      activation={activation(snap)}
    />
  );
}

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
      // 浮层定位由真浏览器负责
    }

    unobserve(): void {
      // 同上
    }

    disconnect(): void {
      // 同上
    }
  }
  globalThis.ResizeObserver = NoResizeObserver;
});

beforeEach(() => {
  mocks.credits.mockReset().mockResolvedValue(readyCredits);
  mocks.listeners.length = 0;
});

afterEach(cleanup);

describe('积分余额读取', () => {
  it('成功：两位小数展示总额 / 已用 / 剩余，并说明 1 积分 = 1 分钟', async () => {
    render(asr(snapshot('active')));
    await waitFor(() => {
      expect(screen.getByText('100.00 分钟')).toBeTruthy();
    });
    expect(screen.getByText('12.50 分钟')).toBeTruthy();
    expect(screen.getByText('87.50 分钟')).toBeTruthy();
    expect(screen.getByText(/1 积分 = 1 分钟音频/)).toBeTruthy();
  });

  it('未配置/令牌失效：只给可读原因，不冒充 0 分钟余额', async () => {
    mocks.credits.mockResolvedValue({
      available: false,
      limit: 0,
      used: 0,
      remaining: 0,
      unit: 'minute',
      updated_at: '',
      reason: '云端识别未配置：请先在激活页完成激活，或切换到本地引擎',
    } satisfies AsrCredits);
    render(asr(snapshot('active')));
    await waitFor(() => {
      expect(screen.getByText(/积分暂不可用：云端识别未配置/)).toBeTruthy();
    });
    expect(screen.queryByText('0.00 分钟')).toBeNull();
  });

  it('RPC 失败（sidecar 异常）：显示可读原因，不抛错误堆栈', async () => {
    mocks.credits.mockRejectedValue(new Error('服务暂时不可达'));
    render(asr(snapshot('active')));
    await waitFor(() => {
      expect(screen.getByText(/积分暂不可用：服务暂时不可达/)).toBeTruthy();
    });
  });

  it('未激活 / 校验中不请求余额', async () => {
    render(asr(snapshot('inactive')));
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.credits).not.toHaveBeenCalled();
    cleanup();

    render(asr(snapshot('verifying')));
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.credits).not.toHaveBeenCalled();
  });
});

describe('刷新时机', () => {
  it('激活状态刷新（lastVerifiedAt 变化）会重新读余额', async () => {
    const view = render(asr(snapshot('active')));
    await waitFor(() => {
      expect(mocks.credits).toHaveBeenCalledTimes(1);
    });
    view.rerender(asr(snapshot('active', { lastVerifiedAt: '2026-10-23T01:00:00Z' })));
    await waitFor(() => {
      expect(mocks.credits).toHaveBeenCalledTimes(2);
    });
  });

  it('识别完成（progress.update 100%）会重新读余额；中途进度不读', async () => {
    render(asr(snapshot('active')));
    await waitFor(() => {
      expect(mocks.credits).toHaveBeenCalledTimes(1);
    });
    expect(mocks.listeners.length).toBeGreaterThan(0);
    act(() => {
      for (const listener of mocks.listeners) {
        listener({ type: 'notification', method: 'progress.update', params: { percent: 40 } });
      }
    });
    expect(mocks.credits).toHaveBeenCalledTimes(1);
    act(() => {
      for (const listener of mocks.listeners) {
        listener({ type: 'notification', method: 'progress.update', params: { percent: 100 } });
      }
    });
    await waitFor(() => {
      expect(mocks.credits).toHaveBeenCalledTimes(2);
    });
  });
});
