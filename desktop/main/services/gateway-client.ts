/** 激活网关客户端（desktop-activation D5/D13）。
 *
 * 只依赖全局 fetch + AbortController：每次请求 5 秒超时；按「网络 / 超时 / HTTP / 响应形状」
 * 分类返回可读错误。设备令牌只进 Authorization 头，本模块不打印任何凭证。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:8000';
export const GATEWAY_REQUEST_TIMEOUT_MS = 5_000;

/** 失败分类：网络不可达、超时、HTTP 错误、响应不是约定 JSON。 */
export type GatewayFailureKind = 'network' | 'timeout' | 'http' | 'invalid_response';

export interface GatewayFailure {
  readonly ok: false;
  readonly kind: GatewayFailureKind;
  /** HTTP 状态码；网络/超时为 null。 */
  readonly status: number | null;
  /** 服务端 error.code（invalid_token / token_superseded / activation_expired …），没有则为空串。 */
  readonly code: string;
  /** 可读中文原因（不含令牌/激活码）。 */
  readonly message: string;
}

/** 兑换成功：设备令牌与套餐信息。token 只交给调用方加密保存，禁止外传渲染层。 */
export interface RedeemSuccess {
  readonly ok: true;
  readonly token: string;
  readonly tokenId: string;
  readonly plan: string;
  readonly expiresAt: string;
}

/** 心跳校验成功：套餐/到期刷新。 */
export interface MeSuccess {
  readonly ok: true;
  readonly plan: string;
  readonly expiresAt: string;
}

export type GatewayResult<T> = T | GatewayFailure;

export interface GatewayRequestOptions {
  /** 测试注入；缺省用全局 fetch。 */
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

interface HttpResponse {
  readonly ok: true;
  readonly status: number;
  readonly parsed: boolean;
  readonly body: unknown;
}

function failure(
  kind: GatewayFailureKind,
  status: number | null,
  code: string,
  message: string,
): GatewayFailure {
  return { ok: false, kind, status, code, message };
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readServerError(body: unknown): { code: string; message: string } {
  if (!isRecordLike(body) || !isRecordLike(body.error)) return { code: '', message: '' };
  const { code, message } = body.error;
  return {
    code: typeof code === 'string' ? code : '',
    message: typeof message === 'string' ? message : '',
  };
}

function joinUrl(baseUrl: string, endpoint: string): string {
  return `${baseUrl.replace(/\/+$/u, '')}${endpoint}`;
}

/** 发一个 JSON 请求；网络/超时统一转成 GatewayFailure，永不抛出。 */
async function requestJson(
  url: string,
  init: RequestInit,
  options: GatewayRequestOptions,
): Promise<HttpResponse | GatewayFailure> {
  const fetcher = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? GATEWAY_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetcher(url, { ...init, signal: controller.signal });
    const raw = await response.text();
    let parsed = false;
    let body: unknown;
    if (raw.trim() !== '') {
      try {
        body = JSON.parse(raw);
        parsed = true;
      } catch {
        parsed = false;
      }
    }
    return { ok: true, status: response.status, parsed, body };
  } catch {
    if (controller.signal.aborted) {
      const seconds = Math.max(1, Math.round(timeoutMs / 1000));
      return failure('timeout', null, '', `连接激活网关超时（${String(seconds)} 秒）`);
    }
    return failure('network', null, '', '无法连接激活网关（网络不可用或地址不可达）');
  } finally {
    clearTimeout(timer);
  }
}

function redeemHttpFailure(status: number, body: unknown): GatewayFailure {
  const { code, message } = readServerError(body);
  const detail = message === '' ? '' : `：${message}`;
  switch (status) {
    case 400:
      return failure('http', status, code || 'invalid_request', `激活请求被网关拒绝（400）${detail}`);
    case 401:
      return failure(
        'http',
        status,
        code || 'invalid_activation_code',
        `激活码无效或已被停用（401）${detail}`,
      );
    case 403:
      return failure('http', status, code || 'activation_disabled', `激活码不可用（403）${detail}`);
    case 429:
      return failure('http', status, code || 'rate_limited', '激活请求过于频繁（429），请稍后再试');
    default:
      return failure(
        'http',
        status,
        code,
        status >= 500
          ? `激活网关暂时不可用（HTTP ${String(status)}）${detail}`
          : `激活网关返回异常（HTTP ${String(status)}）${detail}`,
      );
  }
}

function verifyHttpFailure(status: number, body: unknown): GatewayFailure {
  const { code, message } = readServerError(body);
  const detail = message === '' ? '' : `：${message}`;
  switch (status) {
    case 401:
      return failure(
        'http',
        status,
        code || 'invalid_token',
        `设备令牌无效或已被替代（401）${detail}`,
      );
    case 403:
      return failure('http', status, code || 'activation_disabled', `授权不可用（403）${detail}`);
    case 404:
      return failure('http', status, code || 'invalid_token', '网关不认识该设备令牌（404）');
    default:
      return failure(
        'http',
        status,
        code,
        status >= 500
          ? `授权网关暂时不可用（HTTP ${String(status)}）${detail}`
          : `授权校验失败（HTTP ${String(status)}）${detail}`,
      );
  }
}

function readRedeemSuccess(body: unknown): RedeemSuccess | null {
  if (!isRecordLike(body)) return null;
  const token = typeof body.token === 'string' ? body.token : '';
  if (token === '') return null;
  return {
    ok: true,
    token,
    tokenId: typeof body.token_id === 'string' ? body.token_id : '',
    plan: typeof body.plan === 'string' && body.plan !== '' ? body.plan : 'standard',
    expiresAt: typeof body.expires_at === 'string' ? body.expires_at : '',
  };
}

function readExpiresAt(body: Record<string, unknown>): string {
  if (typeof body.expires_at === 'string') return body.expires_at;
  return typeof body.expiresAt === 'string' ? body.expiresAt : '';
}

function readMeSuccess(body: unknown): MeSuccess | GatewayFailure | null {
  if (!isRecordLike(body)) return null;
  const status = typeof body.status === 'string' ? body.status : '';
  if (status === 'disabled') {
    return failure('http', 403, 'activation_disabled', '授权已被停用（403）');
  }
  if (status === 'expired') {
    return failure('http', 403, 'activation_expired', '授权已到期（403）');
  }
  return {
    ok: true,
    plan: typeof body.plan === 'string' && body.plan !== '' ? body.plan : 'standard',
    expiresAt: readExpiresAt(body),
  };
}

/** 把失败翻译成激活界面可直接展示的一句话（含 401/403/429/网络/超时提示）。 */
export function describeRedeemFailure(gatewayFailure: GatewayFailure): string {
  switch (gatewayFailure.kind) {
    case 'network':
      return '无法连接激活网关：请确认网络可用、网关地址正确后重试';
    case 'timeout':
      return '连接激活网关超时：请检查网络或稍后重试';
    case 'invalid_response':
      return `激活网关响应异常：${gatewayFailure.message}`;
    case 'http':
      if (gatewayFailure.status === 401) return '激活码无效或已被停用（401）：请核对后重试';
      if (gatewayFailure.status === 403) return gatewayFailure.message;
      if (gatewayFailure.status === 429) return '激活请求过于频繁（429）：请稍后再试';
      return gatewayFailure.message;
  }
}

/** 兑换设备令牌：POST /v1/activation/redeem。 */
export async function redeem(
  gatewayUrl: string,
  code: string,
  deviceLabel: string,
  options: GatewayRequestOptions = {},
): Promise<GatewayResult<RedeemSuccess>> {
  const response = await requestJson(
    joinUrl(gatewayUrl, '/v1/activation/redeem'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ code, device_label: deviceLabel }),
    },
    options,
  );
  if (!response.ok) return response;
  if (response.status < 200 || response.status >= 300) {
    return redeemHttpFailure(response.status, response.body);
  }
  if (!response.parsed) {
    return failure(
      'invalid_response',
      response.status,
      '',
      `激活网关返回了非 JSON 响应（HTTP ${String(response.status)}）`,
    );
  }
  const success = readRedeemSuccess(response.body);
  if (success === null) {
    return failure('invalid_response', response.status, '', '激活网关响应缺少设备令牌');
  }
  return success;
}

/** 心跳校验：GET /v1/me（Bearer 设备令牌）。 */
export async function fetchMe(
  gatewayUrl: string,
  token: string,
  options: GatewayRequestOptions = {},
): Promise<GatewayResult<MeSuccess>> {
  const response = await requestJson(
    joinUrl(gatewayUrl, '/v1/me'),
    {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    },
    options,
  );
  if (!response.ok) return response;
  if (response.status < 200 || response.status >= 300) {
    return verifyHttpFailure(response.status, response.body);
  }
  if (!response.parsed) {
    return failure(
      'invalid_response',
      response.status,
      '',
      `授权网关返回了非 JSON 响应（HTTP ${String(response.status)}）`,
    );
  }
  const result = readMeSuccess(response.body);
  if (result === null) return failure('invalid_response', response.status, '', '授权网关响应形状异常');
  return result;
}

export const gatewayClient = { redeem, fetchMe } as const;

// ---------------------------------------------------------------------------
// 网关地址解析（D5：环境变量 → 打包资源 gateway.json → 本地默认值）
// ---------------------------------------------------------------------------

export class GatewayUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayUrlError';
  }
}

export type GatewayUrlSource = 'env' | 'resource' | 'default';

export interface GatewayUrlResolution {
  readonly url: string;
  readonly source: GatewayUrlSource;
  /** 来自打包资源时给出文件路径，便于日志与排障。 */
  readonly file?: string;
}

export interface GatewayUrlOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly repoRoot: string;
}

/** 校验并归一化网关地址：只允许 http/https，去掉末尾斜杠，拒绝内嵌凭据。 */
export function normalizeGatewayUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') throw new GatewayUrlError('网关地址为空');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new GatewayUrlError(`网关地址不是合法 URL：${trimmed}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new GatewayUrlError(`网关地址必须使用 http:// 或 https://（收到 ${parsed.protocol}//）`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new GatewayUrlError('网关地址不能包含用户名或密码');
  }
  const pathname = parsed.pathname.replace(/\/+$/u, '');
  return `${parsed.origin}${pathname}`;
}

/** 打包资源里的 gateway.json 位置：electron-builder extraResources 落在 app-resources/。 */
function gatewayConfigCandidates(options: GatewayUrlOptions): readonly string[] {
  if (options.isPackaged) {
    return [
      path.join(options.resourcesPath, 'gateway.json'),
      path.join(options.resourcesPath, 'app-resources', 'gateway.json'),
    ];
  }
  return [path.join(options.repoRoot, 'resources', 'gateway.json')];
}

function readGatewayConfigFile(filePath: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : '未知错误';
    throw new GatewayUrlError(`无法读取网关配置 ${filePath}：${reason}`);
  }
  if (isRecordLike(parsed)) {
    const candidate = parsed.url ?? parsed.gatewayUrl;
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return normalizeGatewayUrl(candidate);
    }
  }
  throw new GatewayUrlError(`网关配置 ${filePath} 缺少合法的 url 字段`);
}

/** 解析网关地址：非法配置抛 GatewayUrlError（不静默回退到默认值）。 */
export function resolveGatewayUrl(options: GatewayUrlOptions): GatewayUrlResolution {
  const envUrl = options.env.DRAMACLIP_GATEWAY_URL;
  if (envUrl !== undefined && envUrl.trim() !== '') {
    return { url: normalizeGatewayUrl(envUrl), source: 'env' };
  }
  for (const candidate of gatewayConfigCandidates(options)) {
    if (!existsSync(candidate)) continue;
    return { url: readGatewayConfigFile(candidate), source: 'resource', file: candidate };
  }
  return { url: DEFAULT_GATEWAY_URL, source: 'default' };
}
