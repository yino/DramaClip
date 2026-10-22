/** ipcMain 通道唯一登记处（docs/desktop/00 §3）。 */
import { BrowserWindow, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  METHOD_NAMES,
  type ActivationSnapshot,
  type CopyFilesResult,
  type DataPaths,
  type RevealResult,
  type ServiceEvent,
} from '@dramaclip/protocol';
import { pickAudioFile, pickFolder, pickVideoFile, saveTextFile } from './services/dialog';
import { normalizeActivationCode, type ActivationController } from './services/activation-service';

export interface IpcContext {
  /** RPC 转发目标（ServiceManager.rpc）。 */
  rpc(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  restartService(): void;
  appVersion(): string;
  /** 本地数据目录锚点（关于页「本地数据」）。 */
  dataPaths(): DataPaths;
  /** 事件广播目标窗口集合（App 启动后传入 getter，避免持有过期引用）。 */
  windows(): BrowserWindow[];
  /** 激活控制器；启动失败/尚未装配时为 null（状态按未激活返回）。 */
  activation: ActivationController | null;
}

/** 数据目录 = 服务端 paths._SUBDIRS 的同名约定，锚点唯一（ADR-009）。 */
export function resolveDataPaths(dataDir: string): DataPaths {
  return {
    root: dataDir,
    outputs: path.join(dataDir, 'outputs'),
    models: path.join(dataDir, 'models'),
    logs: path.join(dataDir, 'logs'),
    trash: path.join(dataDir, '.trash'),
  };
}

/** 复制目标不覆盖同名文件：撞名加 -1、-2…后缀（回收站同款「不吞别人东西」规矩）。 */
function uniqueDest(destDir: string, fileName: string): string {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  let candidate = path.join(destDir, fileName);
  for (let index = 1; fs.existsSync(candidate); index += 1) {
    candidate = path.join(destDir, `${base}-${String(index)}${ext}`);
  }
  return candidate;
}

async function copyFiles(files: readonly string[], destDir: string): Promise<CopyFilesResult> {
  const copied: string[] = [];
  const failed: { path: string; reason: string }[] = [];
  await fsp.mkdir(destDir, { recursive: true });
  for (const file of files) {
    try {
      const dest = uniqueDest(destDir, path.basename(file));
      await fsp.copyFile(file, dest);
      copied.push(dest);
    } catch (error: unknown) {
      failed.push({ path: file, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { copied, failed };
}

const INACTIVE_SNAPSHOT: ActivationSnapshot = {
  status: 'inactive',
  plan: '',
  expiresAt: '',
  lastVerifiedAt: '',
  maskedCode: '',
  gatewayUrl: '',
};

export function registerIpc(context: IpcContext): void {
  ipcMain.handle('rpc', (_event, method: unknown, params: unknown) => {
    if (typeof method !== 'string' || !(METHOD_NAMES as readonly string[]).includes(method)) {
      return Promise.reject(new Error(`未知 RPC 方法: ${String(method)}`));
    }
    const safeParams: Record<string, unknown> =
      typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};
    return context.rpc(method, safeParams);
  });
  ipcMain.handle('app:version', () => context.appVersion());
  ipcMain.handle('app:paths', () => context.dataPaths());
  ipcMain.handle('dialog:pickFolder', (event) => pickFolder(BrowserWindow.fromWebContents(event.sender)));
  ipcMain.handle('dialog:pickVideoFile', (event) =>
    pickVideoFile(BrowserWindow.fromWebContents(event.sender)),
  );
  ipcMain.handle('dialog:pickAudioFile', (event) =>
    pickAudioFile(BrowserWindow.fromWebContents(event.sender)),
  );
  ipcMain.handle('dialog:saveTextFile', (_event, defaultName: unknown, content: unknown) => {
    if (typeof defaultName !== 'string' || defaultName.length === 0 || typeof content !== 'string') {
      return Promise.reject(new Error('saveTextFile 参数不合法'));
    }
    return saveTextFile(BrowserWindow.fromWebContents(_event.sender), defaultName, content);
  });
  ipcMain.handle('shell:reveal', (_event, targetPath: unknown): RevealResult => {
    if (typeof targetPath !== 'string' || targetPath.length === 0) {
      return { ok: false, reason: '路径为空' };
    }
    if (!fs.existsSync(targetPath)) {
      return { ok: false, reason: '路径不存在（可能已被移动或删除）' };
    }
    shell.showItemInFolder(targetPath);
    return { ok: true };
  });
  ipcMain.handle('shell:copyFiles', async (_event, files: unknown, destDir: unknown) => {
    if (
      !Array.isArray(files) ||
      files.some((item) => typeof item !== 'string' || item.length === 0) ||
      typeof destDir !== 'string' ||
      destDir.length === 0
    ) {
      return Promise.reject(new Error('copyFiles 参数不合法'));
    }
    return copyFiles(files as string[], destDir);
  });
  ipcMain.handle('service:restart', () => {
    context.restartService();
    return { ok: true };
  });
  ipcMain.handle('activation:status', (_event, recheck: unknown) => {
    if (context.activation === null) return INACTIVE_SNAPSHOT;
    return context.activation.status(recheck === true);
  });
  ipcMain.handle('activation:redeem', (_event, code: unknown) => {
    if (context.activation === null) {
      return Promise.reject(new Error('激活服务不可用（应用仍在启动或已退出）'));
    }
    // 类型/长度校验在发网络请求之前完成；只把规范化后的码交给主进程服务
    const normalized = normalizeActivationCode(code);
    if (normalized === null) {
      return Promise.reject(new Error('激活码需为 8–128 个字符'));
    }
    return context.activation.redeem(normalized);
  });
  ipcMain.handle('activation:unbind', () => {
    if (context.activation === null) {
      return Promise.reject(new Error('激活服务不可用（应用仍在启动或已退出）'));
    }
    return context.activation.unbind();
  });
  ipcMain.handle('window:control', (event, action: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win === null || typeof action !== 'string') return { ok: false };
    if (action === 'minimize') win.minimize();
    else if (action === 'maximize-toggle') {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    } else if (action === 'close') win.close();
    return { ok: true };
  });
}

/** 主进程 → 渲染层事件下发（service:event）。 */
export function broadcastEvent(context: IpcContext, event: ServiceEvent): void {
  for (const win of context.windows()) {
    if (!win.isDestroyed()) win.webContents.send('service:event', event);
  }
}

/** 激活状态变化下发（activation:changed）；只送脱敏快照。 */
export function broadcastActivationChanged(
  context: IpcContext,
  snapshot: ActivationSnapshot,
): void {
  for (const win of context.windows()) {
    if (!win.isDestroyed()) win.webContents.send('activation:changed', snapshot);
  }
}
