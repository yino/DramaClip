/**
 * 分析失败的可读化出口（spec desktop-cloud-asr §75-99）：
 * 云端识别未就绪（RPC -32205）与积分不足（网关 402 `asr_credits_exhausted`）
 * 给同一套人话口径与「切换本地识别」入口；Python 堆栈只进日志，不进界面。
 */
import { Alert, Button } from 'antd';
import type { AsrCredits } from '@dramaclip/protocol';

/** 分析启动预检的 RPC 错误码（服务端 `_ERR_ASR_NOT_READY`）。 */
export const ASR_NOT_READY_CODE = -32205;

export const ASR_NOT_READY_TEXT = '云端识别未就绪，请重新激活或联网';
export const ASR_CREDITS_TEXT = '云端识别积分不足，请补充积分或切换本地识别';

export type AnalysisFailureKind = 'not-ready' | 'credits' | 'failed';

export interface AnalysisFailure {
  readonly kind: AnalysisFailureKind;
  readonly title: string;
  /** 补充信息（积分明细或网关原文），已裁掉堆栈；没有额外信息时为空串。 */
  readonly detail: string;
  /** 是否给「切换本地识别」入口（只有云端识别类失败需要）。 */
  readonly switchLocal: boolean;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (typeof error === 'number' || typeof error === 'boolean') return String(error);
  if (typeof error === 'object' && error !== null) {
    const message: unknown = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return '';
}

/** RPC 错误原文形如 `[-32205] 云端识别未就绪：…`（main/services/pipe-server.ts 拼装）。 */
export function rpcErrorCode(error: unknown): number | null {
  const match = /^\s*\[(-?\d+)\]/.exec(errorText(error));
  return match === null ? null : Number.parseInt(match[1] ?? '', 10);
}

/** 只留人话：Python traceback、`File "…"`、异常类行一律丢弃（spec §94 不得出现底层堆栈）。 */
export function readableText(raw: string): string {
  const kept: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('Traceback (most recent call last):')) break;
    if (/^File\s+"/.test(trimmed)) break;
    if (/^\s*raise\s/.test(line)) break;
    if (/^[\w.]*(?:Error|Exception)(?::|\b)/.test(trimmed)) break;
    kept.push(trimmed);
  }
  const text = kept.join(' ').replace(/^\s*\[-?\d+\]\s*/, '').trim();
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

/** 积分明细（1 积分 = 1 分钟，与引擎中心同口径）。 */
export function creditLine(credits: AsrCredits): string {
  const format = (value: number): string => value.toFixed(2);
  return `已用 ${format(credits.used)}/${format(credits.limit)} 分钟，剩余 ${format(credits.remaining)} 分钟`;
}

function isCreditsFailure(raw: string): boolean {
  return /积分不足|asr_credits_exhausted|HTTP\s*402/.test(raw);
}

/**
 * 把 RPC 拒绝或 `job.error` 归一成可读提示。
 * 传了积分时用网关余额覆盖明细：402 原文里可能只有 `required`，未必带全已用/上限。
 */
export function describeAnalysisFailure(
  error: unknown,
  credits?: AsrCredits | null,
): AnalysisFailure | null {
  const raw = errorText(error);
  if (raw.trim() === '') return null;
  const readable = readableText(raw);
  if (isCreditsFailure(raw)) {
    return {
      kind: 'credits',
      title: ASR_CREDITS_TEXT,
      detail: credits === null || credits === undefined ? readable : creditLine(credits),
      switchLocal: true,
    };
  }
  if (rpcErrorCode(error) === ASR_NOT_READY_CODE || raw.includes('云端识别未就绪')) {
    return { kind: 'not-ready', title: ASR_NOT_READY_TEXT, detail: '', switchLocal: true };
  }
  return {
    kind: 'failed',
    title: readable === '' ? '分析失败，请稍后重试' : readable,
    detail: '',
    switchLocal: false,
  };
}

export interface AnalysisFailureAlertProps {
  readonly failure: AnalysisFailure | null;
  readonly onSwitchLocal: () => void;
  readonly onDismiss?: () => void;
}

/** 失败横幅：只有云端识别类失败挂切换入口；不提供「重试」按钮（spec：不得自动重试到死循环）。 */
export function AnalysisFailureAlert({
  failure,
  onSwitchLocal,
  onDismiss,
}: AnalysisFailureAlertProps): React.ReactElement | null {
  if (failure === null) return null;
  return (
    <Alert
      type="error"
      showIcon
      title={failure.title}
      description={failure.detail === '' ? undefined : failure.detail}
      action={
        failure.switchLocal ? (
          <Button size="small" onClick={onSwitchLocal}>
            切换本地识别
          </Button>
        ) : undefined
      }
      closable={onDismiss === undefined ? false : { onClose: onDismiss }}
    />
  );
}
