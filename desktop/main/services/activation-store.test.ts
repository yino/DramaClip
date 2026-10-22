// @vitest-environment node
/** 激活凭证存储单测（desktop-activation 7.2）：真实临时目录 + 假 safeStorage，断言磁盘无明文。 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ACTIVATION_FILE_NAME,
  ActivationStore,
  ActivationStoreError,
  type ActivationRecord,
  type ActivationSafeStorage,
} from './activation-store';

/** 假加密：base64 包一层，足以让「文件里没有明文」可断言。 */
function fakeSafeStorage(available = true): ActivationSafeStorage & {
  encryptCalls: number;
  decryptCalls: number;
} {
  const state = {
    encryptCalls: 0,
    decryptCalls: 0,
    isEncryptionAvailable: (): boolean => available,
    encryptString: (plainText: string): Buffer => {
      state.encryptCalls += 1;
      return Buffer.from(`CIPHER:${Buffer.from(plainText, 'utf8').toString('base64')}`, 'utf8');
    },
    decryptString: (encrypted: Buffer): string => {
      state.decryptCalls += 1;
      const text = encrypted.toString('utf8');
      return Buffer.from(text.slice('CIPHER:'.length), 'base64').toString('utf8');
    },
  };
  return Object.assign(state, {});
}

function record(overrides: Partial<ActivationRecord> = {}): ActivationRecord {
  return {
    gatewayUrl: 'http://127.0.0.1:8000',
    code: 'ACT-CODE-1234-PLAIN',
    token: 'device-token-PLAIN-5678',
    tokenId: 'tok-1',
    plan: 'pro',
    expiresAt: '2027-01-01T00:00:00Z',
    activatedAt: '2026-10-22T12:00:00Z',
    lastVerifiedAt: '2026-10-22T12:05:00Z',
    deviceLabel: 'macbook',
    ...overrides,
  };
}

describe('ActivationStore', () => {
  let root = '';
  let filePath = '';

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'dramaclip-activation-'));
    mkdirSync(path.join(root, 'userData'), { recursive: true });
    filePath = path.join(root, 'userData', ACTIVATION_FILE_NAME);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('文件缺失时按未激活返回 null', () => {
    const store = new ActivationStore({ filePath, safeStorage: fakeSafeStorage() });
    expect(store.load()).toBeNull();
  });

  it('保存后：字段完整、明文不上盘、权限 0600、可 round-trip', () => {
    const storage = fakeSafeStorage();
    const store = new ActivationStore({ filePath, safeStorage: storage });
    const saved = record();

    store.save(saved);

    expect(existsSync(filePath)).toBe(true);
    const mode = statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);

    const raw = readFileSync(filePath, 'utf8');
    expect(raw).not.toContain(saved.code);
    expect(raw).not.toContain(saved.token);
    expect(raw).not.toContain('device-token-PLAIN-5678');
    const envelope: unknown = JSON.parse(raw);
    expect(envelope).toMatchObject({ version: 1 });
    expect(typeof (envelope as { payload?: unknown }).payload).toBe('string');

    expect(store.load()).toEqual(saved);
  });

  it('损坏的 JSON 降级为未激活，不抛错', () => {
    const store = new ActivationStore({ filePath, safeStorage: fakeSafeStorage() });
    writeFileSync(filePath, 'not-json{{{');
    expect(store.load()).toBeNull();
  });

  it('信封合法但密文解不开（密钥迁移）也降级为未激活', () => {
    const store = new ActivationStore({
      filePath,
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (plain: string) => Buffer.from(plain, 'utf8'),
        decryptString: () => {
          throw new Error('keychain unavailable');
        },
      },
    });
    writeFileSync(filePath, JSON.stringify({ version: 1, payload: 'AAAA' }));
    expect(store.load()).toBeNull();
  });

  it('缺字段的凭证不可信：即使能解密也按未激活处理', () => {
    const store = new ActivationStore({ filePath, safeStorage: fakeSafeStorage() });
    const partial = { gatewayUrl: 'x', code: 'c', token: 't' };
    // 用同款假加密写一条缺字段记录
    const encrypted = fakeSafeStorage().encryptString(JSON.stringify(partial));
    writeFileSync(
      filePath,
      JSON.stringify({ version: 1, payload: encrypted.toString('base64') }),
    );
    expect(store.load()).toBeNull();
  });

  it('isEncryptionAvailable=false：拒绝写入并给出可行动错误，不落盘', () => {
    const store = new ActivationStore({ filePath, safeStorage: fakeSafeStorage(false) });

    expect(() => {
      store.save(record());
    }).toThrow(ActivationStoreError);
    expect(() => {
      store.save(record());
    }).toThrow(/安全存储不可用/u);
    expect(existsSync(filePath)).toBe(false);
  });

  it('加密不可用时读取已有凭证也降级为未激活（不读明文）', () => {
    const writer = new ActivationStore({ filePath, safeStorage: fakeSafeStorage(true) });
    writer.save(record());
    const reader = new ActivationStore({ filePath, safeStorage: fakeSafeStorage(false) });
    expect(reader.load()).toBeNull();
  });

  it('clear 删除文件，重复 clear 不报错', () => {
    const store = new ActivationStore({ filePath, safeStorage: fakeSafeStorage() });
    store.save(record());
    store.clear();
    expect(existsSync(filePath)).toBe(false);
    store.clear();
    expect(store.load()).toBeNull();
  });

  it('重复保存覆盖为最新凭证（原子替换后无 .tmp 残留）', () => {
    const store = new ActivationStore({ filePath, safeStorage: fakeSafeStorage() });
    store.save(record({ plan: 'standard' }));
    store.save(record({ plan: 'pro' }));
    expect(store.load()?.plan).toBe('pro');
    expect(existsSync(`${filePath}.tmp`)).toBe(false);
  });
});
