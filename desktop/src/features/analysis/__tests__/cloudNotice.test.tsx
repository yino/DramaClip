// @vitest-environment jsdom
/**
 * 首次云端识别告知（spec desktop-cloud-asr §106-120）：
 * 说明音频去阿里云临时存储 48 小时、网关不保存；无复选框、不阻塞；
 * 每台设备只提醒一次；没有本地引擎时只给「去引擎中心准备本地」。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelInfo } from '@dramaclip/protocol';
import {
  CLOUD_NOTICE_KEY,
  CLOUD_NOTICE_TEXT,
  CloudNotice,
  acknowledgeCloudNotice,
  cloudNoticeAcknowledged,
  pickLocalAsrModel,
  shouldShowCloudNotice,
  useCloudNoticeGate,
} from '../CloudNotice';
import { model } from '../../engines/__tests__/fixtures';

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn<() => Promise<Record<string, string>>>(),
  updateSettings: vi.fn<(values: Record<string, string>) => Promise<{ ok: boolean }>>(),
  listModels: vi.fn<() => Promise<ModelInfo[]>>(),
}));

vi.mock('../../../services/client', () => ({
  settingsApi: {
    get: () => mocks.getSettings(),
    update: (values: Record<string, string>) => mocks.updateSettings(values),
  },
  modelsApi: { list: () => mocks.listModels() },
}));

const noop = (): void => {
  // 组件只验出口回调
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
  window.localStorage.clear();
  mocks.getSettings.mockReset();
  mocks.updateSettings.mockReset();
  mocks.listModels.mockReset();
  mocks.getSettings.mockResolvedValue({ 'asr.engine': 'cloud_gateway' });
  mocks.listModels.mockResolvedValue([]);
});

afterEach(cleanup);

function localAsr(over: Partial<ModelInfo> = {}): ModelInfo {
  return model({
    model_id: 'faster-whisper-small',
    kind: 'asr',
    engine: 'faster_whisper',
    name: 'Whisper Small',
    status: 'installed',
    engine_ready: true,
    ...over,
  });
}

describe('告知判据（纯函数）', () => {
  it('只在生效引擎是激活网关托管且未告知时返回 true', () => {
    expect(shouldShowCloudNotice({ 'asr.engine': 'cloud_gateway' })).toBe(true);
    expect(shouldShowCloudNotice({ 'asr.engine': 'faster_whisper' })).toBe(false);
    acknowledgeCloudNotice();
    expect(cloudNoticeAcknowledged()).toBe(true);
    expect(shouldShowCloudNotice({ 'asr.engine': 'cloud_gateway' })).toBe(false);
  });

  it('本地可切模型只认本机已接入且已安装的 ASR；云端与储备项不算', () => {
    const reserve = localAsr({ model_id: 'reserve', engine_ready: false });
    const cloud = localAsr({ model_id: 'cloud', kind: 'asr', engine: 'cloud_gateway', cloud: true });
    expect(pickLocalAsrModel([reserve, cloud])).toBeUndefined();
    expect(pickLocalAsrModel([reserve, cloud, localAsr()])?.model_id).toBe('faster-whisper-small');
    const ready = localAsr();
    expect(pickLocalAsrModel([reserve, cloud, ready])?.model_id).toBe('faster-whisper-small');
  });
});

describe('告知弹窗', () => {
  it('说清音频去向与 48 小时清理，无复选框；有本地引擎时两个出口都在', () => {
    const onContinue = vi.fn();
    const onUseLocal = vi.fn();
    const onOpenEngines = vi.fn();
    render(
      <CloudNotice
        open
        localModel={localAsr()}
        onContinue={onContinue}
        onUseLocal={onUseLocal}
        onOpenEngines={onOpenEngines}
      />
    );
    expect(screen.getByText(CLOUD_NOTICE_TEXT)).toBeTruthy();
    expect(screen.getByText(/48 小时临时存储/)).toBeTruthy();
    expect(screen.getByText(/网关不保存音频/)).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '继续使用云端' }));
    expect(onContinue).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '改用本地引擎' }));
    expect(onUseLocal).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: '去引擎中心准备本地' })).toBeNull();
  });

  it('本机没有可切换的本地引擎时，只给「去引擎中心准备本地」', () => {
    const onOpenEngines = vi.fn();
    render(
      <CloudNotice open localModel={undefined} onContinue={noop} onUseLocal={noop} onOpenEngines={onOpenEngines} />
    );
    expect(screen.queryByRole('button', { name: '改用本地引擎' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '去引擎中心准备本地' }));
    expect(onOpenEngines).toHaveBeenCalledTimes(1);
  });
});

/** 把 hook 的 element 挂上，才能验证「拦下 / 放行」的真实落点。 */
function Harness({
  onStart,
  navigate,
}: {
  onStart: () => void;
  navigate: (path: string) => void;
}): React.ReactElement {
  const gate = useCloudNoticeGate({ navigate, onError: noop });
  return (
    <>
      <button
        type="button"
        onClick={() => {
          void gate.guard(onStart);
        }}
      >
        开始分析
      </button>
      {gate.element}
    </>
  );
}

describe('开始分析前的告知门', () => {
  it('未告知且是托管云端：先弹告知，用户继续后才真正开始', async () => {
    const start = vi.fn();
    render(<Harness onStart={start} navigate={noop} />);
    fireEvent.click(screen.getByRole('button', { name: '开始分析' }));

    await waitFor(() => {
      expect(screen.getByText(CLOUD_NOTICE_TEXT)).toBeTruthy();
    });
    expect(start).not.toHaveBeenCalled();
    expect(cloudNoticeAcknowledged()).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: '继续使用云端' }));
    await waitFor(() => {
      expect(start).toHaveBeenCalledTimes(1);
    });
    expect(cloudNoticeAcknowledged()).toBe(true);
    expect(window.localStorage.getItem(CLOUD_NOTICE_KEY)).toBe('1');
  });

  it('已告知过：直接开始，不再读设置也不再弹窗', async () => {
    acknowledgeCloudNotice();
    const start = vi.fn();
    render(<Harness onStart={start} navigate={noop} />);
    fireEvent.click(screen.getByRole('button', { name: '开始分析' }));
    await waitFor(() => {
      expect(start).toHaveBeenCalledTimes(1);
    });
    expect(mocks.getSettings).not.toHaveBeenCalled();
    expect(screen.queryByText(CLOUD_NOTICE_TEXT)).toBeNull();
  });

  it('本地引擎：不弹告知直接开始（本地转写不上传音频）', async () => {
    mocks.getSettings.mockResolvedValue({ 'asr.engine': 'faster_whisper' });
    const start = vi.fn();
    render(<Harness onStart={start} navigate={noop} />);
    fireEvent.click(screen.getByRole('button', { name: '开始分析' }));
    await waitFor(() => {
      expect(start).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByText(CLOUD_NOTICE_TEXT)).toBeNull();
  });

  it('改用本地：写本地引擎设置后开始，并把告知记为已读', async () => {
    mocks.listModels.mockResolvedValue([localAsr()]);
    mocks.updateSettings.mockResolvedValue({ ok: true });
    const start = vi.fn();
    render(<Harness onStart={start} navigate={noop} />);
    fireEvent.click(screen.getByRole('button', { name: '开始分析' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '改用本地引擎' })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: '改用本地引擎' }));
    await waitFor(() => {
      expect(start).toHaveBeenCalledTimes(1);
    });
    expect(mocks.updateSettings).toHaveBeenCalledWith({
      'asr.engine': 'faster_whisper',
      'asr.model': 'small',
    });
    expect(cloudNoticeAcknowledged()).toBe(true);
  });

  it('没有本地引擎时点「去引擎中心准备本地」：跳 ASR 引擎页，不开始分析', async () => {
    const start = vi.fn();
    const navigate = vi.fn();
    render(<Harness onStart={start} navigate={navigate} />);
    fireEvent.click(screen.getByRole('button', { name: '开始分析' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '去引擎中心准备本地' })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: '去引擎中心准备本地' }));
    expect(navigate).toHaveBeenCalledWith('/engines/asr');
    expect(start).not.toHaveBeenCalled();
  });

  it('读设置失败：不用弹窗挡路，直接放行（配置问题由分析自己报）', async () => {
    mocks.getSettings.mockRejectedValue(new Error('rpc down'));
    const start = vi.fn();
    render(<Harness onStart={start} navigate={noop} />);
    fireEvent.click(screen.getByRole('button', { name: '开始分析' }));
    await waitFor(() => {
      expect(start).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByText(CLOUD_NOTICE_TEXT)).toBeNull();
  });
});
