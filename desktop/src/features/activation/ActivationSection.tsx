/** 偏好设置 → 激活：未激活可兑换；托管态展示套餐/到期/脱敏码/网关与解绑。 */
import { Alert, Button, Popconfirm } from 'antd';
import { PageSection } from '../../components/layout/PageKit';
import { tokens } from '../../styles/theme';
import {
  ActivationCodeEntry,
  ActivationInfoRow,
  ActivationReasonAlert,
  ActivationStatusTag,
} from './ActivationBits';
import { formatTime, MANAGED_HINT, planLabel } from './activationView';
import { useActivation } from './useActivation';

/** 激活区块：状态、码输入、托管信息与解绑都在这里，不散落到设置表单。 */
export function ActivationSection(): React.ReactElement {
  const view = useActivation();
  const snapshot = view.snapshot;
  const status = snapshot?.status ?? 'inactive';
  const hint = {
    fontSize: tokens.text.meta.size,
    lineHeight: tokens.text.meta.leading,
    color: tokens.textSecondary,
    maxWidth: 860,
  };
  return (
    <PageSection
      title="激活"
      extra={snapshot === null ? undefined : <ActivationStatusTag status={snapshot.status} />}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spaceMd }}>
        <div style={hint}>{MANAGED_HINT}</div>
        {snapshot === null && <div style={hint}>正在读取激活状态…</div>}
        {snapshot !== null && status === 'verifying' && (
          <Alert type="info" showIcon title="正在向激活网关校验…" />
        )}
        {snapshot !== null && <ActivationReasonAlert snapshot={snapshot} />}
        {snapshot !== null && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spaceSm }}>
            {status !== 'inactive' && (
              <ActivationInfoRow label="套餐" value={planLabel(snapshot.plan)} />
            )}
            {status !== 'inactive' && (
              <ActivationInfoRow label="到期" value={formatTime(snapshot.expiresAt)} />
            )}
            {status !== 'inactive' && (
              <ActivationInfoRow label="最近校验" value={formatTime(snapshot.lastVerifiedAt)} />
            )}
            {status !== 'inactive' && (
              <ActivationInfoRow
                label="激活码"
                value={snapshot.maskedCode === '' ? '—' : snapshot.maskedCode}
              />
            )}
            <ActivationInfoRow
              label="网关地址"
              value={
                snapshot.gatewayUrl === ''
                  ? '未配置（DRAMACLIP_GATEWAY_URL / gateway.json）'
                  : snapshot.gatewayUrl
              }
            />
          </div>
        )}
        {snapshot !== null && status !== 'active' && (
          <ActivationCodeEntry busy={view.busy} onRedeem={view.redeem} />
        )}
        {snapshot !== null && status !== 'inactive' && (
          <div style={{ display: 'flex', gap: tokens.spaceSm }}>
            <Button
              loading={view.busy}
              onClick={() => {
                void view.recheck();
              }}
            >
              重新校验
            </Button>
            <Popconfirm
              title="解绑后需重新激活才能使用网关模型；本地功能不受影响。"
              okText="确认解绑"
              cancelText="取消"
              onConfirm={() => {
                void view.unbind();
              }}
            >
              <Button danger>解绑</Button>
            </Popconfirm>
          </div>
        )}
        {view.error !== '' && (
          <Alert
            type="error"
            showIcon
            title={view.error}
            closable={{ onClose: view.clearError }}
          />
        )}
      </div>
    </PageSection>
  );
}
