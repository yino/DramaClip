// @vitest-environment jsdom
/**
 * 统一新建项目弹窗（tasks 4.3）：打开只渲染表单、名称自动聚焦、点“选择视频文件”
 * 才唤起系统多选、改名/清空不被覆盖、空名或空素材禁用、失败留窗、提交中禁重复。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App as AntdApp } from 'antd';
import { useState } from 'react';
import type { PickedVideoFile } from '@dramaclip/protocol';
import { CreateProjectModal } from '../CreateProjectModal';

const api = vi.hoisted(() => ({
  pickVideoFiles: vi.fn(),
  createFromFiles: vi.fn(),
}));

vi.mock('../../../services/client', () => ({
  pickVideoFiles: api.pickVideoFiles,
  projectApi: { createFromFiles: api.createFromFiles },
}));

function picked(dir: string, name: string, size = 1024 * 1024): PickedVideoFile {
  return { path: `/videos/${dir}/${name}`, name, size };
}

function Harness({
  onCreate,
}: {
  onCreate: (name: string, files: string[]) => Promise<unknown>;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <AntdApp>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        打开弹窗
      </button>
      <CreateProjectModal
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        onCreate={onCreate}
      />
    </AntdApp>
  );
}

async function openModal(
  onCreate: (name: string, files: string[]) => Promise<unknown> = vi.fn(() => Promise.resolve()),
): Promise<{ onCreate: typeof onCreate; input: HTMLInputElement }> {
  render(<Harness onCreate={onCreate} />);
  fireEvent.click(screen.getByRole('button', { name: '打开弹窗' }));
  await screen.findByRole('dialog');
  return { onCreate, input: screen.getByPlaceholderText('例如：复仇千金') };
}

function submitButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /创建项目/ });
}

beforeAll(() => {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  });
  class NoResizeObserver {
    observe(): void {
      // 尺寸观察交给真浏览器
    }

    unobserve(): void {
      // 同上
    }

    disconnect(): void {
      // 同上
    }
  }
  globalThis.ResizeObserver = NoResizeObserver;
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('CreateProjectModal 打开与结构', () => {
  it('打开只渲染表单：不调系统选择器，名称自动聚焦且排第一行', async () => {
    const { onCreate } = await openModal();
    expect(api.pickVideoFiles).not.toHaveBeenCalled();
    expect(onCreate).not.toHaveBeenCalled();

    const input = screen.getByPlaceholderText('例如：复仇千金');
    await waitFor(() => {
      expect(document.activeElement).toBe(input);
    });

    const material = screen.getByText('剧集素材');
    expect(input.compareDocumentPosition(material) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('button', { name: '选择视频文件' })).toBeTruthy();
    expect(submitButton().disabled).toBe(true);
  });
});

describe('CreateProjectModal 选择素材', () => {
  it('只有点击“选择视频文件”才开多选；去重、汇总、行移除、取消保留', async () => {
    api.pickVideoFiles.mockResolvedValueOnce([
      picked('复仇千金', '01.mp4', 1024 * 1024),
      picked('复仇千金', '02.mp4', 1.5 * 1024 * 1024),
      picked('复仇千金', '01.mp4', 1024 * 1024),
    ]);
    const { input } = await openModal();
    fireEvent.click(screen.getByRole('button', { name: '选择视频文件' }));
    await waitFor(() => {
      expect(api.pickVideoFiles).toHaveBeenCalledTimes(1);
    });
    await screen.findByText('已选 2 个文件 · 共 2.5 MB');
    expect(screen.getByText('已跳过 1 个重复文件')).toBeTruthy();
    expect(screen.getByText('01.mp4')).toBeTruthy();
    expect(screen.getByText('02.mp4')).toBeTruthy();
    expect(input.value).toBe('复仇千金');

    fireEvent.click(screen.getByRole('button', { name: '移除 01.mp4' }));
    expect(screen.queryByText('01.mp4')).toBeNull();
    expect(screen.getByText('已选 1 个文件 · 共 1.5 MB')).toBeTruthy();

    // 取消（[]）不是失败：已选文件与名称原样保留。
    api.pickVideoFiles.mockResolvedValueOnce([]);
    fireEvent.click(screen.getByRole('button', { name: '重新选择' }));
    await waitFor(() => {
      expect(api.pickVideoFiles).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByText('已选 1 个文件 · 共 1.5 MB')).toBeTruthy();
    expect(input.value).toBe('复仇千金');
  });

  it('未编辑名称时按第一个文件父目录预填（跨目录取第一个）', async () => {
    api.pickVideoFiles.mockResolvedValueOnce([
      picked('甲剧', '01.mp4'),
      picked('乙剧', '02.mp4'),
    ]);
    const { input } = await openModal();
    fireEvent.click(screen.getByRole('button', { name: '选择视频文件' }));
    await screen.findByText('已选 2 个文件 · 共 2.0 MB');
    expect(input.value).toBe('甲剧');
  });

  it('nameEdited 后不覆盖；清空名称后不再恢复', async () => {
    api.pickVideoFiles.mockResolvedValueOnce([picked('甲剧', '01.mp4')]);
    const { input } = await openModal();
    fireEvent.change(input, { target: { value: '我的项目' } });
    fireEvent.click(screen.getByRole('button', { name: '选择视频文件' }));
    await screen.findByText('已选 1 个文件 · 共 1.0 MB');
    expect(input.value).toBe('我的项目');

    fireEvent.change(input, { target: { value: '' } });
    api.pickVideoFiles.mockResolvedValueOnce([picked('乙剧', '02.mp4')]);
    fireEvent.click(screen.getByRole('button', { name: '重新选择' }));
    await screen.findByText('已选 1 个文件 · 共 1.0 MB');
    expect(input.value).toBe('');
  });
});

describe('CreateProjectModal 校验与提交', () => {
  it('空名或无文件时禁用创建，两者齐备才可用', async () => {
    api.pickVideoFiles.mockResolvedValueOnce([picked('甲剧', '01.mp4')]);
    const { input } = await openModal();
    expect(submitButton().disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: '选择视频文件' }));
    await screen.findByText('已选 1 个文件 · 共 1.0 MB');
    // 未编辑名称 → 自动预填目录名，按钮可用
    expect(input.value).toBe('甲剧');
    expect(submitButton().disabled).toBe(false);

    fireEvent.change(input, { target: { value: '   ' } });
    expect(submitButton().disabled).toBe(true);
    fireEvent.change(input, { target: { value: '复仇千金' } });
    expect(submitButton().disabled).toBe(false);
  });

  it('失败留在弹窗：显示 Alert 与跳过原因，修正后可再提交', async () => {
    api.pickVideoFiles.mockResolvedValueOnce([picked('甲剧', '01.mp4')]);
    const error = Object.assign(new Error('所选文件里没有可用的视频'), {
      skipped: [{ path: '/videos/甲剧/notes.mov', reason: 'unsupported' }],
    });
    const onCreate = vi.fn().mockRejectedValue(error);
    await openModal(onCreate);
    fireEvent.click(screen.getByRole('button', { name: '选择视频文件' }));
    await screen.findByText('已选 1 个文件 · 共 1.0 MB');
    fireEvent.click(submitButton());
    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledTimes(1);
    });
    expect(onCreate).toHaveBeenCalledWith('甲剧', ['/videos/甲剧/01.mp4']);
    await screen.findByText('创建失败');
    expect(screen.getByText(/所选文件里没有可用的视频/)).toBeTruthy();
    expect(screen.getByText(/跳过 1 个文件（不是支持的视频格式）/)).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();

    // 不是一次性锁死：修好输入后还能再提交。
    onCreate.mockResolvedValueOnce(undefined);
    fireEvent.click(submitButton());
    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledTimes(2);
    });
  });

  it('提交中禁重复提交与取消', async () => {
    api.pickVideoFiles.mockResolvedValueOnce([picked('甲剧', '01.mp4')]);
    let finish: (value: unknown) => void = () => undefined;
    const onCreate = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          finish = resolve;
        }),
    );
    await openModal(onCreate);
    fireEvent.click(screen.getByRole('button', { name: '选择视频文件' }));
    await screen.findByText('已选 1 个文件 · 共 1.0 MB');
    fireEvent.click(submitButton());

    const busy = await screen.findByRole('button', { name: /创建中/ });
    expect(busy.hasAttribute('disabled')).toBe(true);
    const cancel = screen.getByRole('button', { name: /取\s*消/ });
    expect(cancel.hasAttribute('disabled')).toBe(true);
    fireEvent.click(busy);
    expect(onCreate).toHaveBeenCalledTimes(1);

    await act(async () => {
      finish(undefined);
      await Promise.resolve();
    });
    expect(onCreate).toHaveBeenCalledTimes(1);
  });
});
