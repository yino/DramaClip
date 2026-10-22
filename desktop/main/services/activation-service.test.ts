// @vitest-environment node
/** 激活服务单测（desktop-activation 8.1/8.2/8.3 + 7.4 守卫）：假 fetch + 假 RPC + 假时钟。 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivationSnapshot } from '@dramaclip/protocol';
import type { ActivationRecord, ActivationSafeStorage } from './activation-store';
import { ActivationStore } from './activation-store';
import { ActivationService, REDEEM_MIN_INTERVAL_MS } from './activation-service';

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

/** 网关桩：按 URL 分流 /v1/me 与 /v1/activation/redeem，记录调用次数。 */
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

interface Harness {
  readonly service: ActivationService;
  readonly store: ActivationStore;
  readonly rpc: ReturnType<
    typeof vi.fn<(method: string, params: Record<string, unknown>) => Promise<unknown>>
  >;
  readonly calls: RpcCall[];
  readonly snapshots: ActivationSnapshot[];
  readonly gateway: GatewayStub;
  advance(ms: number): void;
}

interface HarnessOptions {
  readonly rpc?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  readonly encryptionAvailable?: boolean;
  readonly initialRecord?: ActivationRecord;
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const root = mkdtempSync(path.join(tmpdir(), 'dramaclip-activation-svc-'));
  cleanups.push(root);
  const filePath = path.join(root, 'activation.json');
  const store = new ActivationStore({
    filePath,
    safeStorage: fakeSafeStorage(options.encryptionAvailable ?? true),
  });
  if (options.initialRecord !== undefined) store.save(options.initialRecord);
  const calls: RpcCall[] = [];
  const rpc = vi.fn<(method: string, params: Record<string, unknown>) => Promise<unknown>>();
  rpc.mockImplementation(async (method, params) => {
    calls.push({ method, params });
    if (options.rpc !== undefined) return options.rpc(method, params);
    if (method === 'engine_configs.list') {
      return { configs: [{ id: 'cfg-old', domain: 'llm', enabled: 1 }] };
    }
    if (method === 'settings.get') {
      return {
        'llm.base_url': MANAGED_BASE_URL,
        'llm.api_key': MASK,
        'llm.model': 'default',
      };
    }
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
    advance: (ms) => {
      nowMs += ms;
    },
  };
}

const cleanups: string[] = [];
const services: ActivationService[] = [];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const service of services.splice(0)) service.stop();
  vi.useRealTimers();
  for (const root of cleanups.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('激活流程顺序（8.1）', () => {
  it('兑换 → 清空 llm 启用行 → 写三项托管设置 → 落加密凭证', async () => {
    const h = makeHarness();

    const result = await h.service.redeem('ACT-CODE-1234');

    expect(result.ok).toBe(true);
    expect(h.calls.map((call) => call.method)).toEqual([
      'engine_configs.list',
      'engine_configs.enable',
      'settings.update',
    ]);
    expect(h.calls[1]?.params).toEqual({ domain: 'llm', local: true });
    expect(h.calls[2]?.params).toEqual({
      values: {
        'llm.api_key': 'token-new',
        'llm.base_url': MANAGED_BASE_URL,
        'llm.model': 'default',
      },
    });
    const saved = h.store.load();
    expect(saved).toMatchObject({ code: 'ACT-CODE-1234', token: 'token-new', plan: 'pro' });
    expect(saved?.token).not.toBeUndefined();

    await vi.advanceTimersByTimeAsync(0);
    expect(h.gateway.meCalls).toBe(1);
    expect(h.service.getSnapshot().status).toBe('active');
  });

  it('成功快照只含脱敏信息：没有令牌、没有激活码全文', async () => {
    const h = makeHarness();
    await h.service.redeem('ACT-CODE-1234');

    const snapshot = h.service.getSnapshot();
    expect(Object.keys(snapshot).sort()).toEqual([
      'expiresAt',
      'gatewayUrl',
      'lastVerifiedAt',
      'maskedCode',
      'plan',
      'status',
    ]);
    const text = JSON.stringify(snapshot);
    expect(text).not.toContain('token-new');
    expect(text).not.toContain('ACT-CODE-1234');
    expect(snapshot.maskedCode).toBe('••••1234');
  });

  it('激活码非法：直接拒绝，不发起任何网络/RPC', async () => {
    const h = makeHarness();

    for (const bad of ['', '   ', 'short', 42, 'x'.repeat(129)]) {
      const result = await h.service.redeem(bad as never);
      expect(result.ok).toBe(false);
      expect(result.message).toContain('8–128');
    }
    expect(h.gateway.redeemCalls).toBe(0);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('清空 llm 启用行失败：中止，不写 settings，不落凭证', async () => {
    const h = makeHarness({
      rpc: (method) =>
        method === 'engine_configs.enable'
          ? Promise.reject(new Error('service offline'))
          : Promise.resolve({ ok: true }),
    });

    const result = await h.service.redeem('ACT-CODE-1234');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('中止激活');
    expect(h.calls.some((call) => call.method === 'settings.update')).toBe(false);
    expect(h.store.load()).toBeNull();
  });

  it('settings 写入失败：恢复原启用行并删除激活文件', async () => {
    let enableRestored: unknown = null;
    const h = makeHarness({
      rpc: (method, params) => {
        if (method === 'engine_configs.list') {
          return Promise.resolve({ configs: [{ id: 'cfg-old', domain: 'llm', enabled: 1 }] });
        }
        if (method === 'settings.update') {
          return Promise.reject(new Error('settings locked'));
        }
        if (method === 'engine_configs.enable' && params.id !== undefined) {
          enableRestored = params.id;
        }
        return Promise.resolve({ ok: true });
      },
    });

    const result = await h.service.redeem('ACT-CODE-1234');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('恢复');
    expect(enableRestored).toBe('cfg-old');
    expect(h.store.load()).toBeNull();
  });

  it('凭证落盘失败（safeStorage 不可用）：不进入 active，并回滚引擎配置', async () => {
    const h = makeHarness({ encryptionAvailable: false });

    const result = await h.service.redeem('ACT-CODE-1234');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('安全存储不可用');
    expect(h.store.load()).toBeNull();
    expect(h.calls.some((call) => call.method === 'settings.update')).toBe(true);
  });
});

describe('启动恢复与自动重兑换守卫（7.4）', () => {
  it('启动读档 → verifying → 校验成功后 active', async () => {
    const h = makeHarness({ initialRecord: record() });

    h.service.start();
    expect(h.service.getSnapshot().status).toBe('verifying');
    await vi.advanceTimersByTimeAsync(0);

    expect(h.gateway.meCalls).toBe(1);
    expect(h.service.getSnapshot()).toMatchObject({ status: 'active', plan: 'pro' });
    expect(h.service.getSnapshot().maskedCode).toBe('••••9911');
  });

  it('401 invalid_token：距上次兑换 ≥10 分钟时自动重兑换一次并保持 active', async () => {
    const h = makeHarness({ initialRecord: record() });
    h.gateway.me = () => jsonResponse(401, { error: { code: 'invalid_token' } });

    h.service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.gateway.redeemCalls).toBe(1);
    expect(h.store.load()?.token).toBe('token-new');
    const autoUpdate = h.calls.find((call) => call.method === 'settings.update');
    expect(autoUpdate?.params).toEqual({ values: { 'llm.api_key': 'token-new' } });
    expect(h.service.getSnapshot().status).toBe('active');
  });

  it('自动重兑换会话一次：再次 401 不再兑换，进入 suspended(invalid_token)', async () => {
    const h = makeHarness({ initialRecord: record() });
    h.gateway.me = () => jsonResponse(401, { error: { code: 'invalid_token' } });
    h.service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.gateway.redeemCalls).toBe(1);

    // 超过 60 秒守卫窗口，但仍不足 10 分钟：只能靠「会话一次」拦住
    h.advance(2 * 60_000);
    h.gateway.me = () => jsonResponse(401, { error: { code: 'invalid_token' } });
    const snapshot = await h.service.status(true);

    expect(h.gateway.redeemCalls).toBe(1);
    expect(snapshot).toMatchObject({ status: 'suspended', reason: 'invalid_token' });
  });

  it('距上次兑换不足 10 分钟：不自动重兑换，直接 suspended(invalid_token)', async () => {
    const h = makeHarness({
      initialRecord: record({
        activatedAt: new Date(NOW_MS - 60_000).toISOString(),
      }),
    });
    h.gateway.me = () => jsonResponse(401, { error: { code: 'invalid_token' } });

    h.service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.gateway.redeemCalls).toBe(0);
    expect(h.service.getSnapshot()).toMatchObject({ status: 'suspended', reason: 'invalid_token' });
    expect(REDEEM_MIN_INTERVAL_MS).toBe(10 * 60_000);
  });

  it('兑换后 60 秒内再 401：按设备冲突处理，不自动重兑换', async () => {
    const h = makeHarness({
      initialRecord: record({ activatedAt: new Date(1_700_000_000_000 - 10_000).toISOString() }),
    });
    h.gateway.me = () => jsonResponse(401, { error: { code: 'invalid_token' } });

    h.service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.gateway.redeemCalls).toBe(0);
    expect(h.service.getSnapshot()).toMatchObject({
      status: 'suspended',
      reason: 'device_conflict',
    });
  });

  it('token_superseded：直接 suspended(device_conflict)，不重兑换', async () => {
    const h = makeHarness({ initialRecord: record() });
    h.gateway.me = () => jsonResponse(401, { error: { code: 'token_superseded' } });

    h.service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.gateway.redeemCalls).toBe(0);
    expect(h.service.getSnapshot()).toMatchObject({
      status: 'suspended',
      reason: 'device_conflict',
    });
  });

  it('403 disabled：suspended(disabled)，且心跳不写 llm.*', async () => {
    const h = makeHarness({ initialRecord: record() });
    h.gateway.me = () => jsonResponse(403, { error: { code: 'activation_disabled' } });

    h.service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.service.getSnapshot()).toMatchObject({ status: 'suspended', reason: 'disabled' });
    expect(h.calls.some((call) => call.method === 'settings.update')).toBe(false);
  });

  it('网络不可达：suspended(network)；恢复后自动回到 active', async () => {
    const h = makeHarness({ initialRecord: record() });
    h.gateway.me = () => {
      throw new TypeError('network down');
    };

    h.service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.service.getSnapshot()).toMatchObject({ status: 'suspended', reason: 'network' });

    // 退避 1 分钟后网络恢复
    h.gateway.me = () =>
      jsonResponse(200, { plan: 'pro', expires_at: '2027-01-01T00:00:00Z' });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(h.service.getSnapshot().status).toBe('active');
  });

  it('resume：已激活时立即补一次校验', async () => {
    const h = makeHarness({ initialRecord: record() });
    h.service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.gateway.meCalls).toBe(1);

    h.service.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.gateway.meCalls).toBe(2);
  });
});

describe('解绑（8.3/8.4）', () => {
  it('settings 仍是托管值：清空三项、删凭证、停表，且不恢复引擎启用行', async () => {
    const h = makeHarness({ initialRecord: record() });
    h.service.start();
    await vi.advanceTimersByTimeAsync(0);

    const result = await h.service.unbind();

    expect(result.ok).toBe(true);
    const clearCall = h.calls.find((call) => call.method === 'settings.update');
    expect(clearCall?.params).toEqual({
      values: { 'llm.base_url': '', 'llm.api_key': '', 'llm.model': '' },
    });
    expect(h.calls.some((call) => call.method === 'engine_configs.enable')).toBe(false);
    expect(h.store.load()).toBeNull();
    expect(h.service.getSnapshot().status).toBe('inactive');

    const before = h.gateway.meCalls;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.gateway.meCalls).toBe(before);
  });

  it('用户手改过 base_url：只删凭证，不清设置、不恢复引擎行', async () => {
    const h = makeHarness({
      initialRecord: record(),
      rpc: (method) =>
        method === 'settings.get'
          ? Promise.resolve({ 'llm.base_url': 'https://custom.example/v1', 'llm.model': 'gpt-4o' })
          : Promise.resolve({ ok: true }),
    });
    h.service.start();
    await vi.advanceTimersByTimeAsync(0);

    await h.service.unbind();

    expect(h.calls.some((call) => call.method === 'settings.update')).toBe(false);
    expect(h.calls.some((call) => call.method === 'engine_configs.enable')).toBe(false);
    expect(h.store.load()).toBeNull();
    expect(h.service.getSnapshot().status).toBe('inactive');
  });
});
