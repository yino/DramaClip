/** 激活展示层文案与格式化：渲染层只读主进程快照，不自行推断状态机。 */
import dayjs from 'dayjs';
import type {
  ActivationSnapshot,
  ActivationSuspendedReason,
  ActivationStatus,
} from '@dramaclip/protocol';
import { tokens } from '../../styles/theme';

export const STATUS_LABEL: Record<ActivationStatus, string> = {
  inactive: '未激活',
  verifying: '校验中',
  active: '已激活',
  suspended: '已暂停',
};

/** 状态色调：未激活走中性、校验中警示、激活成功、暂停错误。 */
export const STATUS_TONE: Record<ActivationStatus, { color: string; background: string }> = {
  inactive: { color: tokens.textSecondary, background: tokens.bgElevated },
  verifying: { color: tokens.colorWarning, background: tokens.warningSoft },
  active: { color: tokens.colorSuccess, background: tokens.successSoft },
  suspended: { color: tokens.colorError, background: tokens.errorSoft },
};

export const REASON_LABEL: Record<ActivationSuspendedReason, string> = {
  network: '无法连接激活网关',
  invalid_token: '设备令牌已失效',
  device_conflict: '激活码已在其他设备使用',
  expired: '授权已到期',
  disabled: '授权已被停用',
};

export const MANAGED_HINT =
  '桌面版通过激活网关使用服务端模型；激活后 LLM 的地址、密钥与模型由网关托管，无需手动填写，也不在设置里展示。';

export const MANAGED_LLM_HINT =
  '受管模式：地址、密钥与模型由激活网关统一下发，这里不再提供手动配置入口。';

export const LOCAL_UNAFFECTED = '本地转写、字幕、剪辑与导出不受影响。';

/** 网关返回的 ISO 时间 → 本地可读时间；空值/非法值显示占位符。 */
export function formatTime(value: string): string {
  if (value === '') return '—';
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format('YYYY-MM-DD HH:mm') : '—';
}

/** 套餐展示名：网关未返回套餐时按默认套餐展示。 */
export function planLabel(plan: string): string {
  return plan === '' ? '默认套餐' : plan;
}

/** 是否处于托管态（激活/校验中/暂停都算，此时 LLM 配置由主进程管理）。 */
export function isManaged(snapshot: ActivationSnapshot | null): boolean {
  return snapshot !== null && snapshot.status !== 'inactive';
}

/** 暂停态需要拦截依赖 LLM 的入口（本地功能不拦）。 */
export function isLlmBlocked(snapshot: ActivationSnapshot | null): boolean {
  return snapshot !== null && snapshot.status === 'suspended';
}

/** 暂停原因文案；非暂停态返回空串。 */
export function suspensionText(snapshot: ActivationSnapshot): string {
  if (snapshot.status !== 'suspended') return '';
  return REASON_LABEL[snapshot.reason ?? 'network'];
}
