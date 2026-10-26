// @vitest-environment node
/** 托管 ASR 设置写入 / 逆序回滚 / 心跳令牌同步（add-cloud-asr-gateway 4.1、4.7）。
 *
 * 断言口径（specs/desktop-activation）：
 * - 激活先清空 llm 与 asr_cloud 两域启用行，再单次写 7 个托管键；
 * - settings 写入/凭证落盘失败时按逆序恢复激活前 asr.* 快照并重新启用两域原行；
 * - settings.get 失败时不允许盲写，直接中止；
 * - 心跳 401 重兑换只同步 llm.api_key 与仍托管的 asr.api_key。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivationSnapshot } from '@dramaclip/protocol';
import type {
  ActivationRecord,
  ActivationSafeStorage,
} from '../../../../main/services/activation-store';
import { ActivationStore } from '../../../../main/services/activation-store';
import { ActivationService } from '../../../../main/services/activation-service';

const GATEWAY = 'http://gw.test';
const NOW_MS = 1_700_000_000_000;
const MANAGED_BASE_URL = `${GATEWAY}/v1`;
const MASK = '••••••••';

function fakeSafeStorage(available = true): ActivationSafeStorage {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plainText: string): Buffer =>
      Buffer.from(`CIPHER:${Buffer.from(plainText, 'utf8').toString('base64')}`, 'utf8'),
    decryptString: (encrypted: Buffer): string =>
      Buffer.from(encrypted.toString('utf8').slice('CIPHER:'.length), 'base64').toString('utf8'),
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function record(overrides: Partial<ActivationRecord> = {}): ActivationRecord {
  return {
    gatewayUrl: GATEWAY,
    code: 'STORE-CODE-9911',
    token: 'token-old',
    tokenId: 'tok-1',
    plan: 'pro',
    expiresAt: '2027-01-01T00:00:00Z',
    activatedAt: new Date(NOW_MS - 11 * 60_000).toISOString(),
    lastVerifiedAt: new Date(NOW_MS - 11 * 60_000).toISOString(),
    deviceLabel: 'test-device',
    ...overrides,
  };
}

/** 托管写入后的 settings 快照（密钥被服务端掩码）。 */
function managedSettings(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    'llm.base_url': MANAGED_BASE_URL,
    'llm.api_key': MASK,
    'llm.model': 'default',
    'asr.engine': 'cloud_gateway',
    'asr.model': 'fun-asr-flash',
    'asr.base_url': MANAGED_BASE_URL,
    'asr.api_key': MASK,
    ...overrides,
  };
}

/** 激活前的本地识别配置（含用户既有 BYO 密钥，服务端以掩码回显）。 */
const PRIOR_SETTINGS: Record<string, string> = {
  'llm.base_url': 'https://old-llm.example/v1',
  'llm.api_key': MASK,
  'llm.model': 'gpt-4o',
  'asr.engine': 'faster_whisper',
  'asr.model': 'large-v3',
  'asr.device': 'cpu',
  'asr.compute_type': 'int8',
  'asr.api_key': MASK,
  'asr.base_url': 'http://127.0.0.1:9000/v1',
  'asr.diarization': 'false',
  'asr.num_speakers': '2',
};

class GatewayStub {
  meCalls = 0;

  redeemCalls = 0;

  me: () => Response = () =>
    jsonResponse(200, { plan: 'pro', expires_at: '2027-01-01T00:00:00Z' });

  redeemResponse: () => Response = () =>
    jsonResponse(200, {
      token: 'token-new',
      token_id: 'tok-2',
      plan: 'pro',
      expires_at: '2027-01-01T00:00:00Z',
    });

  readonly fetchImpl: typeof fetch;

  constructor() {
    this.fetchImpl = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/v1/me')) {
        this.meCalls += 1;
        return Promise.resolve(this.me());
      }
      this.redeemCalls += 1;
      return Promise.resolve(this.redeemResponse());
    });
  }
}

interface RpcCall {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

interface HarnessOptions {
  /** 覆盖某次 RPC：返回 undefined 时落到默认实现（便于只拦截关心的调用）。 */
  readonly rpc?: (method: string, params: Record<string, unknown>) => Promise<unknown> | undefined;
  readonly initialRecord?: ActivationRecord;
  readonly encryptionAvailable?: boolean;
  readonly settings?: Record<string, string>;
}

interface Harness {
  readonly service: ActivationService;
  readonly store: ActivationStore;
  readonly rpc: ReturnType<
    typeof vi.fn<(method: string, params: Record<string, unknown>) => Promise<unknown>>
  >;
  readonly calls: RpcCall[];
  readonly snapshots: ActivationSnapshot[];
  readonly gateway: GatewayStub;
  /** 可变：settings.get 返回同一对象，便于模拟用户中途改配置。 */
  readonly settings: Record<string, string>;
  advance(ms: number): void;
}

const cleanups: string[] = [];
const services: ActivationService[] = [];

function makeHarness(options: HarnessOptions = {}): Harness {
  const root = mkdtempSync(path.join(tmpdir(), 'dramaclip-managed-asr-'));
  cleanups.push(root);
  const filePath = path.join(root, 'activation.json');
  const store = new ActivationStore({
    filePath,
    safeStorage: fakeSafeStorage(options.encryptionAvailable ?? true),
  });
  if (options.initialRecord !== undefined) store.save(options.initialRecord);
  const settings = { ...(options.settings ?? managedSettings()) };
  const calls: RpcCall[] = [];
  const rpc = vi.fn<(method: string, params: Record<string, unknown>) => Promise<unknown>>();
  rpc.mockImplementation(async (method, params) => {
    calls.push({ method, params });
    const override = options.rpc?.(method, params);
    if (override !== undefined) return override;
    if (method === 'engine_configs.list') {
      const domain = String(params.domain);
      return {
        configs: [{ id: domain === 'asr_cloud' ? 'cfg-asr' : 'cfg-llm', domain, enabled: 1 }],
      };
    }
    if (method === 'settings.get') return settings;
    return { ok: true };
  });
  let nowMs = NOW_MS;
  const snapshots: ActivationSnapshot[] = [];
  const gateway = new GatewayStub();
  const service = new ActivationService({
    store,
    gatewayUrl: GATEWAY,
    rpc,
    onChange: (snapshot) => {
      snapshots.push(snapshot);
    },
    hostname: 'test-device',
    now: () => nowMs,
    random: () => 0,
    env: {},
    fetchOptions: { fetchImpl: gateway.fetchImpl },
  });
  services.push(service);
  return {
    service,
    store,
    rpc,
    calls,
    snapshots,
    gateway,
    settings,
    advance: (ms) => {
      nowMs += ms;
    },
  };
}

function settingsUpdateCalls(h: Harness): RpcCall[] {
  return h.calls.filter((call) => call.method === 'settings.update');
}

function valuesOf(call: RpcCall | undefined): Record<string, string> | undefined {
  const values = call?.params.values;
  if (typeof values !== 'object' || values === null) return undefined;
  return values as Record<string, string>;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const service of services.splice(0)) service.stop();
  vi.useRealTimers();
  for (const root of cleanups.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('激活写入 7 个托管键（4.1）', () => {
  it('先记录/清空两域启用行，再单次写 llm 三键 + asr 四键', async () => {
    const h = makeHarness();

    const result = await h.service.redeem('ACT-CODE-1234');

    expect(result.ok).toBe(true);
    const updates = settingsUpdateCalls(h);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.params).toEqual({
      values: {
        'llm.base_url': MANAGED_BASE_URL,
        'llm.model': 'default',
        'llm.api_key': 'token-new',
        'asr.engine': 'cloud_gateway',
        'asr.base_url': MANAGED_BASE_URL,
        'asr.api_key': 'token-new',
        'asr.model': 'fun-asr-flash',
      },
    });
    const cleared = h.calls
      .filter((call) => call.method === 'engine_configs.enable')
      .map((call) => call.params);
    expect(cleared).toEqual([
      { domain: 'llm', local: true },
      { domain: 'asr_cloud', local: true },
    ]);
    // 先读（list/list/settings.get）→ 再清空 → 最后写设置
    const methods = h.calls.map((call) => call.method);
    expect(methods.indexOf('settings.get')).toBeLessThan(methods.indexOf('engine_configs.enable'));
    expect(methods.lastIndexOf('engine_configs.enable')).toBeLessThan(
      methods.indexOf('settings.update'),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(h.service.getSnapshot().status).toBe('active');
  });
});

describe('激活失败逆序回滚（4.1/4.7）', () => {
  it('settings 写入失败：写回 prior asr.*（跳过掩码 api_key）→ 重启用 asr_cloud 行 → 重启用 llm 行', async () => {
    let updates = 0;
    const h = makeHarness({
      settings: PRIOR_SETTINGS,
      rpc: (method) => {
        if (method !== 'settings.update') return undefined;
        updates += 1;
        // 第一次是激活写入（失败），后续是回滚写入（成功）
        return updates === 1 ? Promise.reject(new Error('settings locked')) : Promise.resolve({ ok: true });
      },
    });

    const result = await h.service.redeem('ACT-CODE-1234');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('恢复');
    expect(h.store.load()).toBeNull();
    const written = settingsUpdateCalls(h);
    expect(written).toHaveLength(2);
    expect(valuesOf(written[1])).toEqual({
      'asr.engine': 'faster_whisper',
      'asr.model': 'large-v3',
      'asr.device': 'cpu',
      'asr.compute_type': 'int8',
      'asr.base_url': 'http://127.0.0.1:9000/v1',
      'asr.diarization': 'false',
      'asr.num_speakers': '2',
    });
    // 掩码回写等于「保持现值」，且会抹掉用户原有 BYO Key，必须跳过
    expect(valuesOf(written[1])?.['asr.api_key']).toBeUndefined();
    const enableIds = h.calls
      .filter((call) => call.method === 'engine_configs.enable' && call.params.id !== undefined)
      .map((call) => call.params.id);
    expect(enableIds).toEqual(['cfg-asr', 'cfg-llm']);
    const rollbackIndex = h.calls.findIndex(
      (call) =>
        call.method === 'settings.update' &&
        valuesOf(call)?.['asr.engine'] === 'faster_whisper',
    );
    const asrRowIndex = h.calls.findIndex(
      (call) => call.method === 'engine_configs.enable' && call.params.id === 'cfg-asr',
    );
    const llmRowIndex = h.calls.findIndex(
      (call) => call.method === 'engine_configs.enable' && call.params.id === 'cfg-llm',
    );
    expect(rollbackIndex).toBeLessThan(asrRowIndex);
    expect(asrRowIndex).toBeLessThan(llmRowIndex);
  });

  it('清空 asr_cloud 启用行失败：settings 未写，只恢复原启用行', async () => {
    const h = makeHarness({
      rpc: (method, params) => {
        if (method !== 'engine_configs.enable') return undefined;
        if (params.domain === 'asr_cloud' && params.id === undefined) {
          return Promise.reject(new Error('engine center offline'));
        }
        return Promise.resolve({ ok: true });
      },
    });

    const result = await h.service.redeem('ACT-CODE-1234');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('已恢复原引擎配置');
    expect(result.message).toContain('engine center offline');
    expect(settingsUpdateCalls(h)).toHaveLength(0);
    const enableIds = h.calls
      .filter((call) => call.method === 'engine_configs.enable' && call.params.id !== undefined)
      .map((call) => call.params.id);
    expect(enableIds).toEqual(['cfg-asr', 'cfg-llm']);
    expect(h.store.load()).toBeNull();
    expect(h.service.getSnapshot().status).toBe('inactive');
  });

  it('settings.get 失败：不盲写、不清启用行、不落凭证', async () => {
    const h = makeHarness({
      rpc: (method) =>
        method === 'settings.get' ? Promise.reject(new Error('rpc closed')) : undefined,
    });

    const result = await h.service.redeem('ACT-CODE-1234');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('中止激活');
    expect(h.calls.map((call) => call.method)).toEqual([
      'engine_configs.list',
      'engine_configs.list',
      'settings.get',
    ]);
    expect(h.store.load()).toBeNull();
  });

  it('凭证落盘失败：写回 prior asr.* 并恢复两域原启用行', async () => {
    const h = makeHarness({ settings: PRIOR_SETTINGS, encryptionAvailable: false });

    const result = await h.service.redeem('ACT-CODE-1234');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('安全存储不可用');
    const written = settingsUpdateCalls(h);
    // 激活写 1 次 + 回滚恢复 asr.* 1 次
    expect(written).toHaveLength(2);
    expect(valuesOf(written[1])?.['asr.engine']).toBe('faster_whisper');
    expect(valuesOf(written[1])?.['asr.api_key']).toBeUndefined();
    const enableIds = h.calls
      .filter((call) => call.method === 'engine_configs.enable' && call.params.id !== undefined)
      .map((call) => call.params.id);
    expect(enableIds).toEqual(['cfg-asr', 'cfg-llm']);
    expect(h.store.load()).toBeNull();
  });
});

describe('心跳自动重兑换的令牌同步（4.2）', () => {
  it('仍托管：一次同步 llm.api_key 与 asr.api_key，不改引擎/模型/端点', async () => {
    const h = makeHarness({ initialRecord: record() });
    h.gateway.me = () => jsonResponse(401, { error: { code: 'invalid_token' } });

    h.service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.service.getSnapshot().status).toBe('active');
    expect(h.store.load()?.token).toBe('token-new');
    const updates = settingsUpdateCalls(h);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.params).toEqual({
      values: { 'llm.api_key': 'token-new', 'asr.api_key': 'token-new' },
    });
  });

  it('识别已切回本地：只同步 llm.api_key', async () => {
    const h = makeHarness({ initialRecord: record() });
    h.service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.service.getSnapshot().status).toBe('active');

    h.settings['asr.engine'] = 'faster_whisper';
    h.settings['asr.api_key'] = '';
    h.gateway.me = () => jsonResponse(401, { error: { code: 'invalid_token' } });
    const snapshot = await h.service.status(true);

    expect(snapshot.status).toBe('active');
    const updates = settingsUpdateCalls(h);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.params).toEqual({ values: { 'llm.api_key': 'token-new' } });
  });

  it('读取设置失败：只同步 llm.api_key，不把重兑换判失败', async () => {
    let settingsGetFails = false;
    const h = makeHarness({
      initialRecord: record(),
      rpc: (method) =>
        method === 'settings.get' && settingsGetFails
          ? Promise.reject(new Error('rpc closed'))
          : undefined,
    });
    h.service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.service.getSnapshot().status).toBe('active');

    settingsGetFails = true;
    h.gateway.me = () => jsonResponse(401, { error: { code: 'invalid_token' } });
    const snapshot = await h.service.status(true);

    expect(snapshot.status).toBe('active');
    expect(h.store.load()?.token).toBe('token-new');
    const updates = settingsUpdateCalls(h);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.params).toEqual({ values: { 'llm.api_key': 'token-new' } });
  });
});
