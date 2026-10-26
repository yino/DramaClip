/** 原生对话框（docs/desktop/00 §7）。多数接口取消返回 null，与"失败"区分；
 *  多选视频（pickVideoFiles）取消返回空数组。 */
import { dialog, type BaseWindow } from 'electron';
import fsp from 'node:fs/promises';
import path from 'node:path';

const VIDEO_FILTERS = [
  { name: '视频文件', extensions: ['mp4', 'mov', 'avi', 'mkv', 'wmv', 'webm', 'flv'] },
  { name: '全部文件', extensions: ['*'] },
];

const AUDIO_FILTERS = [
  { name: '音频文件', extensions: ['wav', 'mp3', 'flac', 'ogg', 'm4a'] },
  { name: '全部文件', extensions: ['*'] },
];

const TEXT_FILTERS = [{ name: '文本文件', extensions: ['srt', 'txt', 'lrc'] }];

/** 多选结果的每一条：路径 + 文件名 + 字节数（stat 失败时 size=0，仍是一条可导入的引用）。 */
export interface PickedVideoFile {
  readonly path: string;
  readonly name: string;
  readonly size: number;
}

export function pickAudioFile(window: BaseWindow | null): Promise<string | null> {
  const options = { properties: ['openFile' as const], filters: AUDIO_FILTERS };
  const result = window === null ? dialog.showOpenDialogSync(options) : dialog.showOpenDialogSync(window, options);
  return Promise.resolve(result?.[0] ?? null);
}

export function pickFolder(window: BaseWindow | null): Promise<string | null> {
  const result =
    window === null
      ? dialog.showOpenDialogSync({ properties: ['openDirectory'] })
      : dialog.showOpenDialogSync(window, { properties: ['openDirectory'] });
  return Promise.resolve(result?.[0] ?? null);
}

export function pickVideoFile(window: BaseWindow | null): Promise<string | null> {
  const options = { properties: ['openFile' as const], filters: VIDEO_FILTERS };
  const result = window === null ? dialog.showOpenDialogSync(options) : dialog.showOpenDialogSync(window, options);
  return Promise.resolve(result?.[0] ?? null);
}

/** 多选视频文件（4.1）：openFile + multiSelections，复用 VIDEO_FILTERS；
 *  主进程补 stat 供导入弹窗显示文件大小——stat 失败只让 size 退 0，不丢条目。
 *  取消返回 []——空选择不是失败，调用方据此静默返回。 */
export async function pickVideoFiles(window: BaseWindow | null): Promise<PickedVideoFile[]> {
  const options = {
    properties: ['openFile' as const, 'multiSelections' as const],
    filters: VIDEO_FILTERS,
  };
  const result = window === null ? dialog.showOpenDialogSync(options) : dialog.showOpenDialogSync(window, options);
  if (result === undefined) return [];
  return Promise.all(
    result.map(async (filePath): Promise<PickedVideoFile> => {
      try {
        const stat = await fsp.stat(filePath);
        return { path: filePath, name: path.basename(filePath), size: stat.size };
      } catch {
        return { path: filePath, name: path.basename(filePath), size: 0 };
      }
    }),
  );
}

/** 保存文本内容：弹保存框（默认文件名），落盘返回保存路径；取消返回 null。 */
export function saveTextFile(
  window: BaseWindow | null,
  defaultName: string,
  content: string,
): Promise<string | null> {
  const options = { defaultPath: defaultName, filters: TEXT_FILTERS };
  const result = window === null ? dialog.showSaveDialogSync(options) : dialog.showSaveDialogSync(window, options);
  if (!result) {
    return Promise.resolve(null);
  }
  return import('node:fs/promises')
    .then((fs) => fs.writeFile(result, content, 'utf8'))
    .then(() => result);
}
