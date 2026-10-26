// @vitest-environment node
/** 心跳状态机单测（desktop-activation 7.4）：假时钟驱动定时器，依赖全部注入。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ActivationHeartbeat,
  BACKOFF_STEPS_MS,
  DEFAULT_HEARTBEAT_MS,
  REDEEM_CONFLICT_WINDOW_MS,
  type AuthorizationOutcome,
  type HeartbeatSnapshot,
} from './activation-heartbeat';

const OK: AuthorizationOutcome = {
  kind: 'ok',
  plan: 'pro',
  expiresAt: '2027-01-01T00:00:00Z',
};
const SUPERSEDED: AuthorizationOutcome = { kind: 'unauthorized', code: 'token_superseded' };
const INVALID: AuthorizationOutcome = { kind: 'unauthorized', code: 'invalid_token' };
const FAILURE: AuthorizationOutcome = { kind: 'failure' };
const DISABLED: AuthorizationOutcome = { kind: 'disabled' };
const EXPIRED: AuthorizationOutcome = { kind: 'expired' };

const REVOKED: AuthorizationOutcome = { kind: 'unauthorized', code: 'token_revoked' };

interface Harness {
  readonly hb: ActivationHeartbeat;
  readonly verify: ReturnType<typeof vi.fn<() => Promise<AuthorizationOutcome>>>;
  readonly redeem: ReturnType<typeof vi.fn<() => Promise<AuthorizationOutcome>>>;
  readonly canRedeem: ReturnType<typeof vi.fn<(now: number) => boolean>>;
  readonly changes: HeartbeatSnapshot[];
}

function harness(options: {
  verify?: AuthorizationOutcome | (() => Promise<AuthorizationOutcome>);
  redeem?: AuthorizationOutcome | (() => Promise<AuthorizationOutcome>);
  canRedeem?: boolean;
  heartbeatMs?: number;
  random?: () => number;
}): Harness {
  const verify = vi.fn<() => Promise<AuthorizationOutcome>>();
  if (typeof options.verify === 'function') verify.mockImplementation(options.verify);
  else verify.mockResolvedValue(options.verify ?? OK);
  const redeem = vi.fn<() => Promise<AuthorizationOutcome>>();
  if (typeof options.redeem === 'function') redeem.mockImplementation(options.redeem);
  else redeem.mockResolvedValue(options.redeem ?? OK);
  const canRedeem = vi.fn<(now: number) => boolean>().mockReturnValue(options.canRedeem ?? true);
  const changes: HeartbeatSnapshot[] = [];
  const hb = new ActivationHeartbeat({
    verify,
    redeem,
    canRedeem,
    onChange: (snapshot) => {
      changes.push(snapshot);
    },
    heartbeatMs: options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
    random: options.random ?? (() => 0),
  });
  return { hb, verify, redeem, canRedeem, changes };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('状态机：inactive → verifying → active', () => {
  it('启动立即校验，结果回来前是 verifying', async () => {
    let release: (value: AuthorizationOutcome) => void = () => {
      throw new Error('verify 尚未被调用');
    };
    const h = harness({
      verify: () =>
        new Promise<AuthorizationOutcome>((resolve) => {
          release = resolve;
        }),
    });

    h.hb.start();
    // runVerify 在首个 await 前同步切到 verifying
    expect(h.hb.getSnapshot().status).toBe('verifying');
    expect(h.verify).toHaveBeenCalledTimes(1);

    release(OK);
    await vi.advanceTimersByTimeAsync(0);

    expect(h.hb.getSnapshot()).toMatchObject({
      status: 'active',
      reason: null,
      plan: 'pro',
      expiresAt: '2027-01-01T00:00:00Z',
    });
    expect(h.changes.map((snapshot) => snapshot.status)).toEqual(['verifying', 'active']);
  });

  it('默认 5 分钟、±10% 抖动：random=0 时 0.9 倍触发', async () => {
    const h = harness({ heartbeatMs: 100_000, random: () => 0 });
    h.hb.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.verify).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(89_999);
    expect(h.verify).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.verify).toHaveBeenCalledTimes(2);

    expect(DEFAULT_HEARTBEAT_MS).toBe(300_000);
    expect(BACKOFF_STEPS_MS).toEqual([60_000, 120_000, 300_000]);
    expect(REDEEM_CONFLICT_WINDOW_MS).toBe(60_000);
  });

  it('random=1 时 1.1 倍触发（抖动上界）', async () => {
    const h = harness({ heartbeatMs: 100_000, random: () => 1 });
    h.hb.start();
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(109_999);
    expect(h.verify).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.verify).toHaveBeenCalledTimes(2);
  });
});

describe('401 分流', () => {
  it('token_superseded：直接 reactivation_required(device_conflict)，绝不重兑换', async () => {
    const h = harness({ verify: SUPERSEDED });
    h.hb.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.hb.getSnapshot()).toMatchObject({
      status: 'reactivation_required',
      reason: 'device_conflict',
    });
    expect(h.redeem).not.toHaveBeenCalled();
    expect(h.canRedeem).not.toHaveBeenCalled();
  });

  it('invalid_token：守卫允许时重兑换一次，成功保持 active 并刷新套餐', async () => {
    const verify = vi.fn<() => Promise<AuthorizationOutcome>>();
    verify.mockResolvedValueOnce(INVALID).mockResolvedValue(OK);
    const h = harness({ verify, redeem: { kind: 'ok', plan: 'team', expiresAt: '' } });
    h.hb.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.redeem).toHaveBeenCalledTimes(1);
    expect(h.hb.getSnapshot()).toMatchObject({ status: 'active', plan: 'team', reason: null });
  });

  it('invalid_token 但守卫不允许：reactivation_required(invalid_token)，不重兑换', async () => {
    const h = harness({ verify: INVALID, canRedeem: false });
    h.hb.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.hb.getSnapshot()).toMatchObject({
      status: 'reactivation_required',
      reason: 'invalid_token',
    });
    expect(h.redeem).not.toHaveBeenCalled();
  });

  it('兑换成功后 60 秒内的 401：按 device_conflict 处理（防互相顶号）', async () => {
    const verify = vi.fn<() => Promise<AuthorizationOutcome>>();
    verify.mockResolvedValueOnce(OK).mockResolvedValue(INVALID);
    const h = harness({ verify });
    h.hb.markActivated('pro', '2027-01-01T00:00:00Z');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.hb.getSnapshot().status).toBe('active');

    await vi.advanceTimersByTimeAsync(30_000);
    const snapshot = await h.hb.recheck();

    expect(snapshot).toMatchObject({ status: 'reactivation_required', reason: 'device_conflict' });
    expect(h.redeem).not.toHaveBeenCalled();
  });

  it('token_revoked：不重兑换，直接 reactivation_required(token_revoked)', async () => {
    const h = harness({ verify: REVOKED });
    h.hb.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.hb.getSnapshot()).toMatchObject({
      status: 'reactivation_required',
      reason: 'token_revoked',
    });
    expect(h.redeem).not.toHaveBeenCalled();
    expect(h.canRedeem).not.toHaveBeenCalled();
  });

  it('重兑换返回 token_superseded：reactivation_required(device_conflict)', async () => {
    const h = harness({ verify: INVALID, redeem: SUPERSEDED });
    h.hb.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.redeem).toHaveBeenCalledTimes(1);
    expect(h.hb.getSnapshot()).toMatchObject({
      status: 'reactivation_required',
      reason: 'device_conflict',
    });
  });
});

describe('失败退避与恢复', () => {
  it('连续失败按 1→2→5 分钟退避，成功后恢复 active', async () => {
    const h = harness({ verify: FAILURE });
    h.hb.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.verify).toHaveBeenCalledTimes(1);
    expect(h.hb.getSnapshot()).toMatchObject({ status: 'suspended', reason: 'network' });

    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.verify).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.verify).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(119_999);
    expect(h.verify).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.verify).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(299_999);
    expect(h.verify).toHaveBeenCalledTimes(3);
    h.verify.mockResolvedValue(OK);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.verify).toHaveBeenCalledTimes(4);

    expect(h.hb.getSnapshot()).toMatchObject({ status: 'active', reason: null, plan: 'pro' });
  });

  it('403 语义：disabled / expired 进入强制重授权，不再安排心跳', async () => {
    const disabled = harness({ verify: DISABLED });
    disabled.hb.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(disabled.hb.getSnapshot()).toMatchObject({
      status: 'reactivation_required',
      reason: 'disabled',
    });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(disabled.verify).toHaveBeenCalledTimes(1);

    const expired = harness({ verify: EXPIRED });
    expired.hb.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(expired.hb.getSnapshot()).toMatchObject({
      status: 'reactivation_required',
      reason: 'expired',
    });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(expired.verify).toHaveBeenCalledTimes(1);
  });

  it('verify 抛异常：按网络失败暂停（不崩）', async () => {
    const h = harness({
      verify: () => Promise.reject(new Error('pipe broken')),
    });
    h.hb.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.hb.getSnapshot()).toMatchObject({ status: 'suspended', reason: 'network' });
  });
});

describe('强制重授权', () => {
  it('markReactivationRequired：停表、保留原因，resume/recheck/start 都不再发请求', async () => {
    const h = harness({ verify: OK });
    h.hb.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.hb.getSnapshot().status).toBe('active');

    h.hb.markReactivationRequired('token_revoked');
    expect(h.hb.getSnapshot()).toMatchObject({
      status: 'reactivation_required',
      reason: 'token_revoked',
    });

    h.hb.resume();
    await vi.advanceTimersByTimeAsync(0);
    const snapshot = await h.hb.recheck();
    h.hb.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(snapshot.status).toBe('reactivation_required');
    expect(h.verify).toHaveBeenCalledTimes(1);
  });

  it('reactivation_required → 重新激活 markActivated 可回到 active 并恢复心跳', async () => {
    const h = harness({ verify: OK });
    h.hb.start();
    await vi.advanceTimersByTimeAsync(0);
    h.hb.markReactivationRequired('disabled');

    h.hb.markActivated('pro', '2027-01-01T00:00:00Z');
    await vi.advanceTimersByTimeAsync(0);

    expect(h.hb.getSnapshot()).toMatchObject({ status: 'active', reason: null });
    expect(h.verify).toHaveBeenCalledTimes(2);
  });
});

describe('停表', () => {
  it('解绑 markInactive：回未激活并停表，之后不再校验', async () => {
    const h = harness({});
    h.hb.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.hb.getSnapshot().status).toBe('active');

    h.hb.markInactive();
    expect(h.hb.getSnapshot().status).toBe('inactive');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.verify).toHaveBeenCalledTimes(1);
  });

  it('stop()：计时器清理，已发出的请求返回后不再改状态', async () => {
    const h = harness({});
    h.hb.start();
    await vi.advanceTimersByTimeAsync(0);

    h.hb.stop();
    const before = h.hb.getSnapshot();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.verify).toHaveBeenCalledTimes(1);
    expect(h.hb.getSnapshot()).toEqual(before);
  });
});
