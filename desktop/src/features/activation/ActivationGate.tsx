/** 首次启动或授权失效时整屏阻断：必须联网向授权网关重新兑换设备令牌。
 *  暂停（suspended）不在这里拦：已激活用户断网时仍可用本地能力，只禁用 LLM 入口。 */
import { Alert, Spin } from 'antd';
import { tokens } from '../../styles/theme';
import { ActivationCodeEntry } from './ActivationBits';
import { reactivationText } from './activationView';
import { useActivation } from './useActivation';

export function ActivationGate({ children }: { children: React.ReactNode }): React.ReactElement {
  const view = useActivation();
  const status = view.snapshot?.status ?? null;
  if (status === 'active') return <>{children}</>;
  if (status === 'suspended') return <>{children}</>;

  const loading = status === null || status === 'verifying';
  const needsReactivation = status === 'reactivation_required';
  const title = needsReactivation ? '重新激活 DramaClip' : '激活 DramaClip';
  const description = needsReactivation
    ? (view.snapshot === null ? '' : reactivationText(view.snapshot))
    : '首次启动必须完成激活。激活会联网向授权网关校验，并为本机领取设备令牌；校验不通过无法进入应用。';
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: tokens.bgLayout,
        padding: tokens.spaceXl,
      }}
    >
      <div
        style={{
          width: 'min(640px, 100%)',
          display: 'flex',
          flexDirection: 'column',
          gap: tokens.spaceLg,
          background: tokens.bgContainer,
          border: `1px solid ${tokens.border}`,
          borderRadius: tokens.radiusCard,
          boxShadow: tokens.shadowCard,
          padding: tokens.spaceXl,
        }}
      >
        <div>
          <div
            style={{
              fontSize: tokens.text.pageTitle.size,
              lineHeight: tokens.text.pageTitle.leading,
              fontWeight: tokens.text.pageTitle.weight,
              color: tokens.textPrimary,
            }}
          >
            {title}
          </div>
          <div
            style={{
              marginTop: tokens.spaceSm,
              fontSize: tokens.text.body.size,
              lineHeight: tokens.text.body.leading,
              color: tokens.textSecondary,
            }}
          >
            {description}
          </div>
        </div>

        {loading ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spaceSm,
              fontSize: tokens.text.body.size,
              lineHeight: tokens.text.body.leading,
              color: tokens.textSecondary,
            }}
          >
            <Spin size="small" />
            {status === null ? '正在检查激活状态…' : '正在向激活网关校验…'}
          </div>
        ) : (
          <ActivationCodeEntry busy={view.busy} onRedeem={view.redeem} />
        )}

        {view.error !== '' && <Alert type="error" showIcon title={view.error} />}

        <div
          style={{
            fontSize: tokens.text.meta.size,
            lineHeight: tokens.text.meta.leading,
            color: tokens.textTertiary,
          }}
        >
          {needsReactivation
            ? '重新激活会向授权网关校验新的激活码，并为当前设备领取新令牌；此前的设备令牌已失效。'
            : '激活码由管理员或服务商提供。请确认本机能访问激活网关后再试；网络不通时激活无法完成。'}
        </div>
      </div>
    </div>
  );
}
