/** 激活区块共享小件：状态标签、只读信息行、暂停原因提示。 */
import { Alert } from 'antd';
import type { ActivationSnapshot, ActivationStatus } from '@dramaclip/protocol';
import { layout, tokens } from '../../styles/theme';
import { LOCAL_UNAFFECTED, STATUS_LABEL, STATUS_TONE, suspensionText } from './activationView';

/** 四态状态标签（未激活 / 校验中 / 已激活 / 已暂停）。 */
export function ActivationStatusTag({ status }: { status: ActivationStatus }): React.ReactElement {
  const tone = STATUS_TONE[status];
  return (
    <span
      style={{
        fontSize: tokens.text.badge.size,
        lineHeight: tokens.text.badge.leading,
        color: tone.color,
        background: tone.background,
        border: `1px solid ${tokens.border}`,
        borderRadius: tokens.radiusChip,
        padding: `${tokens.spaceXs} ${tokens.spaceSm}`,
      }}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

/** 只读信息行（套餐 / 到期 / 最近校验 / 脱敏码 / 网关地址）。 */
export function ActivationInfoRow({
  label,
  value,
}: {
  label: string;
  value: string;
}): React.ReactElement {
  return (
    <div style={{ display: 'flex', gap: tokens.spaceMd, alignItems: 'baseline' }}>
      <span
        style={{
          width: layout.field.labelWidth,
          flexShrink: 0,
          fontSize: tokens.text.meta.size,
          lineHeight: tokens.text.meta.leading,
          color: tokens.textTertiary,
        }}
      >
        {label}
      </span>
      <span
        style={{
          minWidth: 0,
          wordBreak: 'break-all',
          fontSize: tokens.text.body.size,
          lineHeight: tokens.text.body.leading,
          color: tokens.textPrimary,
        }}
      >
        {value}
      </span>
    </div>
  );
}

/** 暂停原因提示；非暂停态不渲染。 */
export function ActivationReasonAlert({
  snapshot,
}: {
  snapshot: ActivationSnapshot;
}): React.ReactElement | null {
  if (snapshot.status !== 'suspended') return null;
  return (
    <Alert
      type="warning"
      showIcon
      title={`已暂停：${suspensionText(snapshot)}`}
      description={`恢复后自动继续；${LOCAL_UNAFFECTED}`}
    />
  );
}

/** 依赖 LLM 的入口被暂停时的统一提示（本地功能照常）。 */
export function LlmPausedNotice(): React.ReactElement {
  return (
    <Alert
      type="warning"
      showIcon
      title="受管模型已暂停，AI 生成暂不可用"
      description={`可在「设置 → 激活」重新校验；${LOCAL_UNAFFECTED}`}
    />
  );
}
