/** 桌面激活服务：把凭证存储、网关客户端、心跳状态机和托管 LLM 设置串起来。
 *
 * 职责边界（desktop-activation D6/D7/D13/D14）：
 * - 唯一状态源在主进程；渲染层只能拿到脱敏快照；
 * - 激活顺序：兑换 → 清空引擎中心 llm 启用行（并记住原启用 id）→ 写托管 settings → 写加密凭证；
 * - 解绑：仅当 settings 仍等于托管值时才清空，绝不恢复引擎中心启用行；
 * - 心跳 401 的自动重兑换做会话一次 + 10 分钟间隔守卫。
 */
import os from 'node:os';
import type {
  ActivationOperationResult,
  ActivationSnapshot,
  ActivationSuspendedReason,
} from '@dramaclip/protocol';
import {
  ActivationHeartbeat,
  DEFAULT_HEARTBEAT_MS,
  type AuthorizationOutcome,
} from './activation-heartbeat';
import {
  ActivationStoreError,
  type ActivationRecord,
  type ActivationStore,
} from './activation-store';
import {
  describeRedeemFailure,
  fetchMe,
  redeem,
  type GatewayFailure,
  type GatewayRequestOptions,
} from './gateway-client';

/** 自动重兑换的最小间隔（与设计 D13 一致）。 */
export const REDEEM_MIN_INTERVAL_MS = 10 * 60_000;
/** 激活码长度口径：8–128（与网关签发/界面输入校验一致）。 */
export const CODE_MIN_LENGTH = 8;
export const CODE_MAX_LENGTH = 128;
const MANAGED_MODEL = 'default';

/** IPC 层依赖的最小控制器面（便于 registerIpc 注入与单测）。 */
export interface ActivationController {
  status(recheck: boolean): Promise<ActivationSnapshot>;
  redeem(code: string): Promise<ActivationOperationResult>;
  unbind(): Promise<ActivationOperationResult>;
  getSnapshot(): ActivationSnapshot;
  stop(): void;
}

export interface ActivationServiceOptions {
  readonly store: ActivationStore;
  /** 已解析的网关基址；空串表示配置无效（gatewayError 给出原因）。 */
  readonly gatewayUrl: string;
  readonly gatewayError?: string | null;
  readonly rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  readonly onChange: (snapshot: ActivationSnapshot) => void;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** 设备标签来源（默认 os.hostname()）。 */
  readonly hostname?: string;
  readonly now?: () => number;
  readonly random?: () => number;
  /** 测试注入 fetch/超时，生产缺省走全局 fetch。 */
  readonly fetchOptions?: GatewayRequestOptions;
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误';
}

/** 激活码形状：去首尾空白后 8–128 字符；不合法返回 null（IPC 与界面共用）。 */
export function normalizeActivationCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length < CODE_MIN_LENGTH || trimmed.length > CODE_MAX_LENGTH) return null;
  return trimmed;
}

/** 脱敏激活码：只保留末 4 位（快照绝不带全文）。 */
export function maskActivationCode(code: string): string {
  if (code.length <= 4) return '••••';
  return `••••${code.slice(-4)}`;
}

/** DRAMACLIP_HEARTBEAT_MS 覆盖心跳周期；非法/过小值回退默认 5 分钟。 */
export function resolveHeartbeatMs(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env.DRAMACLIP_HEARTBEAT_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_HEARTBEAT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1_000) return DEFAULT_HEARTBEAT_MS;
  return Math.round(parsed);
}

/** 从 engine_configs.list 响应里找当前启用的配置 id（role=已启用行）。 */
function findEnabledConfigId(payload: unknown): string | null {
  if (!isRecordLike(payload) || !Array.isArray(payload.configs)) return null;
  for (const item of payload.configs) {
    if (isRecordLike(item) && item.enabled === 1 && typeof item.id === 'string') return item.id;
  }
  return null;
}

/** settings.get 返回扁平键值表；兼容被包一层 values 的网关形态。 */
function readSettingsMap(payload: unknown): Record<string, string> {
  if (!isRecordLike(payload)) return {};
  const source = isRecordLike(payload.values) ? payload.values : payload;
  const map: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string') map[key] = value;
  }
  return map;
}

export class ActivationService implements ActivationController {
  private readonly store: ActivationStore;

  private readonly gatewayUrl: string;

  private readonly gatewayError: string | null;

  private readonly rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>;

  private readonly onChange: (snapshot: ActivationSnapshot) => void;

  private readonly hostname: string;

  private readonly now: () => number;

  private readonly fetchOptions: GatewayRequestOptions;

  private readonly heartbeat: ActivationHeartbeat;

  private record: ActivationRecord | null = null;

  /** 本次会话是否已自动重兑换过（会话一次）。 */
  private redeemAttempted = false;

  /** 最近一次成功兑换时间戳；驱动 10 分钟间隔守卫。 */
  private lastRedeemAt = 0;

  private busy = false;

  constructor(options: ActivationServiceOptions) {
    this.store = options.store;
    this.gatewayUrl = options.gatewayUrl;
    this.gatewayError = options.gatewayError ?? null;
    this.rpc = options.rpc;
    this.onChange = options.onChange;
    this.hostname = options.hostname ?? os.hostname();
    this.now = options.now ?? Date.now;
    this.fetchOptions = options.fetchOptions ?? {};
    this.heartbeat = new ActivationHeartbeat({
      verify: () => this.verifyWithGateway(),
      canRedeem: (now) => this.canAutoRedeem(now),
      redeem: () => this.redeemAutomatically(),
      heartbeatMs: resolveHeartbeatMs(options.env ?? {}),
      now: this.now,
      ...(options.random === undefined ? {} : { random: options.random }),
      onChange: () => {
        this.emitSnapshot();
      },
    });
  }

  /** 启动：读加密凭证 → verifying → 立即心跳；无凭证保持未激活。 */
  start(): void {
    this.record = this.store.load();
    if (this.record === null) {
      this.heartbeat.markInactive();
      return;
    }
    const activatedAt = Date.parse(this.record.activatedAt);
    this.lastRedeemAt = Number.isFinite(activatedAt) ? activatedAt : 0;
    this.heartbeat.start(this.lastRedeemAt);
  }

  stop(): void {
    this.heartbeat.stop();
  }

  /** 系统从睡眠恢复：立即补一次校验（断网期间令牌可能已被替代/停用）。 */
  resume(): void {
    this.heartbeat.resume();
  }

  getSnapshot(): ActivationSnapshot {
    const state = this.heartbeat.getSnapshot();
    const record = this.record;
    const plan = state.plan !== '' ? state.plan : (record?.plan ?? '');
    const expiresAt = state.expiresAt !== '' ? state.expiresAt : (record?.expiresAt ?? '');
    const lastVerifiedAt =
      state.lastVerifiedAt !== '' ? state.lastVerifiedAt : (record?.lastVerifiedAt ?? '');
    const reason: ActivationSuspendedReason | null =
      state.status === 'suspended' ? (state.reason ?? 'network') : null;
    const base: ActivationSnapshot = {
      status: state.status,
      plan,
      expiresAt,
      lastVerifiedAt,
      maskedCode: record === null ? '' : maskActivationCode(record.code),
      gatewayUrl: this.gatewayUrl,
    };
    if (reason === null) return base;
    return { ...base, reason };
  }

  async status(recheck: boolean): Promise<ActivationSnapshot> {
    if (recheck && this.record !== null && this.gatewayUrl !== '') {
      await this.heartbeat.recheck();
    }
    return this.getSnapshot();
  }

  /** 手动激活：兑换 → 清引擎启用行 → 写托管 settings → 落加密凭证。 */
  async redeem(code: string): Promise<ActivationOperationResult> {
    const normalized = normalizeActivationCode(code);
    if (normalized === null) {
      return this.failure(`激活码需为 ${String(CODE_MIN_LENGTH)}–${String(CODE_MAX_LENGTH)} 个字符，请核对后重试`);
    }
    if (this.gatewayUrl === '') {
      return this.failure(this.gatewayError ?? '激活网关地址未配置，请设置 DRAMACLIP_GATEWAY_URL 或打包 gateway.json');
    }
    if (this.busy) return this.failure('激活操作正在进行中，请稍候');
    this.busy = true;
    try {
      return await this.performActivation(normalized);
    } finally {
      this.busy = false;
    }
  }

  /** 解绑：仅当 settings 仍是托管值才清空；不恢复引擎中心启用行。 */
  async unbind(): Promise<ActivationOperationResult> {
    if (this.busy) return this.failure('激活操作正在进行中，请稍候');
    this.busy = true;
    this.heartbeat.stop();
    try {
      const clearMessage = await this.clearManagedSettingsIfOwned();
      try {
        this.store.clear();
      } catch (error) {
        this.record = this.store.load();
        if (this.record !== null) this.heartbeat.start(this.lastRedeemAt);
        const reason = error instanceof ActivationStoreError ? error.message : reasonOf(error);
        return { ok: false, snapshot: this.getSnapshot(), message: reason };
      }
      this.record = null;
      this.redeemAttempted = false;
      this.lastRedeemAt = 0;
      this.heartbeat.markInactive();
      return {
        ok: true,
        snapshot: this.getSnapshot(),
        ...(clearMessage === null ? {} : { message: clearMessage }),
      };
    } finally {
      this.busy = false;
    }
  }

  private failure(message: string): ActivationOperationResult {
    return { ok: false, snapshot: this.getSnapshot(), message };
  }

  private emitSnapshot(): void {
    this.onChange(this.getSnapshot());
  }

  private async performActivation(code: string): Promise<ActivationOperationResult> {
    const gatewayResult = await redeem(this.gatewayUrl, code, this.hostname, this.fetchOptions);
    if (!gatewayResult.ok) {
      return this.failure(describeRedeemFailure(gatewayResult));
    }
    let priorEnabledId: string | null;
    try {
      priorEnabledId = findEnabledConfigId(await this.rpc('engine_configs.list', { domain: 'llm' }));
    } catch {
      priorEnabledId = null;
    }
    // D14：先清空引擎中心的 llm 启用行，清空失败则中止（不写 settings）
    try {
      await this.rpc('engine_configs.enable', { domain: 'llm', local: true });
    } catch (error) {
      return this.failure(
        `未能清空引擎中心的 LLM 启用配置，已中止激活：${reasonOf(error)}`,
      );
    }
    try {
      await this.writeManagedLlmSettings(gatewayResult.token, true);
    } catch (error) {
      await this.restorePriorConfiguration(priorEnabledId);
      return this.failure(
        `写入托管 LLM 设置失败，已恢复原引擎配置：${reasonOf(error)}`,
      );
    }
    const nowIso = new Date(this.now()).toISOString();
    const record: ActivationRecord = {
      gatewayUrl: this.gatewayUrl,
      code,
      token: gatewayResult.token,
      tokenId: gatewayResult.tokenId,
      plan: gatewayResult.plan,
      expiresAt: gatewayResult.expiresAt,
      activatedAt: nowIso,
      lastVerifiedAt: nowIso,
      deviceLabel: this.hostname,
    };
    try {
      this.store.save(record);
    } catch (error) {
      // 凭证落盘失败：把托管设置复原，避免「设置指向网关却重启失联」
      await this.restorePriorConfiguration(priorEnabledId);
      return this.failure(
        `无法保存激活凭证：${error instanceof ActivationStoreError ? error.message : reasonOf(error)}`,
      );
    }
    this.record = record;
    this.redeemAttempted = false;
    this.lastRedeemAt = this.now();
    this.heartbeat.markActivated(gatewayResult.plan, gatewayResult.expiresAt);
    return { ok: true, snapshot: this.getSnapshot() };
  }

  /** 托管 LLM 三项：base_url=<gateway>/v1、api_key=设备令牌、model=default。
   *  自动重兑换时只更新 api_key（不覆盖用户可能改过的 base_url/model）。 */
  private async writeManagedLlmSettings(token: string, full: boolean): Promise<void> {
    const values: Record<string, string> = { 'llm.api_key': token };
    if (full) {
      values['llm.base_url'] = `${this.gatewayUrl}/v1`;
      values['llm.model'] = MANAGED_MODEL;
    }
    await this.rpc('settings.update', { values });
  }

  private async restorePriorConfiguration(priorEnabledId: string | null): Promise<void> {
    if (priorEnabledId !== null) {
      try {
        await this.rpc('engine_configs.enable', { id: priorEnabledId });
        return;
      } catch {
        // 恢复失败则退到清空托管值，至少不把用户指向失效网关
      }
    }
    try {
      await this.rpc('settings.update', {
        values: { 'llm.base_url': '', 'llm.api_key': '', 'llm.model': '' },
      });
    } catch {
      // 最佳努力：激活失败路径不因二次失败吞掉原始错误
    }
  }

  /** 解绑时按 base_url/model 精确匹配判断是否仍归托管；返回需要提示的补充信息。 */
  private async clearManagedSettingsIfOwned(): Promise<string | null> {
    let values: Record<string, string>;
    try {
      values = readSettingsMap(await this.rpc('settings.get', {}));
    } catch (error) {
      return `本地授权已删除，但读取当前 LLM 设置失败，托管配置未清空：${reasonOf(error)}`;
    }
    const managedBaseUrl = `${this.gatewayUrl}/v1`;
    const owned = values['llm.base_url'] === managedBaseUrl && values['llm.model'] === MANAGED_MODEL;
    if (!owned) return null;
    try {
      await this.rpc('settings.update', {
        values: { 'llm.base_url': '', 'llm.api_key': '', 'llm.model': '' },
      });
    } catch (error) {
      return `本地授权已删除，但清空托管 LLM 设置失败：${reasonOf(error)}`;
    }
    return null;
  }

  private canAutoRedeem(now: number): boolean {
    if (this.record === null) return false;
    if (this.redeemAttempted) return false;
    if (this.lastRedeemAt <= 0) return false;
    return now - this.lastRedeemAt >= REDEEM_MIN_INTERVAL_MS;
  }

  private async verifyWithGateway(): Promise<AuthorizationOutcome> {
    const record = this.record;
    if (record === null || this.gatewayUrl === '') return { kind: 'failure' };
    const result = await fetchMe(this.gatewayUrl, record.token, this.fetchOptions);
    if (result.ok) {
      this.persistVerified(result.plan, result.expiresAt);
      return { kind: 'ok', plan: result.plan, expiresAt: result.expiresAt };
    }
    return mapFailure(result);
  }

  /** 心跳成功：刷新套餐/到期/最近校验（写盘失败不改变 active 结论）。 */
  private persistVerified(plan: string, expiresAt: string): void {
    const record = this.record;
    if (record === null) return;
    const updated: ActivationRecord = {
      ...record,
      plan: plan !== '' ? plan : record.plan,
      expiresAt: expiresAt !== '' ? expiresAt : record.expiresAt,
      lastVerifiedAt: new Date(this.now()).toISOString(),
    };
    this.record = updated;
    try {
      this.store.save(updated);
    } catch {
      // 心跳成功但凭证写盘失败：内存态继续 active，下次成功再写
    }
  }

  private async redeemAutomatically(): Promise<AuthorizationOutcome> {
    this.redeemAttempted = true;
    const record = this.record;
    if (record === null || this.gatewayUrl === '') return { kind: 'failure' };
    const result = await redeem(this.gatewayUrl, record.code, this.hostname, this.fetchOptions);
    if (!result.ok) {
      this.lastRedeemAt = this.now();
      return mapFailure(result);
    }
    const nowIso = new Date(this.now()).toISOString();
    const updated: ActivationRecord = {
      ...record,
      token: result.token,
      tokenId: result.tokenId,
      plan: result.plan !== '' ? result.plan : record.plan,
      expiresAt: result.expiresAt !== '' ? result.expiresAt : record.expiresAt,
      lastVerifiedAt: nowIso,
    };
    try {
      this.store.save(updated);
    } catch {
      return { kind: 'failure' };
    }
    this.record = updated;
    this.lastRedeemAt = this.now();
    try {
      await this.writeManagedLlmSettings(result.token, false);
    } catch {
      return { kind: 'failure' };
    }
    return {
      kind: 'ok',
      plan: updated.plan,
      expiresAt: updated.expiresAt,
    };
  }
}

/** 网关失败 → 状态机结果：401 交给重兑换分流，403 区分到期/停用，其余按网络类失败。 */
function mapFailure(failure: GatewayFailure): AuthorizationOutcome {
  if (failure.status === 401) return { kind: 'unauthorized', code: failure.code };
  if (failure.status === 404) return { kind: 'unauthorized', code: 'invalid_token' };
  if (failure.status === 403) {
    if (failure.code === 'activation_expired') return { kind: 'expired' };
    return { kind: 'disabled' };
  }
  return { kind: 'failure' };
}
