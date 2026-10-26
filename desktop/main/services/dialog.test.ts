// @vitest-environment node
/** 原生对话框（规格 desktop-project-import）：多选视频文件后由主进程补 stat；
 *  取消返回空数组，单条 stat 失败只让 size 退 0，不丢条目。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseWindow } from 'electron';
import { pickVideoFiles } from './dialog';

const mocks = vi.hoisted(() => ({
  showOpenDialogSync: vi.fn(),
  stat: vi.fn(),
}));

vi.mock('electron', () => ({
  dialog: { showOpenDialogSync: mocks.showOpenDialogSync },
}));

vi.mock('node:fs/promises', () => ({
  default: { stat: mocks.stat },
}));

const EXPECTED_FILTERS = [
  { name: '视频文件', extensions: ['mp4', 'mov', 'avi', 'mkv', 'wmv', 'webm', 'flv'] },
  { name: '全部文件', extensions: ['*'] },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('pickVideoFiles', () => {
  it('取消选择返回空数组（取消不是失败）', async () => {
    mocks.showOpenDialogSync.mockReturnValue(undefined);

    await expect(pickVideoFiles(null)).resolves.toEqual([]);
    expect(mocks.stat).not.toHaveBeenCalled();
  });

  it('多选：保留路径与顺序，补齐文件名和字节数', async () => {
    mocks.showOpenDialogSync.mockReturnValue(['/videos/ep1.mp4', '/videos/sub/ep2.mov']);
    mocks.stat.mockResolvedValueOnce({ size: 1024 }).mockResolvedValueOnce({ size: 2048 });

    await expect(pickVideoFiles(null)).resolves.toEqual([
      { path: '/videos/ep1.mp4', name: 'ep1.mp4', size: 1024 },
      { path: '/videos/sub/ep2.mov', name: 'ep2.mov', size: 2048 },
    ]);
    expect(mocks.showOpenDialogSync).toHaveBeenCalledWith({
      properties: ['openFile', 'multiSelections'],
      filters: EXPECTED_FILTERS,
    });
    expect(mocks.stat).toHaveBeenCalledTimes(2);
  });

  it('单条 stat 失败 → size=0，其余条目照常返回', async () => {
    mocks.showOpenDialogSync.mockReturnValue(['/videos/ok.mp4', '/videos/locked.mp4']);
    mocks.stat.mockResolvedValueOnce({ size: 9 }).mockRejectedValueOnce(new Error('EACCES'));

    await expect(pickVideoFiles(null)).resolves.toEqual([
      { path: '/videos/ok.mp4', name: 'ok.mp4', size: 9 },
      { path: '/videos/locked.mp4', name: 'locked.mp4', size: 0 },
    ]);
  });

  it('有父窗口时弹窗挂在窗口上', async () => {
    const win = { id: 1 } as unknown as BaseWindow;
    mocks.showOpenDialogSync.mockReturnValue([]);

    await expect(pickVideoFiles(win)).resolves.toEqual([]);
    expect(mocks.showOpenDialogSync).toHaveBeenCalledWith(
      win,
      expect.objectContaining({ properties: ['openFile', 'multiSelections'] }),
    );
  });
});
