/** 桌面激活服务：把凭证存储、网关客户端、心跳状态机和托管 LLM/ASR 设置串起来。
 *
 * 职责边界（desktop-activation D6/D7/D13/D14）：
 * - 唯一状态源在主进程；渲染层只能拿到脱敏快照；
 * - 激活顺序：兑换 → 记录先前的 llm/asr_cloud 启用行与 asr.* 快照 → 清空两域启用行
 *   → 单次写 7 个托管键 → 写加密凭证；任一步失败按逆序恢复并中止；
 * - 升级门禁：启动时发现存量记录的 asr.engine 不是 cloud_gateway，清托管令牌并强制重新激活；
 * - 解绑：仅当 settings 仍等于托管值时才清空，绝不恢复引擎中心启用行、不删本地模型；
 * - 心跳 401 的自动重兑换做会话一次 + 10 分钟间隔守卫，只同步托管令牌键。
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
  type HeartbeatSnapshot,
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

/** 托管云端识别引擎与默认模型（add-cloud-asr-gateway D6）。 */
export const MANAGED_ASR_ENGINE = 'cloud_gateway';
export const MANAGED_ASR_MODEL = 'fun-asr-flash';

/** 激活会覆盖的 asr.* 键；失败回滚按激活前快照写回（D6）。 */
const PRIOR_ASR_KEYS = [
  'asr.engine',
  'asr.model',
  'asr.device',
  'asr.compute_type',
  'asr.api_key',
  'asr.base_url',
  'asr.diarization',
  'asr.num_speakers',
] as const;

/** settings.get 对 api_key/token 出掩码（service api/settings.py）：只能判断「是否已设置」。 */
const SECRET_MASK = '••••••••';

/** 激活前状态：两域启用行 + asr.* 快照（asrValues 为 null 表示读取失败）。 */
interface PriorManagedState {
  readonly llmEnabledId: string | null;
  readonly asrEnabledId: string | null;
  readonly asrValues: Record<string, string> | null;
}

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

/** settings.get 的密钥键会被服务端掩码；回写掩码等于「保持原值」，并非真实密钥。 */
function isMaskedSecretValue(key: string, value: string): boolean {
  const tail = key.slice(key.lastIndexOf('.') + 1);
  return (tail.endsWith('api_key') || tail.endsWith('token')) && value === SECRET_MASK;
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

  /** 强制重授权清理进行中：防止 onChange/手动调用重入。 */
  private forcingReactivation = false;

  /** 启动时的托管 ASR 归属校验；落定前 verifyWithGateway 不得把状态带入 active。 */
  private startupGate: Promise<boolean> | null = null;

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
      onChange: (snapshot) => {
        this.handleHeartbeatChange(snapshot);
      },
    });
  }

  /** 启动：读加密凭证 → verifying → 立即心跳；无凭证保持未激活。
   *  存量记录若已不是 cloud_gateway（旧版本的本地引擎配置），先清托管凭证强制重新激活（D6）。 */
  start(): void {
    this.record = this.store.load();
    if (this.record === null) {
      this.startupGate = null;
      this.heartbeat.markInactive();
      return;
    }
    const deactivated = this.record.deactivated;
    if (deactivated !== undefined) {
      // 强制重授权：重启后仍整屏阻断，不发任何网络请求
      this.startupGate = null;
      this.lastRedeemAt = 0;
      this.heartbeat.markReactivationRequired(deactivated.reason);
      return;
    }
    const activatedAt = Date.parse(this.record.activatedAt);
    this.lastRedeemAt = Number.isFinite(activatedAt) ? activatedAt : 0;
    // 先同步进入 verifying（整屏门禁），再在 verify() 内等归属校验落定，避免闪回主界面
    this.startupGate = this.ensureManagedAsrOnStart(this.record);
    this.heartbeat.start(this.lastRedeemAt);
  }

  /** 升级门禁：只有 asr.engine 仍为 cloud_gateway 的存量记录才允许继续心跳。
   *  读取失败或引擎不一致都停在门禁，绝不推断/补写本地引擎配置。 */
  private async ensureManagedAsrOnStart(record: ActivationRecord): Promise<boolean> {
    let values: Record<string, string>;
    try {
      values = readSettingsMap(await this.rpc('settings.get', {}));
    } catch (error) {
      console.error(
        `[activation] 读取识别引擎设置失败，保持激活门禁并要求重新激活：${reasonOf(error)}`,
      );
      await this.forceReactivationOnUpgrade(record);
      return false;
    }
    if (this.record !== record) return true; // 已有新的激活接管
    if (values['asr.engine'] === MANAGED_ASR_ENGINE) return true;
    console.warn(
      `[activation] 存量激活的 asr.engine=${values['asr.engine'] ?? ''} 不是 ${MANAGED_ASR_ENGINE}，清除托管凭证并强制重新激活`,
    );
    await this.forceReactivationOnUpgrade(record);
    return false;
  }

  /** 升级强制重新激活：停心跳 → 清托管 api_key → 删加密记录 → inactive 门禁。
   *  任一步失败也必须停在门禁（不回到主界面）；不恢复/推断本地引擎配置。 */
  private async forceReactivationOnUpgrade(record: ActivationRecord): Promise<void> {
    if (this.record !== record) return;
    // 清理期间锁住手动兑换：避免新激活刚写入的凭证/令牌被升级清理再擦掉
    this.busy = true;
    try {
      this.heartbeat.stop();
      let cleanupFailed = false;
      try {
        await this.rpc('settings.update', { values: { 'llm.api_key': '', 'asr.api_key': '' } });
      } catch (error) {
        cleanupFailed = true;
        console.error(`[activation] 清除托管令牌失败：${reasonOf(error)}`);
      }
      try {
        this.store.clear();
      } catch (error) {
        cleanupFailed = true;
        console.error(`[activation] 删除激活记录失败：${reasonOf(error)}`);
      }
      this.record = null;
      this.redeemAttempted = false;
      this.lastRedeemAt = 0;
      this.heartbeat.markInactive();
      if (cleanupFailed) {
        console.error('[activation] 升级清理未完成：保持激活门禁，请重新输入激活码');
      }
    } finally {
      this.busy = false;
    }
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
    const blocked = state.status === 'suspended' || state.status === 'reactivation_required';
    const reason: ActivationSuspendedReason | null = blocked ? (state.reason ?? 'network') : null;
    const deactivatedAt = record?.deactivated?.at;
    const base: ActivationSnapshot = {
      status: state.status,
      plan,
      expiresAt,
      lastVerifiedAt,
      maskedCode: record === null ? '' : maskActivationCode(record.code),
      gatewayUrl: this.gatewayUrl,
      ...(deactivatedAt === undefined ? {} : { deactivatedAt }),
    };
    if (reason === null) return base;
    return { ...base, reason };
  }

  async status(recheck: boolean): Promise<ActivationSnapshot> {
    if (
      recheck &&
      this.record !== null &&
      this.record.deactivated === undefined &&
      this.gatewayUrl !== ''
    ) {
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
      this.startupGate = null;
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

  /** 心跳或启动发现授权无效后的唯一落盘点（D3.1）。
   *
   * 停表 → 清内存/磁盘 token → 写 deactivated → 仅在 LLM 仍归属本网关时清 llm.api_key。
   * 幂等：已处于强制态时只重复落盘状态，不重复清理。 */
  async forceReactivation(reason: ActivationSuspendedReason): Promise<void> {
    if (this.forcingReactivation) return;
    const record = this.record;
    this.heartbeat.stop();
    if (record === null) {
      this.heartbeat.markReactivationRequired(reason);
      return;
    }
    this.forcingReactivation = true;
    this.busy = true;
    try {
      const at = new Date(this.now()).toISOString();
      const cleared: ActivationRecord = {
        ...record,
        token: '',
        tokenId: '',
        lastVerifiedAt: at,
        deactivated: { reason, at },
      };
      await this.clearManagedLlmKeyIfOwned();
      try {
        this.store.save(cleared);
      } catch (error) {
        console.error(`[activation] 写入强制重授权标记失败：${reasonOf(error)}`);
      }
      this.record = cleared;
      this.redeemAttempted = false;
      this.heartbeat.markReactivationRequired(reason);
    } finally {
      this.forcingReactivation = false;
      this.busy = false;
    }
  }

  private handleHeartbeatChange(snapshot: HeartbeatSnapshot): void {
    this.emitSnapshot();
    if (snapshot.status !== 'reactivation_required') return;
    const record = this.record;
    if (record === null || record.deactivated !== undefined) return;
    void this.forceReactivation(snapshot.reason ?? 'invalid_token');
  }

  /** 只在 LLM 托管值仍指向本网关时清 api_key；不碰 ASR 键与用户自建配置。 */
  private async clearManagedLlmKeyIfOwned(): Promise<void> {
    let values: Record<string, string>;
    try {
      values = readSettingsMap(await this.rpc('settings.get', {}));
    } catch {
      return;
    }
    const managedBaseUrl = `${this.gatewayUrl}/v1`;
    if (values['llm.base_url'] !== managedBaseUrl || values['llm.model'] !== MANAGED_MODEL) return;
    try {
      await this.rpc('settings.update', { values: { 'llm.api_key': '' } });
    } catch (error) {
      console.error(`[activation] 清除托管 LLM 令牌失败：${reasonOf(error)}`);
    }
  }

  private failure(message: string): ActivationOperationResult {
    return { ok: false, snapshot: this.getSnapshot(), message };
  }

  private emitSnapshot(): void {
    this.onChange(this.getSnapshot());
  }

  /** 手动激活：兑换 → 记录先前的两域启用行与 asr.* 快照 → 清空两域启用行
   *  → 单次写 7 个托管键 → 落加密凭证；任一步失败按逆序恢复并中止（D6）。 */
  private async performActivation(code: string): Promise<ActivationOperationResult> {
    const gatewayResult = await redeem(this.gatewayUrl, code, this.hostname, this.fetchOptions);
    if (!gatewayResult.ok) {
      return this.failure(describeRedeemFailure(gatewayResult));
    }
    const prior = await this.capturePriorManagedState();
    if (prior === null) {
      // 没有激活前快照就无法安全回滚，宁可不写
      return this.failure('读取当前识别设置失败，已中止激活（未改动任何配置）');
    }
    // 先清空 llm 与 asr_cloud 两域启用行；失败时 settings 尚未改动（D14/D6）
    try {
      await this.rpc('engine_configs.enable', { domain: 'llm', local: true });
    } catch (error) {
      return this.failure(
        `未能清空引擎中心的 LLM 启用配置，已中止激活：${reasonOf(error)}`,
      );
    }
    try {
      await this.rpc('engine_configs.enable', { domain: 'asr_cloud', local: true });
    } catch (error) {
      await this.restorePriorConfiguration(prior, false);
      return this.failure(
        `未能清空引擎中心的云端识别启用配置，已恢复原引擎配置：${reasonOf(error)}`,
      );
    }
    try {
      await this.writeManagedSettings(gatewayResult.token);
    } catch (error) {
      // settings.update 可能已逐键写入一部分，按「已写」处理，恢复快照更安全
      await this.restorePriorConfiguration(prior, true);
      return this.failure(
        `写入托管识别设置失败，已恢复原引擎配置：${reasonOf(error)}`,
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
      await this.restorePriorConfiguration(prior, true);
      return this.failure(
        `无法保存激活凭证：${error instanceof ActivationStoreError ? error.message : reasonOf(error)}`,
      );
    }
    this.record = record;
    this.startupGate = null;
    this.redeemAttempted = false;
    this.lastRedeemAt = this.now();
    this.heartbeat.markActivated(gatewayResult.plan, gatewayResult.expiresAt);
    return { ok: true, snapshot: this.getSnapshot() };
  }

  /** 记录激活前的两域启用行与 asr.* 快照；settings 读取失败返回 null（不允许盲写）。 */
  private async capturePriorManagedState(): Promise<PriorManagedState | null> {
    let llmEnabledId: string | null = null;
    try {
      llmEnabledId = findEnabledConfigId(await this.rpc('engine_configs.list', { domain: 'llm' }));
    } catch {
      // 读取失败按「无原启用行」处理：回滚时清除 LLM 托管键即可
    }
    let asrEnabledId: string | null = null;
    try {
      asrEnabledId = findEnabledConfigId(
        await this.rpc('engine_configs.list', { domain: 'asr_cloud' }),
      );
    } catch {
      // 读取失败按「无原启用行」处理：回滚只恢复 asr.* 快照
    }
    let values: Record<string, string>;
    try {
      values = readSettingsMap(await this.rpc('settings.get', {}));
    } catch {
      return null;
    }
    const asrValues: Record<string, string> = {};
    for (const key of PRIOR_ASR_KEYS) asrValues[key] = values[key] ?? '';
    return { llmEnabledId, asrEnabledId, asrValues };
  }

  /** 激活托管写：LLM 三键 + 云端识别四键，单次 settings.update（D6）。 */
  private async writeManagedSettings(token: string): Promise<void> {
    const managedBaseUrl = `${this.gatewayUrl}/v1`;
    await this.rpc('settings.update', {
      values: {
        'llm.base_url': managedBaseUrl,
        'llm.model': MANAGED_MODEL,
        'llm.api_key': token,
        'asr.engine': MANAGED_ASR_ENGINE,
        'asr.base_url': managedBaseUrl,
        'asr.api_key': token,
        'asr.model': MANAGED_ASR_MODEL,
      },
    });
  }

  /** 心跳自动重兑换：同步 llm.api_key，以及仍托管的 asr.api_key；
   *  绝不改写 asr.engine/model/base_url（D6）。 */
  private async writeManagedTokenSettings(token: string): Promise<void> {
    const values: Record<string, string> = { 'llm.api_key': token };
    if (await this.isManagedAsrKey()) values['asr.api_key'] = token;
    await this.rpc('settings.update', { values });
  }

  /** 是否仍是托管云端识别：settings.get 对密钥出掩码，无法逐字比对旧令牌，
   *  只能确认引擎未切走且 api_key 仍已设置。读取失败按「非托管」处理。 */
  private async isManagedAsrKey(): Promise<boolean> {
    try {
      const values = readSettingsMap(await this.rpc('settings.get', {}));
      return values['asr.engine'] === MANAGED_ASR_ENGINE && (values['asr.api_key'] ?? '') !== '';
    } catch {
      return false;
    }
  }

  /** 激活失败逆序回滚：先写回 asr.* 快照（撤销 settings 写入），再恢复两域启用行。 */
  private async restorePriorConfiguration(
    prior: PriorManagedState,
    settingsWritten: boolean,
  ): Promise<void> {
    if (settingsWritten && prior.asrValues !== null) {
      const values: Record<string, string> = {};
      for (const key of PRIOR_ASR_KEYS) {
        const value = prior.asrValues[key] ?? '';
        // 密钥在 settings.get 里是掩码：回写掩码=保持现值（拿不到原真值），
        // 由原 asr_cloud 启用行的 mirror 恢复；不能写空抹掉用户原有 BYO Key。
        if (isMaskedSecretValue(key, value)) continue;
        values[key] = value;
      }
      if (Object.keys(values).length > 0) {
        try {
          await this.rpc('settings.update', { values });
        } catch {
          // 最佳努力：不吞掉最初的激活失败原因
        }
      }
    }
    if (prior.asrEnabledId !== null) {
      try {
        await this.rpc('engine_configs.enable', { id: prior.asrEnabledId });
      } catch {
        // 同上：恢复失败仍需保留原始错误信息
      }
    }
    await this.restorePriorLlmConfiguration(prior.llmEnabledId);
  }

  /** 恢复激活前的 LLM：优先重新启用原配置行（启用即镜像 settings），否则清空托管三键。 */
  private async restorePriorLlmConfiguration(priorEnabledId: string | null): Promise<void> {
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

  /** 解绑清理：只清仍属于托管的键，保留 asr.engine/model 供用户手动回退。
   *  settings.get 对 api_key 出掩码，无法逐字比对；llm 用 base_url/model 证明归属，
   *  asr 用 activation 独有的 asr.base_url 证明归属（服务端 mirror 不写该键）。 */
  private async clearManagedSettingsIfOwned(): Promise<string | null> {
    let values: Record<string, string>;
    try {
      values = readSettingsMap(await this.rpc('settings.get', {}));
    } catch (error) {
      return `本地授权已删除，但读取当前识别设置失败，托管配置未清空：${reasonOf(error)}`;
    }
    const managedBaseUrl = `${this.gatewayUrl}/v1`;
    const managed: Record<string, string> = {};
    if (values['llm.base_url'] === managedBaseUrl && values['llm.model'] === MANAGED_MODEL) {
      managed['llm.base_url'] = '';
      managed['llm.api_key'] = '';
      managed['llm.model'] = '';
    }
    // 只清 ASR 端点/Key（至少清 api_key）；engine/model 必须保留
    if (values['asr.base_url'] === managedBaseUrl) {
      managed['asr.base_url'] = '';
      managed['asr.api_key'] = '';
    } else if (
      values['asr.engine'] === MANAGED_ASR_ENGINE &&
      (values['asr.api_key'] ?? '') !== ''
    ) {
      managed['asr.api_key'] = '';
    }
    if (Object.keys(managed).length === 0) return null;
    try {
      await this.rpc('settings.update', { values: managed });
    } catch (error) {
      return `本地授权已删除，但清空托管识别设置失败：${reasonOf(error)}`;
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
    // 升级门禁落定前绝不放行 active：失败时状态机已被 stop 到 inactive
    const gate = this.startupGate;
    if (gate !== null && !(await gate)) return { kind: 'failure' };
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
      await this.writeManagedTokenSettings(result.token);
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
