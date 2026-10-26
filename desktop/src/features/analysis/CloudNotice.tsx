/**
 * 首次云端识别告知（spec desktop-cloud-asr §106-120）：
 * 每台设备只提醒一次，不在分析按钮前加复选框，也不阻塞本地转写。
 * 判据只认设置里的生效引擎；读不到设置时不拦分析——分析自身会把云端配置问题报出来。
 */
import { Button, Modal } from 'antd';
import { useCallback, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { ModelInfo } from '@dramaclip/protocol';
import * as clientBridge from '../../services/client';
import { activateSettings } from '../engines/assetState';
import { tokens } from '../../styles/theme';

// 旧壳/单测可能只 mock 了部分客户端：用 `in` 判存在再取值，缺导出时按「未接线」降级而不是抛错。
function settingsBridge(): typeof clientBridge.settingsApi | undefined {
  return 'settingsApi' in clientBridge ? clientBridge.settingsApi : undefined;
}

function modelsBridge(): typeof clientBridge.modelsApi | undefined {
  return 'modelsApi' in clientBridge ? clientBridge.modelsApi : undefined;
}

export const CLOUD_NOTICE_KEY = 'dramaclip.cloud-asr-notice-ack';

/** 阿里云临时存储的告知原文：48 小时由服务端生命周期规则清理，网关不落音频。 */
export const CLOUD_NOTICE_TEXT =
  '音频会上传到阿里云 48 小时临时存储供识别读取，48 小时后清理，网关不保存音频。';

export function cloudNoticeAcknowledged(): boolean {
  try {
    return window.localStorage.getItem(CLOUD_NOTICE_KEY) === '1';
  } catch {
    // 无痕模式读不了存储：按未告知处理，每次进分析前再提醒，不静默跳过。
    return false;
  }
}

export function acknowledgeCloudNotice(): void {
  try {
    window.localStorage.setItem(CLOUD_NOTICE_KEY, '1');
  } catch {
    // 写不了就保持未告知；下次继续提醒，比假装记住了更诚实。
  }
}

/** 只有「生效引擎 = 激活网关托管」才需要这条告知；本地引擎不弹。 */
export function shouldShowCloudNotice(settings: Readonly<Record<string, string>>): boolean {
  if (settings['asr.engine'] !== 'cloud_gateway') return false;
  return !cloudNoticeAcknowledged();
}

/** 本地可切换的识别模型：已接入引擎且已安装；优先完全就绪的那条。 */
export function pickLocalAsrModel(models: readonly ModelInfo[]): ModelInfo | undefined {
  const locals = models.filter(
    (model) => model.kind === 'asr' && model.cloud !== true && model.engine !== 'cloud_gateway',
  );
  return (
    locals.find((model) => model.engine_ready && model.status === 'installed') ??
    locals.find((model) => model.engine_ready)
  );
}

export interface CloudNoticeProps {
  open: boolean;
  localModel: ModelInfo | undefined;
  busy?: boolean;
  onContinue: () => void;
  onUseLocal: () => void;
  onOpenEngines: () => void;
}

/** 告知弹窗本体：无复选框、不可点遮罩关闭，两个出口都算已读。 */
export function CloudNotice({
  open,
  localModel,
  busy = false,
  onContinue,
  onUseLocal,
  onOpenEngines,
}: CloudNoticeProps): ReactElement {
  return (
    <Modal
      open={open}
      title="首次使用云端识别"
      closable={false}
      mask={{ closable: false }}
      keyboard={false}
      footer={[
        localModel === undefined ? (
          <Button key="engines" disabled={busy} onClick={onOpenEngines}>
            去引擎中心准备本地
          </Button>
        ) : (
          <Button key="local" loading={busy} onClick={onUseLocal}>
            改用本地引擎
          </Button>
        ),
        <Button key="continue" type="primary" disabled={busy} onClick={onContinue}>
          继续使用云端
        </Button>,
      ]}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spaceMd }}>
        <div>{CLOUD_NOTICE_TEXT}</div>
        <div style={{ fontSize: tokens.text.meta.size, color: tokens.textSecondary }}>
          本地转写不会上传音频；随时可以在「引擎中心 → ASR」切回本地，切换不消耗积分。
        </div>
      </div>
    </Modal>
  );
}

interface CloudNoticeGateOptions {
  readonly navigate: (path: string) => void;
  readonly onError: (text: string) => void;
}

export interface CloudNoticeGate {
  /** 需要告知时拦下并以弹窗承接；已告知或非云端引擎则立即 start。 */
  readonly guard: (start: () => void) => Promise<void>;
  readonly element: ReactElement;
}

/** 工作台接线：点「开始分析」前过一个一次性的告知门，本地引擎直接放行。 */
export function useCloudNoticeGate({ navigate, onError }: CloudNoticeGateOptions): CloudNoticeGate {
  const [open, setOpen] = useState(false);
  const [localModel, setLocalModel] = useState<ModelInfo | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const pending = useRef<(() => void) | null>(null);
  const navigateRef = useRef(navigate);
  const onErrorRef = useRef(onError);
  navigateRef.current = navigate;
  onErrorRef.current = onError;

  const guard = useCallback(async (start: () => void): Promise<void> => {
    if (cloudNoticeAcknowledged()) {
      start();
      return;
    }
    const getSettings = settingsBridge()?.get;
    if (typeof getSettings !== 'function') {
      start();
      return;
    }
    let settings: Record<string, string> | null;
    try {
      settings = await getSettings();
    } catch {
      settings = null;
    }
    if (settings === null || !shouldShowCloudNotice(settings)) {
      // 读不到设置（或引擎不是托管云端）就先放行：分析自己会报配置错误，别用弹窗挡路。
      start();
      return;
    }
    let models: ModelInfo[] = [];
    const listModels = modelsBridge()?.list;
    if (typeof listModels === 'function') {
      try {
        models = await listModels();
      } catch {
        models = [];
      }
    }
    pending.current = start;
    setLocalModel(pickLocalAsrModel(models));
    setOpen(true);
  }, []);

  const onContinue = useCallback((): void => {
    acknowledgeCloudNotice();
    setOpen(false);
    const start = pending.current;
    pending.current = null;
    start?.();
  }, []);

  const onUseLocal = useCallback((): void => {
    const model = localModel;
    if (model === undefined) {
      setOpen(false);
      navigateRef.current('/engines/asr');
      return;
    }
    const update = settingsBridge()?.update;
    if (typeof update !== 'function') {
      onErrorRef.current('设置服务未接线：请重启应用后再试');
      return;
    }
    setBusy(true);
    update(activateSettings(model))
      .then(() => {
        acknowledgeCloudNotice();
        setOpen(false);
        const start = pending.current;
        pending.current = null;
        start?.();
      })
      .catch((error: unknown) => {
        onErrorRef.current(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setBusy(false);
      });
  }, [localModel]);

  const onOpenEngines = useCallback((): void => {
    setOpen(false);
    navigateRef.current('/engines/asr');
  }, []);

  return {
    guard,
    element: (
      <CloudNotice
        open={open}
        localModel={localModel}
        busy={busy}
        onContinue={onContinue}
        onUseLocal={onUseLocal}
        onOpenEngines={onOpenEngines}
      />
    ),
  };
}
