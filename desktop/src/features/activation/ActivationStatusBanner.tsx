/** 全局暂停提示：受管模型暂停时提示原因，并说明本地功能不受影响。 */
import { Button } from 'antd';
import { WarningOutlined } from '@ant-design/icons';
import { useState } from 'react';
import { layout, tokens } from '../../styles/theme';
import { LOCAL_UNAFFECTED, suspensionText } from './activationView';
import { useActivation } from './useActivation';

/** 挂应用壳：仅 suspended 状态出现，可关闭或就地重新校验。 */
export function ActivationStatusBanner(): React.ReactElement | null {
  const view = useActivation();
  const [dismissed, setDismissed] = useState(false);
  const snapshot = view.snapshot;
  if (snapshot?.status !== 'suspended' || dismissed) return null;
  return (
    <div
      role="status"
      style={{
        position: 'fixed',
        right: tokens.spaceXl,
        bottom: layout.statusBar.height + 12,
        zIndex: 1000,
        width: 520,
        maxWidth: 'calc(100vw - 2 * 20px)',
        display: 'flex',
        alignItems: 'flex-start',
        gap: tokens.spaceMd,
        padding: tokens.spaceMd,
        background: tokens.bgElevated,
        border: `1px solid ${tokens.border}`,
        borderRadius: tokens.radiusControl,
        boxShadow: tokens.shadowCard,
      }}
    >
      <WarningOutlined style={{ color: tokens.colorWarning, marginTop: tokens.spaceXs }} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: tokens.spaceXs }}>
        <span
          style={{
            fontSize: tokens.text.body.size,
            lineHeight: tokens.text.body.leading,
            color: tokens.textPrimary,
          }}
        >
          {`受管模型已暂停：${suspensionText(snapshot)}`}
        </span>
        <span
          style={{
            fontSize: tokens.text.meta.size,
            lineHeight: tokens.text.meta.leading,
            color: tokens.textTertiary,
          }}
        >
          {LOCAL_UNAFFECTED}
        </span>
      </div>
      <div style={{ display: 'flex', gap: tokens.spaceXs, flexShrink: 0 }}>
        <Button
          size="small"
          loading={view.busy}
          onClick={() => {
            void view.recheck();
          }}
        >
          重新校验
        </Button>
        <Button
          size="small"
          type="text"
          onClick={() => {
            setDismissed(true);
          }}
        >
          忽略
        </Button>
      </div>
    </div>
  );
}
