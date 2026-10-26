// @vitest-environment node
/** 解绑时的托管 ASR 配置归属清理（add-cloud-asr-gateway 4.3）。
 *
 * 断言口径（specs/desktop-activation）：
 * - 解绑必须删除安全存储中的激活凭证；
 * - 只有仍等于托管写入值的 llm.* 与 asr.base_url/asr.api_key 才清除，
 *   保留 asr.engine/asr.model 供用户手动回退，绝不覆盖用户手改的配置；
 * - 不恢复引擎启用行、不删除本地模型配置。
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

class GatewayStub {
  meCalls = 0;

  redeemCalls = 0;

  me: () => Response = () =>
    jsonResponse(200, { plan: 'pro', expires_at: '2027-01-01T00:00:00Z' });

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
      return Promise.resolve(
        jsonResponse(200, {
          token: 'token-new',
          token_id: 'tok-2',
          plan: 'pro',
          expires_at: '2027-01-01T00:00:00Z',
        }),
      );
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
  readonly settings?: Record<string, string>;
}

interface Harness {
  readonly service: ActivationService;
  readonly store: ActivationStore;
  readonly calls: RpcCall[];
  readonly snapshots: ActivationSnapshot[];
  readonly gateway: GatewayStub;
  /** 可变：settings.get 返回同一对象，便于模拟用户在托管期间手改配置。 */
  readonly settings: Record<string, string>;
  advance(ms: number): void;
}

const cleanups: string[] = [];
const services: ActivationService[] = [];

function makeHarness(options: HarnessOptions = {}): Harness {
  const root = mkdtempSync(path.join(tmpdir(), 'dramaclip-managed-asr-unbind-'));
  cleanups.push(root);
  const filePath = path.join(root, 'activation.json');
  const store = new ActivationStore({
    filePath,
    safeStorage: fakeSafeStorage(true),
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

function valuesOf(call: RpcCall | undefined): Record<string, string> | undefined {
  const values = call?.params.values;
  if (typeof values !== 'object' || values === null) return undefined;
  return values as Record<string, string>;
}

async function activatedHarness(options: HarnessOptions = {}): Promise<Harness> {
  const h = makeHarness({ initialRecord: record(), ...options });
  h.service.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(h.service.getSnapshot().status).toBe('active');
  return h;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const service of services.splice(0)) service.stop();
  vi.useRealTimers();
  for (const root of cleanups.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('解绑：配置仍为托管写入值', () => {
  it('清 5 个键（llm 三键 + asr.base_url/api_key），保留 asr.engine/model，删凭证并停心跳', async () => {
    const h = await activatedHarness();
    const meCallsWhileActive = h.gateway.meCalls;

    const result = await h.service.unbind();

    expect(result.ok).toBe(true);
    const updates = settingsUpdateCalls(h);
    expect(updates).toHaveLength(1);
    const cleared = valuesOf(updates[0]);
    expect(cleared).toEqual({
      'llm.base_url': '',
      'llm.api_key': '',
      'llm.model': '',
      'asr.base_url': '',
      'asr.api_key': '',
    });
    // 引擎与模型保留，供用户手动回退
    expect(cleared?.['asr.engine']).toBeUndefined();
    expect(cleared?.['asr.model']).toBeUndefined();
    // 不恢复启用行、不删本地模型
    expect(engineConfigCalls(h)).toHaveLength(0);
    expect(h.store.load()).toBeNull();
    expect(h.service.getSnapshot().status).toBe('inactive');
    expect(h.service.getSnapshot().maskedCode).toBe('');
    // 心跳已停：15 分钟内不再触网
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(h.gateway.meCalls).toBe(meCallsWhileActive);
  });
});

describe('解绑：用户已把配置改回本地', () => {
  it('不写 settings、不恢复启用行，只删除激活凭证', async () => {
    const h = await activatedHarness();
    h.settings['llm.base_url'] = 'https://custom.example/v1';
    h.settings['llm.model'] = 'gpt-4o';
    h.settings['asr.engine'] = 'faster_whisper';
    h.settings['asr.model'] = 'funasr';
    h.settings['asr.base_url'] = '';
    h.settings['asr.api_key'] = '';

    const result = await h.service.unbind();

    expect(result.ok).toBe(true);
    expect(settingsUpdateCalls(h)).toHaveLength(0);
    expect(engineConfigCalls(h)).toHaveLength(0);
    expect(h.store.load()).toBeNull();
    expect(h.service.getSnapshot().status).toBe('inactive');
  });
});

describe('解绑：只有部分键仍为托管值', () => {
  it('llm.base_url 被手改时不清 LLM，三键保留，只清仍托管的 ASR 两个键', async () => {
    const h = await activatedHarness();
    h.settings['llm.base_url'] = 'https://custom.example/v1';

    const result = await h.service.unbind();

    expect(result.ok).toBe(true);
    const updates = settingsUpdateCalls(h);
    expect(updates).toHaveLength(1);
    expect(valuesOf(updates[0])).toEqual({ 'asr.base_url': '', 'asr.api_key': '' });
    expect(h.store.load()).toBeNull();
  });

  it('asr.base_url 被手改但引擎仍托管时至少清除 asr.api_key', async () => {
    const h = await activatedHarness();
    h.settings['llm.base_url'] = 'https://custom.example/v1';
    h.settings['llm.model'] = 'gpt-4o';
    h.settings['asr.base_url'] = 'http://localhost:9000/v1';

    const result = await h.service.unbind();

    expect(result.ok).toBe(true);
    const updates = settingsUpdateCalls(h);
    expect(updates).toHaveLength(1);
    expect(valuesOf(updates[0])).toEqual({ 'asr.api_key': '' });
    expect(h.store.load()).toBeNull();
  });
});

describe('解绑：读取设置失败', () => {
  it('凭证仍删除并进入 inactive，返回提示且不盲写设置', async () => {
    let settingsGetFails = false;
    const h = await activatedHarness({
      rpc: (method) =>
        method === 'settings.get' && settingsGetFails
          ? Promise.reject(new Error('rpc closed'))
          : undefined,
    });
    settingsGetFails = true;

    const result = await h.service.unbind();

    expect(result.ok).toBe(true);
    expect(result.message).toContain('托管配置未清空');
    expect(settingsUpdateCalls(h)).toHaveLength(0);
    expect(engineConfigCalls(h)).toHaveLength(0);
    expect(h.store.load()).toBeNull();
    expect(h.service.getSnapshot().status).toBe('inactive');
  });
});
