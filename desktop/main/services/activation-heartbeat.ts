/** 激活心跳状态机（desktop-activation D13/Q9）。
 *
 * inactive → verifying → active ⇄ suspended(reason)。
 * - 默认 5 分钟一次，±10% 抖动；DRAMACLIP_HEARTBEAT_MS 由服务读取后传入；
 * - 启动 / 激活成功 / 系统恢复 / 手动重新校验都立即校验一次；
 * - 401 分流：token_superseded 直接 device_conflict（不重兑换）；其余 401 在
 *   「会话一次 + 距上次兑换 ≥10 分钟」守卫内自动重兑换一次；
 * - 其它失败（网络/超时/5xx/403/重兑换失败）→ suspended，并按 1→2→5 分钟退避重试；
 * - 校验成功恢复 active；解绑时 stop() 停表。
 *
 * 本模块只做纯状态机与定时器：网络/存储/设置写入都由注入的依赖完成，便于用假时钟单测。
 */
import type { ActivationStatus, ActivationSuspendedReason } from '@dramaclip/protocol';

export const DEFAULT_HEARTBEAT_MS = 5 * 60_000;
export const BACKOFF_STEPS_MS = [60_000, 120_000, 300_000] as const;
const JITTER_RATIO = 0.1;
/** 兑换成功后 60 秒内再收到 401：按设备冲突处理，避免「兑换→被替代」抖动循环。 */
export const REDEEM_CONFLICT_WINDOW_MS = 60_000;

/** 一次校验/兑换的归一化结果（服务把网关响应映射到这里）。 */
export type AuthorizationOutcome =
  | { readonly kind: 'ok'; readonly plan: string; readonly expiresAt: string }
  | { readonly kind: 'unauthorized'; readonly code: string }
  | { readonly kind: 'disabled' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'failure' };

/** 心跳维护的状态切片；服务再叠加脱敏码/网关地址组成对渲染层的快照。 */
export interface HeartbeatSnapshot {
  readonly status: ActivationStatus;
  readonly reason: ActivationSuspendedReason | null;
  readonly plan: string;
  readonly expiresAt: string;
  readonly lastVerifiedAt: string;
}

export interface HeartbeatDeps {
  readonly verify: () => Promise<AuthorizationOutcome>;
  /** 是否允许本次自动重兑换（会话一次 + 距上次兑换 ≥10 分钟，由服务实现）。 */
  readonly canRedeem: (now: number) => boolean;
  /** 用保存的激活码重兑换；成功后由服务负责更新凭证与托管 LLM 设置。 */
  readonly redeem: () => Promise<AuthorizationOutcome>;
  readonly onChange?: (snapshot: HeartbeatSnapshot) => void;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly heartbeatMs?: number;
}

/** 空状态：未激活。 */
export const INACTIVE_HEARTBEAT: HeartbeatSnapshot = {
  status: 'inactive',
  reason: null,
  plan: '',
  expiresAt: '',
  lastVerifiedAt: '',
};

export class ActivationHeartbeat {
  private readonly verify: () => Promise<AuthorizationOutcome>;

  private readonly canRedeem: (now: number) => boolean;

  private readonly redeem: () => Promise<AuthorizationOutcome>;

  private readonly now: () => number;

  private readonly random: () => number;

  private readonly heartbeatMs: number;

  private readonly onChange: ((snapshot: HeartbeatSnapshot) => void) | null;

  private state: HeartbeatSnapshot = INACTIVE_HEARTBEAT;

  private timer: ReturnType<typeof setTimeout> | null = null;

  private busy = false;

  private stopped = true;

  /** 连续失败次数：驱动 1→2→5 分钟退避，成功/解绑后归零。 */
  private suspendAttempts = 0;

  /** 最近一次成功兑换的时间戳；0 表示本会话还没兑换过。 */
  private lastRedeemAt = 0;

  constructor(deps: HeartbeatDeps) {
    this.verify = deps.verify;
    this.canRedeem = deps.canRedeem;
    this.redeem = deps.redeem;
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.onChange = deps.onChange ?? null;
  }

  getSnapshot(): HeartbeatSnapshot {
    return this.state;
  }

  /** 启动：读档后立刻校验一次（状态进入 verifying）。
   *  `redeemedAt` 用于恢复「上次兑换时间」，让 60 秒冲突守卫在重启后仍然有效。 */
  start(redeemedAt = 0): void {
    this.stopped = false;
    this.lastRedeemAt = redeemedAt;
    void this.runVerify(true);
  }

  /** 系统 resume：只有已激活/暂停时才有意义。 */
  resume(): void {
    if (this.stopped || this.state.status === 'inactive') return;
    void this.runVerify(true);
  }

  /** 手动「重新校验」：等待本次结果后返回最新状态。 */
  async recheck(): Promise<HeartbeatSnapshot> {
    await this.runVerify(true);
    return this.state;
  }

  /** 激活流程成功（已写盘）后进入 active，并立即向网关校验一次。 */
  markActivated(plan: string, expiresAt: string): void {
    this.stopped = false;
    this.lastRedeemAt = this.now();
    this.suspendAttempts = 0;
    this.transition({
      status: 'active',
      reason: null,
      plan,
      expiresAt,
      lastVerifiedAt: new Date(this.now()).toISOString(),
    });
    void this.runVerify(false);
  }

  /** 解绑：停表并回到未激活（不动凭证，由服务负责删除）。 */
  markInactive(): void {
    this.clearTimer();
    this.stopped = true;
    this.suspendAttempts = 0;
    this.lastRedeemAt = 0;
    this.transition(INACTIVE_HEARTBEAT);
  }

  /** 停表（退出/解绑）；已发出的请求返回后被 stopped 拦截，不再改状态。 */
  stop(): void {
    this.stopped = true;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private transition(next: HeartbeatSnapshot): void {
    const prev = this.state;
    if (
      prev.status === next.status &&
      prev.reason === next.reason &&
      prev.plan === next.plan &&
      prev.expiresAt === next.expiresAt &&
      prev.lastVerifiedAt === next.lastVerifiedAt
    ) {
      return;
    }
    this.state = next;
    this.onChange?.(next);
  }

  private suspendTo(reason: ActivationSuspendedReason): void {
    this.suspendAttempts += 1;
    this.transition({ ...this.state, status: 'suspended', reason });
  }

  private becomeActive(outcome: { plan: string; expiresAt: string }): void {
    this.suspendAttempts = 0;
    this.transition({
      status: 'active',
      reason: null,
      plan: outcome.plan,
      expiresAt: outcome.expiresAt,
      lastVerifiedAt: new Date(this.now()).toISOString(),
    });
  }

  private scheduleNext(): void {
    this.clearTimer();
    if (this.stopped) return;
    if (this.state.status === 'active') {
      const delay = this.jitteredHeartbeatMs();
      this.timer = setTimeout(() => {
        void this.runVerify(false);
      }, delay);
      return;
    }
    if (this.state.status === 'suspended') {
      const index = Math.min(Math.max(this.suspendAttempts - 1, 0), BACKOFF_STEPS_MS.length - 1);
      const delay = BACKOFF_STEPS_MS[index] ?? BACKOFF_STEPS_MS[0];
      this.timer = setTimeout(() => {
        void this.runVerify(false);
      }, delay);
    }
  }

  /** 5 分钟 ±10%：0.9 + 0.2×random。 */
  private jitteredHeartbeatMs(): number {
    const factor = 1 - JITTER_RATIO + 2 * JITTER_RATIO * this.random();
    return Math.round(this.heartbeatMs * factor);
  }

  /** await 期间可能被 stop()；方法调用而非字段读取，避免控制流分析误判冻结值。 */
  private isStoppedNow(): boolean {
    return this.stopped;
  }

  private async runVerify(announce: boolean): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    this.clearTimer();
    // 常规心跳不把界面闪回「校验中」；启动/暂停恢复/手动校验才展示 verifying
    if (announce && this.state.status !== 'active') {
      this.transition({ ...this.state, status: 'verifying', reason: null });
    }
    try {
      let outcome: AuthorizationOutcome;
      try {
        outcome = await this.verify();
      } catch {
        outcome = { kind: 'failure' };
      }
      if (this.isStoppedNow()) return;
      await this.applyOutcome(outcome);
    } finally {
      this.busy = false;
      if (!this.isStoppedNow()) this.scheduleNext();
    }
  }

  private async applyOutcome(outcome: AuthorizationOutcome): Promise<void> {
    switch (outcome.kind) {
      case 'ok':
        this.becomeActive(outcome);
        return;
      case 'disabled':
        this.suspendTo('disabled');
        return;
      case 'expired':
        this.suspendTo('expired');
        return;
      case 'failure':
        this.suspendTo('network');
        return;
      case 'unauthorized':
        await this.handleUnauthorized(outcome.code);
    }
  }

  /** 401 分流：superseded 不重兑换；其余 401 在守卫内重兑换一次。 */
  private async handleUnauthorized(code: string): Promise<void> {
    // 令牌已被替代：说明另一台设备绑定了同一激活码，不自动重兑换（否则互相顶号）
    if (code === 'token_superseded') {
      this.suspendTo('device_conflict');
      return;
    }
    const now = this.now();
    // 兑换后 60 秒内的 401 一律按设备冲突（防止 A/B 设备互相顶号抖动）
    if (this.lastRedeemAt > 0 && now - this.lastRedeemAt < REDEEM_CONFLICT_WINDOW_MS) {
      this.suspendTo('device_conflict');
      return;
    }
    if (!this.canRedeem(now)) {
      this.suspendTo('invalid_token');
      return;
    }
    let outcome: AuthorizationOutcome;
    try {
      outcome = await this.redeem();
    } catch {
      outcome = { kind: 'failure' };
    }
    if (this.stopped) return;
    switch (outcome.kind) {
      case 'ok':
        this.lastRedeemAt = this.now();
        this.becomeActive(outcome);
        return;
      case 'unauthorized':
        this.suspendTo(outcome.code === 'token_superseded' ? 'device_conflict' : 'invalid_token');
        return;
      case 'disabled':
        this.suspendTo('disabled');
        return;
      case 'expired':
        this.suspendTo('expired');
        return;
      case 'failure':
        this.suspendTo('network');
    }
  }
}
