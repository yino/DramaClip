/** 激活凭证本地存储：<userData>/activation.json（safeStorage 加密、文件 0600）。
 *
 * 设计口径（desktop-activation D6 / Q2）：
 * - 激活码与设备令牌都只以密文落盘，文件里不出现明文；
 * - 系统安全存储不可用时**拒绝写入**并抛可行动错误，不降级成明文；
 * - 文件缺失、损坏、密钥迁移导致解密失败时安全降级为「未激活」，不阻塞启动。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const ACTIVATION_FILE_NAME = 'activation.json';

/** 激活凭证（码、令牌、套餐、到期、最近校验、设备标识）。 */
export interface ActivationRecord {
  readonly gatewayUrl: string;
  readonly code: string;
  readonly token: string;
  readonly tokenId: string;
  readonly plan: string;
  readonly expiresAt: string;
  readonly activatedAt: string;
  readonly lastVerifiedAt: string;
  readonly deviceLabel: string;
}

/** safeStorage 的最小依赖面：便于单测注入假实现，模块本身不直接依赖 electron。 */
export interface ActivationSafeStorage {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** 凭证读写失败（加密不可用/写盘失败/删除失败），message 可直接展示给用户。 */
export class ActivationStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActivationStoreError';
  }
}

export interface ActivationStoreOptions {
  readonly filePath: string;
  readonly safeStorage: ActivationSafeStorage;
}

/** 落盘信封：version 便于以后迁移，payload 是整条凭证的密文（base64）。 */
interface ActivationEnvelope {
  readonly version: number;
  readonly payload: string;
}

const FORMAT_VERSION = 1;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const ENCRYPTION_UNAVAILABLE =
  '系统安全存储不可用（safeStorage），无法保存激活凭证；请先解锁系统钥匙串/凭据管理器后重试';

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/** 严格校验字段形状：缺字段/类型不对的凭证一律视为无效（不猜测）。 */
function isActivationRecord(value: unknown): value is ActivationRecord {
  if (!isRecordLike(value)) return false;
  return (
    typeof value.gatewayUrl === 'string' &&
    isNonEmptyString(value.code) &&
    isNonEmptyString(value.token) &&
    typeof value.tokenId === 'string' &&
    typeof value.plan === 'string' &&
    typeof value.expiresAt === 'string' &&
    typeof value.activatedAt === 'string' &&
    typeof value.lastVerifiedAt === 'string' &&
    typeof value.deviceLabel === 'string'
  );
}

function isEnvelope(value: unknown): value is ActivationEnvelope {
  return (
    isRecordLike(value) &&
    value.version === FORMAT_VERSION &&
    typeof value.payload === 'string' &&
    value.payload !== ''
  );
}

/** 加密凭证存储。读写都做防御：坏文件不抛错，坏环境写盘要报错。 */
export class ActivationStore {
  readonly filePath: string;

  private readonly safeStorage: ActivationSafeStorage;

  constructor(options: ActivationStoreOptions) {
    this.filePath = options.filePath;
    this.safeStorage = options.safeStorage;
  }

  /** 读取凭证；缺失/损坏/解密失败返回 null（= 未激活）。 */
  load(): ActivationRecord | null {
    if (!existsSync(this.filePath)) return null;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (!isEnvelope(parsed)) return null;
      if (!this.safeStorage.isEncryptionAvailable()) {
        console.warn('[activation] 系统安全存储不可用，已保存的激活凭证按未激活处理');
        return null;
      }
      const plain = this.safeStorage.decryptString(Buffer.from(parsed.payload, 'base64'));
      const record: unknown = JSON.parse(plain);
      return isActivationRecord(record) ? record : null;
    } catch {
      // 文件损坏、密钥迁移、权限异常：降级为未激活，启动不因凭证文件失败
      console.warn('[activation] 激活文件无法读取或解密，按未激活处理');
      return null;
    }
  }

  /** 原子写入（临时文件 + rename），文件权限 0600；加密不可用时拒绝写入。 */
  save(record: ActivationRecord): void {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new ActivationStoreError(ENCRYPTION_UNAVAILABLE);
    }
    let encrypted: Buffer;
    try {
      encrypted = this.safeStorage.encryptString(JSON.stringify(record));
    } catch {
      throw new ActivationStoreError('系统安全存储加密失败，无法保存激活凭证；请检查钥匙串权限后重试');
    }
    if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) {
      throw new ActivationStoreError('系统安全存储返回了空密文，已中止保存激活凭证');
    }
    const envelope: ActivationEnvelope = {
      version: FORMAT_VERSION,
      payload: encrypted.toString('base64'),
    };
    const directory = path.dirname(this.filePath);
    const tempPath = `${this.filePath}.tmp`;
    try {
      mkdirSync(directory, { recursive: true, mode: DIR_MODE });
      writeFileSync(tempPath, JSON.stringify(envelope), { encoding: 'utf8', mode: FILE_MODE });
      chmodSync(tempPath, FILE_MODE);
      renameSync(tempPath, this.filePath);
      chmodSync(this.filePath, FILE_MODE);
    } catch (error) {
      try {
        rmSync(tempPath, { force: true });
      } catch {
        // 清理临时文件失败不掩盖真正的写盘错误
      }
      const reason = error instanceof Error ? error.message : '未知错误';
      throw new ActivationStoreError(`激活凭证写入失败：${reason}`);
    }
  }

  /** 删除凭证（解绑）；文件不存在视为已删除。 */
  clear(): void {
    for (const target of [this.filePath, `${this.filePath}.tmp`]) {
      try {
        rmSync(target, { force: true });
      } catch (error) {
        const reason = error instanceof Error ? error.message : '未知错误';
        throw new ActivationStoreError(`激活凭证删除失败：${reason}`);
      }
    }
  }
}
