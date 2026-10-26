// @vitest-environment node
/** 激活展示层纯函数（harden-activation-revocation 4.2）：标签、托管/阻塞判断、原因文案。 */
import { describe, expect, it } from 'vitest';
import type { ActivationSnapshot } from '@dramaclip/protocol';
import {
  REACTIVATION_TEXT,
  REASON_LABEL,
  STATUS_LABEL,
  isLlmBlocked,
  isManaged,
  reactivationText,
  suspensionText,
} from '../activationView';

function snapshot(overrides: Partial<ActivationSnapshot> = {}): ActivationSnapshot {
  return {
    status: 'active',
    plan: 'pro',
    expiresAt: '2027-01-01T00:00:00Z',
    lastVerifiedAt: '2026-10-24T07:00:00Z',
    maskedCode: '••••1234',
    gatewayUrl: 'http://gw.test',
    ...overrides,
  };
}

describe('状态标签', () => {
  it('覆盖五种状态', () => {
    expect(STATUS_LABEL).toEqual({
      inactive: '未激活',
      verifying: '校验中',
      active: '已激活',
      suspended: '已暂停',
      reactivation_required: '需要重新激活',
    });
  });

  it('每种强制重授权原因都有可读文案', () => {
    for (const reason of ['invalid_token', 'device_conflict', 'expired', 'disabled', 'token_revoked'] as const) {
      expect(REASON_LABEL[reason]).toBeTruthy();
      expect(REACTIVATION_TEXT[reason]).toBeTruthy();
    }
  });
});

describe('托管与阻塞判断', () => {
  it('null 与 inactive 不算托管', () => {
    expect(isManaged(null)).toBe(false);
    expect(isManaged(snapshot({ status: 'inactive' }))).toBe(false);
  });

  it('verifying/active/suspended/reactivation_required 都算托管', () => {
    for (const status of ['verifying', 'active', 'suspended', 'reactivation_required'] as const) {
      expect(isManaged(snapshot({ status }))).toBe(true);
    }
  });

  it('只有 suspended 与 reactivation_required 阻塞 LLM 入口', () => {
    expect(isLlmBlocked(snapshot())).toBe(false);
    expect(isLlmBlocked(snapshot({ status: 'inactive' }))).toBe(false);
    expect(isLlmBlocked(snapshot({ status: 'suspended', reason: 'network' }))).toBe(true);
    expect(
      isLlmBlocked(snapshot({ status: 'reactivation_required', reason: 'token_revoked' })),
    ).toBe(true);
  });
});

describe('原因文案', () => {
  it('suspensionText 只对 suspended 生效', () => {
    expect(suspensionText(snapshot())).toBe('');
    expect(suspensionText(snapshot({ status: 'suspended', reason: 'network' }))).toBe(
      '无法连接激活网关',
    );
    expect(
      suspensionText(snapshot({ status: 'reactivation_required', reason: 'expired' })),
    ).toBe('');
  });

  it('reactivationText 只对强制态生效，缺 reason 按凭证失效', () => {
    expect(reactivationText(snapshot())).toBe('');
    expect(
      reactivationText(snapshot({ status: 'reactivation_required', reason: 'token_revoked' })),
    ).toBe('此设备的授权已被吊销，请重新输入激活码。');
    const missingReason = { ...snapshot({ status: 'reactivation_required' }) };
    expect(reactivationText(missingReason)).toBe('授权凭证已失效，请重新输入激活码。');
  });
});
