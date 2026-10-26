/** preload：contextBridge 暴露 window.dramaclip（渲染层唯一入口，docs/desktop/00 §3）。 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  ActivationOperationResult,
  ActivationSnapshot,
  CopyFilesResult,
  DataPaths,
  DramaClipBridge,
  RevealResult,
  ServiceEvent,
} from '@dramaclip/protocol';
import type { PickedVideoFile } from './services/dialog';

/** 4.1 的桥方法尚未进 @dramaclip/protocol 的 DramaClipBridge（4.2 由导入线补类型）。
 *  这里先就地扩展接口：protocol 补齐后签名结构一致，satisfies 不会被多余属性卡住。 */
interface PendingVideoFilesBridge {
  pickVideoFiles(): Promise<PickedVideoFile[]>;
}

const api = {
  rpc: (method: string, params: Record<string, unknown> = {}): Promise<unknown> =>
    ipcRenderer.invoke('rpc', method, params),
  appVersion: (): Promise<string> => ipcRenderer.invoke('app:version') as Promise<string>,
  appPaths: (): Promise<DataPaths> => ipcRenderer.invoke('app:paths') as Promise<DataPaths>,
  restartService: (): Promise<void> => ipcRenderer.invoke('service:restart') as Promise<void>,
  pickFolder: (): Promise<string | null> =>
    ipcRenderer.invoke('dialog:pickFolder') as Promise<string | null>,
  pickVideoFile: (): Promise<string | null> =>
    ipcRenderer.invoke('dialog:pickVideoFile') as Promise<string | null>,
  pickVideoFiles: (): Promise<PickedVideoFile[]> =>
    ipcRenderer.invoke('dialog:pickVideoFiles') as Promise<PickedVideoFile[]>,
  pickAudioFile: (): Promise<string | null> =>
    ipcRenderer.invoke('dialog:pickAudioFile') as Promise<string | null>,
  saveTextFile: (defaultName: string, content: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:saveTextFile', defaultName, content) as Promise<string | null>,
  revealInFolder: (path: string): Promise<RevealResult> =>
    ipcRenderer.invoke('shell:reveal', path) as Promise<RevealResult>,
  copyFiles: (files: readonly string[], destDir: string): Promise<CopyFilesResult> =>
    ipcRenderer.invoke('shell:copyFiles', [...files], destDir) as Promise<CopyFilesResult>,
  windowControl: (action: 'minimize' | 'maximize-toggle' | 'close'): Promise<void> =>
    ipcRenderer.invoke('window:control', action) as Promise<void>,
  onServiceEvent: (callback: (event: ServiceEvent) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: ServiceEvent): void => {
      callback(payload);
    };
    ipcRenderer.on('service:event', listener);
    return () => ipcRenderer.removeListener('service:event', listener);
  },
  activationStatus: (recheck = false): Promise<ActivationSnapshot> =>
    ipcRenderer.invoke('activation:status', recheck) as Promise<ActivationSnapshot>,
  redeemActivation: (code: string): Promise<ActivationOperationResult> =>
    ipcRenderer.invoke('activation:redeem', code) as Promise<ActivationOperationResult>,
  unbindActivation: (): Promise<ActivationOperationResult> =>
    ipcRenderer.invoke('activation:unbind') as Promise<ActivationOperationResult>,
  onActivationChanged: (callback: (snapshot: ActivationSnapshot) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: ActivationSnapshot): void => {
      callback(payload);
    };
    ipcRenderer.on('activation:changed', listener);
    return () => ipcRenderer.removeListener('activation:changed', listener);
  },
} as const satisfies DramaClipBridge & PendingVideoFilesBridge;

contextBridge.exposeInMainWorld('dramaclip', api);
