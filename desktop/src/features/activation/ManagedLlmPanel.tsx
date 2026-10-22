/** 托管态 LLM 面板：替代手动配置，不提供 base_url / api_key / model 输入。 */
import { Alert, Button } from 'antd';
import type { ActivationSnapshot } from '@dramaclip/protocol';
import { PageSection } from '../../components/layout/PageKit';
import { tokens } from '../../styles/theme';
import { ActivationInfoRow, ActivationStatusTag } from './ActivationBits';
import {
  formatTime,
  LOCAL_UNAFFECTED,
  MANAGED_LLM_HINT,
  planLabel,
  suspensionText,
} from './activationView';

/** 已激活/校验中/已暂停时 LLM 页展示的只读托管面板。 */
export function ManagedLlmPanel({
  snapshot,
  busy,
  error,
  onRecheck,
}: {
  snapshot: ActivationSnapshot;
  busy: boolean;
  error: string;
  onRecheck: () => void;
}): React.ReactElement {
  const status = snapshot.status;
  const hint = {
    fontSize: tokens.text.meta.size,
    lineHeight: tokens.text.meta.leading,
    color: tokens.textSecondary,
    maxWidth: 860,
  };
  return (
    <PageSection
      title="云端 / 本地端点（OpenAI 兼容）"
      extra={<ActivationStatusTag status={status} />}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spaceMd }}>
        <div style={hint}>{MANAGED_LLM_HINT}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spaceSm }}>
          <ActivationInfoRow label="套餐" value={planLabel(snapshot.plan)} />
          <ActivationInfoRow label="到期" value={formatTime(snapshot.expiresAt)} />
          <ActivationInfoRow label="最近校验" value={formatTime(snapshot.lastVerifiedAt)} />
          <ActivationInfoRow label="模型" value="default（由网关路由）" />
        </div>
        {status === 'verifying' && (
          <Alert type="info" showIcon title="正在向激活网关校验…" />
        )}
        {status === 'active' && (
          <Alert type="success" showIcon title="托管配置生效中：AI 请求会发往激活网关。" />
        )}
        {status === 'suspended' && (
          <Alert
            type="warning"
            showIcon
            title={`已暂停：${suspensionText(snapshot)}`}
            description={`恢复后自动继续；${LOCAL_UNAFFECTED}`}
            action={
              <Button size="small" loading={busy} onClick={onRecheck}>
                重新校验
              </Button>
            }
          />
        )}
        {error !== '' && <Alert type="error" showIcon title={error} />}
      </div>
    </PageSection>
  );
}
