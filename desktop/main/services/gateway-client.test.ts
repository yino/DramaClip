// @vitest-environment node
/** 网关客户端单测（desktop-activation 7.1）：全部走注入的 fetch 桩，绝不发真实网络请求。 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GATEWAY_URL,
  GatewayUrlError,
  describeRedeemFailure,
  fetchMe,
  gatewayClient,
  normalizeGatewayUrl,
  resolveGatewayUrl,
} from './gateway-client';

const GATEWAY = 'http://127.0.0.1:8000';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

/** 典型成功响应：兑换带 token/plan/expires_at。 */
function redeemOkBody(): Record<string, unknown> {
  return {
    token: 'device-token-secret',
    token_id: 'tok-1',
    plan: 'pro',
    expires_at: '2027-01-01T00:00:00Z',
  };
}

describe('redeem（POST /v1/activation/redeem）', () => {
  it('200：返回设备令牌与套餐，请求带 code/device_label 且不带 Authorization', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValue(jsonResponse(200, redeemOkBody()));

    const result = await gatewayClient.redeem(GATEWAY, 'CODE-1234', 'macbook', { fetchImpl });

    expect(result).toMatchObject({
      ok: true,
      token: 'device-token-secret',
      tokenId: 'tok-1',
      plan: 'pro',
      expiresAt: '2027-01-01T00:00:00Z',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0] ?? [];
    expect(call[0]).toBe(`${GATEWAY}/v1/activation/redeem`);
    const init = call[1];
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ code: 'CODE-1234', device_label: 'macbook' }));
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBeUndefined();
  });

  it('401 token_superseded：保留错误码，不抛异常', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValue(
      jsonResponse(401, { error: { code: 'token_superseded', message: '已在其他设备使用' } }),
    );

    const result = await gatewayClient.redeem(GATEWAY, 'CODE-1234', 'pc', { fetchImpl });

    expect(result).toMatchObject({ ok: false, kind: 'http', status: 401, code: 'token_superseded' });
  });

  it('401 invalid_activation_code：映射成可读的 401 提示', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValue(jsonResponse(401, { error: { code: 'invalid_activation_code' } }));

    const result = await gatewayClient.redeem(GATEWAY, 'CODE-1234', 'pc', { fetchImpl });

    expect(result).toMatchObject({ ok: false, status: 401, code: 'invalid_activation_code' });
    if (!result.ok) {
      const text = describeRedeemFailure(result);
      expect(text).toContain('401');
      expect(text).toContain('激活码');
    }
  });

  it('403：错误码原样保留（停用/过期由服务映射）', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValue(
      jsonResponse(403, { error: { code: 'activation_disabled', message: '已停用' } }),
    );

    const result = await gatewayClient.redeem(GATEWAY, 'CODE-1234', 'pc', { fetchImpl });

    expect(result).toMatchObject({ ok: false, status: 403, code: 'activation_disabled' });
  });

  it('429：限流提示带 429，且不重试', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValue(jsonResponse(429, { error: { code: 'rate_limited' } }));

    const result = await gatewayClient.redeem(GATEWAY, 'CODE-1234', 'pc', { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, status: 429, code: 'rate_limited' });
    if (!result.ok) expect(describeRedeemFailure(result)).toContain('429');
  });

  it('5 秒超时：AbortController 中断后归为 timeout', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    );

    const result = await gatewayClient.redeem(GATEWAY, 'CODE-1234', 'pc', {
      fetchImpl,
      timeoutMs: 10,
    });

    expect(result).toMatchObject({ ok: false, kind: 'timeout', status: null });
    if (result.ok) throw new Error('预期失败结果');
    expect(describeRedeemFailure(result)).toContain('超时');
  });

  it('网络不可达：归为 network，不抛异常', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockRejectedValue(new TypeError('fetch failed'));

    const result = await gatewayClient.redeem(GATEWAY, 'CODE-1234', 'pc', { fetchImpl });

    expect(result).toMatchObject({ ok: false, kind: 'network' });
    if (!result.ok) expect(describeRedeemFailure(result)).toContain('无法连接');
  });

  it('200 但响应不是 JSON：归为 invalid_response', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValue(textResponse(200, '<html>gateway</html>'));

    const result = await gatewayClient.redeem(GATEWAY, 'CODE-1234', 'pc', { fetchImpl });

    expect(result).toMatchObject({ ok: false, kind: 'invalid_response', status: 200 });
  });

  it('200 但缺 token：归为 invalid_response（不写空令牌）', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValue(jsonResponse(200, { plan: 'pro' }));

    const result = await gatewayClient.redeem(GATEWAY, 'CODE-1234', 'pc', { fetchImpl });

    expect(result).toMatchObject({ ok: false, kind: 'invalid_response' });
  });
});

describe('fetchMe（GET /v1/me）', () => {
  it('200：Bearer 令牌放在 Authorization 头，返回套餐与到期', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValue(
      jsonResponse(200, { plan: 'pro', expires_at: '2027-02-02T00:00:00Z' }),
    );

    const result = await fetchMe(GATEWAY, 'device-token-secret', { fetchImpl });

    expect(result).toMatchObject({
      ok: true,
      plan: 'pro',
      expiresAt: '2027-02-02T00:00:00Z',
    });
    const call = fetchImpl.mock.calls[0] ?? [];
    expect(call[0]).toBe(`${GATEWAY}/v1/me`);
    expect(call[1]?.method).toBe('GET');
    const headers = call[1]?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe('Bearer device-token-secret');
  });

  it('401 token_superseded：保留 code 供心跳分流', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValue(jsonResponse(401, { error: { code: 'token_superseded' } }));

    const result = await fetchMe(GATEWAY, 'device-token-secret', { fetchImpl });

    expect(result).toMatchObject({ ok: false, status: 401, code: 'token_superseded' });
  });

  it('401 invalid_token：保留 code 供自动重兑换', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValue(jsonResponse(401, { error: { code: 'invalid_token' } }));

    const result = await fetchMe(GATEWAY, 'device-token-secret', { fetchImpl });

    expect(result).toMatchObject({ ok: false, status: 401, code: 'invalid_token' });
  });

  it('200 但 status=disabled：归为 403 activation_disabled', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValue(jsonResponse(200, { status: 'disabled' }));

    const result = await fetchMe(GATEWAY, 'device-token-secret', { fetchImpl });

    expect(result).toMatchObject({ ok: false, status: 403, code: 'activation_disabled' });
  });
});

describe('网关地址解析（D5：环境变量 → 资源文件 → 默认值）', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'dramaclip-gateway-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('默认值：三处都没有配置时用 127.0.0.1:8000', () => {
    const resolved = resolveGatewayUrl({
      env: {},
      isPackaged: false,
      resourcesPath: root,
      repoRoot: root,
    });
    expect(resolved).toEqual({ url: DEFAULT_GATEWAY_URL, source: 'default' });
    expect(DEFAULT_GATEWAY_URL).toBe('http://127.0.0.1:8000');
  });

  it('环境变量优先于资源文件', () => {
    mkdirSync(path.join(root, 'resources'));
    writeFileSync(
      path.join(root, 'resources', 'gateway.json'),
      JSON.stringify({ url: 'https://file.example.test' }),
    );
    const resolved = resolveGatewayUrl({
      env: { DRAMACLIP_GATEWAY_URL: 'https://env.example.test/' },
      isPackaged: false,
      resourcesPath: root,
      repoRoot: root,
    });
    expect(resolved).toEqual({ url: 'https://env.example.test', source: 'env' });
  });

  it('开发态回退到 repo/resources/gateway.json', () => {
    mkdirSync(path.join(root, 'resources'));
    writeFileSync(
      path.join(root, 'resources', 'gateway.json'),
      JSON.stringify({ gatewayUrl: 'http://192.168.1.10:9000' }),
    );
    const resolved = resolveGatewayUrl({
      env: {},
      isPackaged: false,
      resourcesPath: root,
      repoRoot: root,
    });
    expect(resolved).toMatchObject({ url: 'http://192.168.1.10:9000', source: 'resource' });
  });

  it('打包态读取 resources/app-resources/gateway.json', () => {
    mkdirSync(path.join(root, 'app-resources'));
    writeFileSync(
      path.join(root, 'app-resources', 'gateway.json'),
      JSON.stringify({ url: 'https://prod.example.test' }),
    );
    const resolved = resolveGatewayUrl({
      env: {},
      isPackaged: true,
      resourcesPath: root,
      repoRoot: '/nonexistent',
    });
    expect(resolved).toMatchObject({ url: 'https://prod.example.test', source: 'resource' });
  });

  it('非法环境变量（非 http/https）必须报错，不静默回退默认值', () => {
    expect(() =>
      resolveGatewayUrl({
        env: { DRAMACLIP_GATEWAY_URL: 'ftp://gateway.example.test' },
        isPackaged: false,
        resourcesPath: root,
        repoRoot: root,
      }),
    ).toThrow(GatewayUrlError);
  });

  it('归一化：拒绝内嵌凭据，去掉末尾斜杠', () => {
    expect(normalizeGatewayUrl('https://gw.example.test/v1/')).toBe('https://gw.example.test/v1');
    expect(() => normalizeGatewayUrl('https://user:pass@gw.example.test')).toThrow(GatewayUrlError);
    expect(() => normalizeGatewayUrl('file:///tmp/gateway.sock')).toThrow(GatewayUrlError);
  });
});
