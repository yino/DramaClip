// @vitest-environment node
/** 存量激活升级为托管 ASR 的启动门禁（add-cloud-asr-gateway 4.2）。
 *
 * 断言口径（specs/desktop-activation）：
 * - 记录存在但 asr.engine 不是 cloud_gateway（旧版本本地 / 自备云端引擎）时，
 *   必须停止心跳、清除托管 llm.api_key/asr.api_key、删除加密记录并进入 inactive；
 * - 清理任一步失败、或 settings.get 失败时同样保持 inactive 门禁，绝不回到主界面；
 * - 不得自动补齐、推断或改写本地引擎，也不得触碰 engine_configs；
 * - 新装无记录、或记录已是 cloud_gateway 时正常启动。
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
import {
  ActivationStore,
  ActivationStoreError,
} from '../../../../main/services/activation-store';
import { ActivationService } from '../../../../main/services/activation-service';

const GATEWAY = 'http://gw.test';
const NOW_MS = 1_700_000_000_000;
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

function managedSettings(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    'llm.base_url': `${GATEWAY}/v1`,
    'llm.api_key': MASK,
    'llm.model': 'default',
    'asr.engine': 'cloud_gateway',
    'asr.model': 'fun-asr-flash',
    'asr.base_url': `${GATEWAY}/v1`,
    'asr.api_key': MASK,
    ...overrides,
  };
}

function localEngineSettings(): Record<string, string> {
  return {
    'llm.base_url': 'https://old-llm.example/v1',
    'llm.api_key': MASK,
    'llm.model': 'gpt-4o',
    'asr.engine': 'faster_whisper',
    'asr.model': 'funasr',
    'asr.base_url': '',
    'asr.api_key': '',
  };
}

/** 模拟删除激活记录失败（凭证无法从安全存储清除）。 */
class ClearFailingStore extends ActivationStore {
  override clear(): void {
    throw new ActivationStoreError('模拟删除激活凭证失败');
  }
}

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
  readonly rpc?: (method: string, params: Record<string, unknown>) => Promise<unknown> | undefined;
  readonly initialRecord?: ActivationRecord;
  readonly encryptionAvailable?: boolean;
  readonly clearFails?: boolean;
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
  readonly settings: Record<string, string>;
  advance(ms: number): void;
}

const cleanups: string[] = [];
const services: ActivationService[] = [];

function makeHarness(options: HarnessOptions = {}): Harness {
  const root = mkdtempSync(path.join(tmpdir(), 'dramaclip-managed-asr-upgrade-'));
  cleanups.push(root);
  const filePath = path.join(root, 'activation.json');
  const safeStorage = fakeSafeStorage(options.encryptionAvailable ?? true);
  const store: ActivationStore =
    options.clearFails === true
      ? new ClearFailingStore({ filePath, safeStorage })
      : new ActivationStore({ filePath, safeStorage });
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

function engineConfigCalls(h: Harness): RpcCall[] {
  return h.calls.filter((call) => call.method.startsWith('engine_configs.'));
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const service of services.splice(0)) service.stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const root of cleanups.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('启动门禁：无激活记录（新装）', () => {
  it('直接 inactive，不读设置、不发心跳', async () => {
    const h = makeHarness();

    h.service.start();

    expect(h.service.getSnapshot().status).toBe('inactive');
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.gateway.meCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.service.getSnapshot().status).toBe('inactive');
  });
});

describe('启动门禁：记录已是 cloud_gateway', () => {
  it('正常校验并进入 active，不改写任何设置或引擎行', async () => {
    const h = makeHarness({ initialRecord: record() });

    h.service.start();

    expect(h.service.getSnapshot().status).toBe('verifying');
    await vi.advanceTimersByTimeAsync(0);

    expect(h.service.getSnapshot().status).toBe('active');
    expect(h.gateway.meCalls).toBe(1);
    expect(h.calls.some((call) => call.method === 'settings.get')).toBe(true);
    expect(settingsUpdateCalls(h)).toHaveLength(0);
    expect(engineConfigCalls(h)).toHaveLength(0);
  });
});

describe('启动门禁：存量记录不是 cloud_gateway（强制重新激活）', () => {
  it('停心跳、清两个托管密钥、删记录、进入 inactive，全程不 active', async () => {
    const h = makeHarness({ initialRecord: record(), settings: localEngineSettings() });

    h.service.start();
    expect(h.service.getSnapshot().status).toBe('verifying');
    await vi.advanceTimersByTimeAsync(0);

    expect(h.service.getSnapshot().status).toBe('inactive');
    expect(h.service.getSnapshot().maskedCode).toBe('');
    expect(h.store.load()).toBeNull();
    const updates = settingsUpdateCalls(h);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.params).toEqual({ values: { 'llm.api_key': '', 'asr.api_key': '' } });
    // 不得自动补齐/推断/改写本地引擎
    expect(engineConfigCalls(h)).toHaveLength(0);
    expect(h.gateway.meCalls).toBe(0);
    expect(h.snapshots.every((snapshot) => snapshot.status !== 'active')).toBe(true);
  });

  it('清理托管密钥失败：仍保持 inactive，记录照样删除', async () => {
    const h = makeHarness({
      initialRecord: record(),
      settings: localEngineSettings(),
      rpc: (method) =>
        method === 'settings.update' ? Promise.reject(new Error('settings locked')) : undefined,
    });

    h.service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.service.getSnapshot().status).toBe('inactive');
    expect(h.store.load()).toBeNull();
    expect(settingsUpdateCalls(h)).toHaveLength(1);
    expect(h.gateway.meCalls).toBe(0);
    expect(h.snapshots.every((snapshot) => snapshot.status !== 'active')).toBe(true);
  });

  it('删除激活记录失败：仍保持 inactive 门禁并提示，磁盘记录保留', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = makeHarness({
      initialRecord: record(),
      settings: localEngineSettings(),
      clearFails: true,
    });

    h.service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.service.getSnapshot().status).toBe('inactive');
    expect(h.store.load()).not.toBeNull();
    expect(h.gateway.meCalls).toBe(0);
    expect(h.snapshots.every((snapshot) => snapshot.status !== 'active')).toBe(true);
    expect(
      errorSpy.mock.calls.some((args) => String(args[0]).includes('保持激活门禁')),
    ).toBe(true);
  });

  it('settings.get 失败：无法确认引擎，同样保持 inactive 并尽力清理', async () => {
    const h = makeHarness({
      initialRecord: record(),
      settings: localEngineSettings(),
      rpc: (method) =>
        method === 'settings.get' ? Promise.reject(new Error('rpc closed')) : undefined,
    });

    h.service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.service.getSnapshot().status).toBe('inactive');
    expect(h.store.load()).toBeNull();
    const updates = settingsUpdateCalls(h);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.params).toEqual({ values: { 'llm.api_key': '', 'asr.api_key': '' } });
    expect(h.gateway.meCalls).toBe(0);
    expect(h.snapshots.every((snapshot) => snapshot.status !== 'active')).toBe(true);
  });

  it('门禁失败后用户可重新激活：写 7 键并恢复 active', async () => {
    const h = makeHarness({ initialRecord: record(), settings: localEngineSettings() });
    h.service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.service.getSnapshot().status).toBe('inactive');

    const result = await h.service.redeem('ACT-CODE-1234');
    await vi.advanceTimersByTimeAsync(0);

    expect(result.ok).toBe(true);
    expect(h.service.getSnapshot().status).toBe('active');
    expect(h.store.load()?.token).toBe('token-new');
    const updates = settingsUpdateCalls(h);
    expect(updates).toHaveLength(2);
    expect(Object.keys((updates[1]?.params.values ?? {}) as Record<string, string>)).toHaveLength(7);
  });
});

describe('新装首次激活成为托管记录', () => {
  it('无记录 active 门禁下兑换成功，写 7 键且状态为 active', async () => {
    const h = makeHarness();
    h.service.start();
    expect(h.service.getSnapshot().status).toBe('inactive');

    const result = await h.service.redeem('ACT-CODE-1234');
    await vi.advanceTimersByTimeAsync(0);

    expect(result.ok).toBe(true);
    expect(h.service.getSnapshot().status).toBe('active');
    expect(h.gateway.redeemCalls).toBe(1);
    expect(h.gateway.meCalls).toBe(1);
    expect(h.store.load()?.token).toBe('token-new');
    const updates = settingsUpdateCalls(h);
    expect(updates).toHaveLength(1);
    expect(Object.keys((updates[0]?.params.values ?? {}) as Record<string, string>).sort()).toEqual(
      [
        'asr.api_key',
        'asr.base_url',
        'asr.engine',
        'asr.model',
        'llm.api_key',
        'llm.base_url',
        'llm.model',
      ],
    );
  });
});
