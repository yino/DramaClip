// @vitest-environment jsdom
/**
 * 素材页「新增素材」（tasks 3.3）：只追加、不自动分析；分析中/追加中禁用；
 * 结果 toast 报新增与跳过；成功后补拍封面一次，失败不影响新增。
 */
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App as AntdApp } from 'antd';
import type { PickedVideoFile } from '@dramaclip/protocol';
import { EpisodeListPanel } from '../EpisodeListPanel';
import { useAddMaterial } from '../useAddMaterial';

const api = vi.hoisted(() => ({
  pickVideoFiles: vi.fn(),
  addEpisodes: vi.fn(),
  ensureCovers: vi.fn(),
  start: vi.fn(),
}));

vi.mock('../../../services/client', () => ({
  pickVideoFiles: api.pickVideoFiles,
  projectApi: { addEpisodes: api.addEpisodes, ensureCovers: api.ensureCovers },
  analysisApi: { start: api.start },
}));

function picked(dir: string, name: string): PickedVideoFile {
  return { path: `/videos/${dir}/${name}`, name, size: 1024 * 1024 };
}

function wrapper({ children }: { children: React.ReactNode }): React.ReactElement {
  return <AntdApp>{children}</AntdApp>;
}

async function runAdd(
  reload: () => Promise<void> = vi.fn(() => Promise.resolve()),
): Promise<{ adding: boolean }> {
  const { result } = renderHook(() => useAddMaterial('p1', reload), { wrapper });
  await act(async () => {
    await result.current.addMaterial();
  });
  return { adding: result.current.adding };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.ensureCovers.mockResolvedValue({ ok: true, generated: 0, remaining: 0 });
});

afterEach(() => {
  cleanup();
});

describe('useAddMaterial', () => {
  it('成功：pickVideoFiles → addEpisodes → 刷新；toast 新增数；封面补拍一次；不启动分析', async () => {
    api.pickVideoFiles.mockResolvedValue([picked('甲剧', '01.mp4'), picked('甲剧', '02.mp4')]);
    api.addEpisodes.mockResolvedValue({ added: 2, skipped: [], episodes: [] });
    const reload = vi.fn(() => Promise.resolve());

    const state = await runAdd(reload);

    expect(api.addEpisodes).toHaveBeenCalledWith('p1', [
      '/videos/甲剧/01.mp4',
      '/videos/甲剧/02.mp4',
    ]);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(api.ensureCovers).toHaveBeenCalledTimes(1);
    expect(api.start).not.toHaveBeenCalled();
    expect(await screen.findByText('已新增 2 集，待分析')).toBeTruthy();
    expect(state.adding).toBe(false);
  });

  it('封面补拍失败不影响新增结果', async () => {
    api.pickVideoFiles.mockResolvedValue([picked('甲剧', '01.mp4')]);
    api.addEpisodes.mockResolvedValue({ added: 1, skipped: [], episodes: [] });
    api.ensureCovers.mockRejectedValue(new Error('封面服务不可用'));
    const state = await runAdd();
    expect(await screen.findByText('已新增 1 集，待分析')).toBeTruthy();
    expect(state.adding).toBe(false);
  });

  it('跳过：toast 同时报跳过数量与中文原因', async () => {
    api.pickVideoFiles.mockResolvedValue([picked('甲剧', '01.mp4'), picked('甲剧', '02.mp4')]);
    api.addEpisodes.mockResolvedValue({
      added: 1,
      skipped: [{ path: '/videos/甲剧/02.mp4', reason: 'duplicate' }],
      episodes: [],
    });
    await runAdd();
    expect(
      await screen.findByText('已新增 1 集，待分析；跳过 1 个文件（重复文件）'),
    ).toBeTruthy();
  });

  it('取消选择：什么都不做（不追加、不刷新、不补封面、无提示）', async () => {
    api.pickVideoFiles.mockResolvedValue([]);
    const reload = vi.fn(() => Promise.resolve());
    await runAdd(reload);

    expect(api.addEpisodes).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(api.ensureCovers).not.toHaveBeenCalled();
    expect(screen.queryByText(/已新增/)).toBeNull();
  });

  it('全部被跳过：提示跳过原因，不补封面', async () => {
    api.pickVideoFiles.mockResolvedValue([picked('甲剧', '01.mp4')]);
    api.addEpisodes.mockResolvedValue({
      added: 0,
      skipped: [{ path: '/videos/甲剧/01.mp4', reason: 'duplicate' }],
      episodes: [],
    });
    await runAdd();
    expect(await screen.findByText('跳过 1 个文件（重复文件）')).toBeTruthy();
    expect(api.ensureCovers).not.toHaveBeenCalled();
  });

  it('失败：报服务端原因，不刷新、不补封面', async () => {
    api.pickVideoFiles.mockResolvedValue([picked('甲剧', '01.mp4')]);
    api.addEpisodes.mockRejectedValue(new Error('项目正在导入素材，请稍后再试'));
    const reload = vi.fn(() => Promise.resolve());
    await runAdd(reload);

    expect(await screen.findByText('项目正在导入素材，请稍后再试')).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
    expect(api.ensureCovers).not.toHaveBeenCalled();
    expect(api.start).not.toHaveBeenCalled();
  });
});

type PanelProps = React.ComponentProps<typeof EpisodeListPanel>;

function panelProps(over: Partial<PanelProps> = {}): PanelProps {
  return {
    orderedIds: [],
    byId: new Map(),
    highlights: {},
    activeEpisodeId: null,
    selectedIds: [],
    running: false,
    onActivate: () => undefined,
    onToggle: () => undefined,
    dragIndex: { current: null },
    overIndex: null,
    setOverIndex: () => undefined,
    onDragStart: () => undefined,
    onDrop: () => undefined,
    onMove: () => undefined,
    ...over,
  };
}

describe('EpisodeListPanel 新增素材入口', () => {
  it('空闲时可点击并触发回调', () => {
    const onAddMaterial = vi.fn();
    render(<EpisodeListPanel {...panelProps({ onAddMaterial })} />);
    fireEvent.click(screen.getByRole('button', { name: '新增素材' }));
    expect(onAddMaterial).toHaveBeenCalledTimes(1);
  });

  it('分析中禁用', () => {
    render(<EpisodeListPanel {...panelProps({ running: true, onAddMaterial: vi.fn(), adding: false })} />);
    const button = screen.getByRole('button', { name: '新增素材' });
    expect(button.hasAttribute('disabled')).toBe(true);
  });

  it('追加中禁用（loading）', () => {
    render(<EpisodeListPanel {...panelProps({ onAddMaterial: vi.fn(), adding: true })} />);
    const button = screen.getByRole('button', { name: /新增素材/ });
    expect(button.hasAttribute('disabled')).toBe(true);
  });

  it('未接线时不渲染入口（不摆假按钮）', () => {
    render(<EpisodeListPanel {...panelProps()} />);
    expect(screen.queryByRole('button', { name: '新增素材' })).toBeNull();
  });
});

