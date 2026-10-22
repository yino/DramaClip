// @vitest-environment node
/** 激活 IPC 边界（desktop-activation 7.5）：参数校验、脱敏状态、广播。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivationSnapshot } from '@dramaclip/protocol';
import { broadcastActivationChanged, registerIpc, type IpcContext } from './ipc';
import type { ActivationController } from './services/activation-service';

const electron = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
    },
    shell: {
      showItemInFolder: vi.fn(),
      openPath: vi.fn(() => Promise.resolve('')),
      openExternal: vi.fn(() => Promise.resolve(undefined)),
    },
    dialog: {
      showOpenDialogSync: vi.fn(() => undefined),
      showSaveDialogSync: vi.fn(() => undefined),
    },
  };
});

vi.mock('electron', () => ({
  ipcMain: electron.ipcMain,
  shell: electron.shell,
  dialog: electron.dialog,
  BrowserWindow: {
    fromWebContents: (): null => null,
  },
}));

const ACTIVE_SNAPSHOT: ActivationSnapshot = {
  status: 'active',
  plan: 'pro',
  expiresAt: '2027-01-01T00:00:00Z',
  lastVerifiedAt: '2026-10-22T12:00:00Z',
  maskedCode: '••••1234',
  gatewayUrl: 'http://gw.test',
};

const INACTIVE_SNAPSHOT: ActivationSnapshot = {
  status: 'inactive',
  plan: '',
  expiresAt: '',
  lastVerifiedAt: '',
  maskedCode: '',
  gatewayUrl: '',
};

function controller(
  overrides: Partial<ActivationController> = {},
): ActivationController & {
  status: ReturnType<typeof vi.fn>;
  redeem: ReturnType<typeof vi.fn>;
  unbind: ReturnType<typeof vi.fn>;
} {
  return Object.assign(
    {
      status: vi.fn(() => Promise.resolve(ACTIVE_SNAPSHOT)),
      redeem: vi.fn(() => Promise.resolve({ ok: true, snapshot: ACTIVE_SNAPSHOT })),
      unbind: vi.fn(() => Promise.resolve({ ok: true, snapshot: INACTIVE_SNAPSHOT })),
      getSnapshot: vi.fn(() => ACTIVE_SNAPSHOT),
      stop: vi.fn(),
    },
    overrides,
  );
}

function makeContext(activation: ActivationController | null): IpcContext {
  return {
    rpc: vi.fn(() => Promise.resolve({ ok: true })),
    restartService: vi.fn(),
    appVersion: () => '0.0.0',
    dataPaths: () => ({ root: '', outputs: '', models: '', logs: '', trash: '' }),
    windows: () => [],
    activation,
  };
}

/** 让 registerIpc 重新注册 handlers（handler map 每次清空）。 */
function boot(activation: ActivationController | null): void {
  electron.handlers.clear();
  electron.ipcMain.handle.mockClear();
  registerIpc(makeContext(activation));
}

function invoke(channel: string, ...args: unknown[]): unknown {
  const handler = electron.handlers.get(channel);
  if (handler === undefined) throw new Error(`未注册 IPC 通道: ${channel}`);
  return handler({ sender: null }, ...args);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('activation IPC 注册与状态', () => {
  it('注册三个激活通道', () => {
    boot(controller());
    expect(electron.ipcMain.handle).toHaveBeenCalledWith('activation:status', expect.any(Function));
    expect(electron.ipcMain.handle).toHaveBeenCalledWith(
      'activation:redeem',
      expect.any(Function),
    );
    expect(electron.ipcMain.handle).toHaveBeenCalledWith(
      'activation:unbind',
      expect.any(Function),
    );
  });

  it('服务未装配时 status 返回未激活快照，且绝不含 token/code', () => {
    boot(null);
    const snapshot = invoke('activation:status') as ActivationSnapshot;
    expect(snapshot).toEqual(INACTIVE_SNAPSHOT);
    expect(Object.keys(snapshot).sort()).toEqual([
      'expiresAt',
      'gatewayUrl',
      'lastVerifiedAt',
      'maskedCode',
      'plan',
      'status',
    ]);
    expect(snapshot).not.toHaveProperty('token');
    expect(snapshot).not.toHaveProperty('code');
  });

  it('只有严格 true 才触发重新校验', () => {
    const activation = controller();
    boot(activation);
    invoke('activation:status', true);
    invoke('activation:status', 'yes');
    invoke('activation:status');
    expect(activation.status.mock.calls).toEqual([[true], [false], [false]]);
  });
});

describe('activation:redeem 参数校验', () => {
  it.each([
    ['空串', ''],
    ['空白', '   '],
    ['过短', 'short'],
    ['过长', 'x'.repeat(129)],
    ['非字符串', 42],
    ['null', null],
    ['对象', { code: 'ABCDEFGH' }],
  ])('%s：拒绝且不调用激活服务', async (_label, value) => {
    const activation = controller();
    boot(activation);

    await expect(invoke('activation:redeem', value)).rejects.toThrow('8–128');
    expect(activation.redeem.mock.calls).toHaveLength(0);
  });

  it('合法码先 trim 再交给服务', async () => {
    const activation = controller();
    boot(activation);

    await invoke('activation:redeem', '  CODE-1234  ');

    expect(activation.redeem.mock.calls).toEqual([['CODE-1234']]);
  });

  it('服务未装配时给出可读错误', async () => {
    boot(null);
    await expect(invoke('activation:redeem', 'CODE-1234')).rejects.toThrow('激活服务不可用');
    await expect(invoke('activation:unbind')).rejects.toThrow('激活服务不可用');
  });
});

describe('activation:unbind 与广播', () => {
  it('解绑委托给激活服务', async () => {
    const activation = controller();
    boot(activation);
    await invoke('activation:unbind');
    expect(activation.unbind.mock.calls).toHaveLength(1);
  });

  it('广播 activation:changed：只发给存活窗口，未销毁窗口不发送', () => {
    const alive = { isDestroyed: () => false, webContents: { send: vi.fn() } };
    const destroyed = { isDestroyed: () => true, webContents: { send: vi.fn() } };
    const context = makeContext(controller());
    context.windows = () => [alive, destroyed] as unknown as ReturnType<IpcContext['windows']>;

    broadcastActivationChanged(context, ACTIVE_SNAPSHOT);

    expect(alive.webContents.send).toHaveBeenCalledWith('activation:changed', ACTIVE_SNAPSHOT);
    expect(destroyed.webContents.send).not.toHaveBeenCalled();
  });
});
