// @vitest-environment jsdom
/**
 * 托管激活态 ASR 引擎页（spec desktop-cloud-asr §120-135）：
 * - 地址 / 密钥 / 自由模型输入在所有状态下都不挂载，只暴露两个网关别名；
 * - 本地引擎始终可启停，暂停态也保留本地入口；
 * - 激活不可用（未接线）时保留旧配置路径，不把已有部署卡死。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivationSnapshot, ActivationStatus, AsrCredits } from '@dramaclip/protocol';
import { AsrTab } from '../AsrTab';
import type { ManagedAsrActivation } from '../CloudDomainUI';
import { specsFromHealth } from '../machineFit';
import { report, reportsOf } from './fixtures';

const mocks = vi.hoisted(() => ({
  credits: vi.fn<() => Promise<AsrCredits>>(),
  recheck: vi.fn<() => void>(),
  save: vi.fn<(values: Record<string, string>) => void>(),
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
  onServiceEvent: () => (): void => undefined,
}));

const readyCredits: AsrCredits = {
  available: true,
  limit: 600,
  used: 30,
  remaining: 570,
  unit: 'minute',
  updated_at: '2026-10-22T12:00:00Z',
};

const noop = (): void => {
  // 渲染测试只验状态与写回入参
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

function managed(snap: ActivationSnapshot): ManagedAsrActivation {
  return { snapshot: snap, available: true, busy: false, error: '', recheck: mocks.recheck };
}

function renderAsr(
  snap: ActivationSnapshot,
  settings: Record<string, string> = {},
  overrides: { readonly activation?: ManagedAsrActivation; readonly models?: [] } = {},
): void {
  render(
    <AsrTab
      models={overrides.models ?? []}
      imported={[]}
      importError=""
      settings={{
        'asr.engine': 'cloud_gateway',
        'asr.model': 'fun-asr-flash',
        'asr.device': 'auto',
        'asr.language': 'zh',
        'asr.diarization': 'auto',
        ...settings,
      }}
      reports={reportsOf()}
      selftests={{}}
      machine={specsFromHealth(null)}
      onSave={mocks.save}
      onChanged={noop}
      onVerify={noop}
      onForget={noop}
      onImport={noop}
      activation={overrides.activation ?? managed(snap)}
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
  mocks.save.mockReset();
  mocks.recheck.mockReset();
});

afterEach(cleanup);

describe('托管激活态：只读账号提供的云端识别', () => {
  it('激活态不挂载地址、密钥与自由模型输入，只留别名和积分', async () => {
    renderAsr(snapshot('active'));

    expect(screen.getByText('云端识别（账号托管）')).toBeTruthy();
    expect(screen.getByText(/云端识别由账号提供/)).toBeTruthy();
    expect(screen.getByText('识别模型')).toBeTruthy();
    expect(screen.getByText('识别积分')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText('600.00 分钟')).toBeTruthy();
    });
    expect(screen.getByText('30.00 分钟')).toBeTruthy();
    expect(screen.getByText('570.00 分钟')).toBeTruthy();
    expect(screen.getByText(/1 积分 = 1 分钟音频/)).toBeTruthy();

    // 老云端配置路径必须完全消失：没有入口、没有地址、没有密钥、没有自由模型名。
    expect(screen.queryByText('添加配置')).toBeNull();
    expect(screen.queryByText('云端配置')).toBeNull();
    expect(screen.queryByText('接口地址')).toBeNull();
    expect(screen.queryByText('密钥')).toBeNull();
    expect(screen.queryByText('测连接')).toBeNull();
  });

  it('本地引擎始终可启停：资产库与切回本地的说明都在', () => {
    renderAsr(snapshot('active'));
    expect(screen.getByText('资产库')).toBeTruthy();
    expect(screen.getByText('本地引擎')).toBeTruthy();
    expect(screen.getByText(/切回本地不消耗积分/)).toBeTruthy();
    expect(screen.getByText(/本地转写、字幕、剪辑与导出不受影响/)).toBeTruthy();
  });

  it('别名选择只写 asr.model，不写地址或密钥', async () => {
    renderAsr(snapshot('active'));
    fireEvent.mouseDown(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByText('qwen-audio-3.1-asr-flash（含说话人分离）'));

    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.save).toHaveBeenCalledWith({ 'asr.model': 'qwen-audio-3.1-asr-flash' });
  });

  it('qwen 别名写明支持说话人分离，fun 别名写明角色留空', () => {
    const { unmount } = render(
      <AsrTab
        models={[]}
        imported={[]}
        importError=""
        settings={{
          'asr.engine': 'cloud_gateway',
          'asr.model': 'qwen-audio-3.1-asr-flash',
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
        activation={managed(snapshot('active'))}
      />
    );
    expect(screen.getByText(/当前别名支持说话人分离/)).toBeTruthy();
    unmount();
    renderAsr(snapshot('active'));
    expect(screen.getByText(/当前别名不做说话人分离/)).toBeTruthy();
  });

  it('暂停态：说清暂停原因与本地不受影响，别名不可改但本地入口还在', () => {
    renderAsr(snapshot('suspended', { reason: 'expired' }));

    expect(screen.getAllByText(/已暂停/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/本地转写、字幕、剪辑与导出不受影响/).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: '重新校验' })).toBeTruthy();
    expect(screen.getByRole('combobox').hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('资产库')).toBeTruthy();
    expect(screen.getByText('识别积分')).toBeTruthy();
  });

  it('未激活：只给激活说明，别名与积分都不出现，本地入口还在', () => {
    renderAsr(snapshot('inactive'));
    expect(screen.getByText('云端识别未激活')).toBeTruthy();
    expect(screen.getByText(/本地引擎仍可正常启停/)).toBeTruthy();
    expect(screen.queryByText('识别模型')).toBeNull();
    expect(screen.queryByText('识别积分')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByText('资产库')).toBeTruthy();
  });

  it('校验中：只显示正在读取，不提前暴露任何配置项', () => {
    renderAsr(snapshot('verifying'));
    expect(screen.getByText('正在校验激活状态…')).toBeTruthy();
    expect(screen.queryByText('识别模型')).toBeNull();
    expect(screen.queryByText('识别积分')).toBeNull();
  });

  it('激活桥未接线（旧测试/旧部署）时回落到旧云端配置路径', () => {
    renderAsr(snapshot('active'), {}, {
      activation: { snapshot: null, available: false, busy: false, error: '', recheck: noop },
    });
    expect(screen.getByText('本地模型')).toBeTruthy();
    expect(screen.getByText('云端配置')).toBeTruthy();
    expect(screen.queryByText('云端识别（账号托管）')).toBeNull();
  });
});

describe('本地模型在托管态仍可切回', () => {
  it('资产库行内的「选为生效」写本地引擎设置，不写云端别名', () => {
    renderAsr(snapshot('active'), {}, {
      models: [],
    });
    // 没有本地资产时不伪造入口：只保留资产库与「去准备」说明。
    expect(screen.getByText('资产库')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '选为生效' })).toBeNull();
  });

  it('本地资产就绪时，切回本地走 asr.engine 而不是 asr.model 别名', async () => {
    const local = {
      model_id: 'faster-whisper-small',
      kind: 'asr' as const,
      engine: 'faster_whisper',
      repo_id: 'Systran/faster-whisper-small',
      name: 'Whisper Small',
      required: true,
      status: 'installed',
      engine_ready: true,
    };
    render(
      <AsrTab
        models={[local]}
        imported={[]}
        importError=""
        settings={{
          'asr.engine': 'cloud_gateway',
          'asr.model': 'fun-asr-flash',
          'asr.device': 'auto',
          'asr.language': 'zh',
          'asr.diarization': 'auto',
        }}
        reports={reportsOf(report({ model_id: 'faster-whisper-small', kind: 'asr', engine: 'faster_whisper' }))}
        selftests={{}}
        machine={specsFromHealth(null)}
        onSave={mocks.save}
        onChanged={noop}
        onVerify={noop}
        onForget={noop}
        onImport={noop}
        activation={managed(snapshot('active'))}
      />
    );
    const [activateButton] = screen.getAllByRole('button', { name: '选为生效' });
    if (activateButton === undefined) throw new Error('找不到「选为生效」按钮');
    fireEvent.click(activateButton);
    await waitFor(() => {
      expect(mocks.save).toHaveBeenCalledWith({
        'asr.engine': 'faster_whisper',
        'asr.model': 'small',
      });
    });
  });
});
