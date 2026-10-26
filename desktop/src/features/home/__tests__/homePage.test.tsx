// @vitest-environment jsdom
/** 工作台去环境化（规格 desktop-workbench）：全宽单列、无环境右栏、
 *  无模型/运行环境/FFmpeg 文案；空态只承诺"选多个视频文件即可建剧，素材留在原位置"。 */
import { cleanup, render, screen } from '@testing-library/react';
import { App as AntdApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import type { Project } from '@dramaclip/protocol';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUiStore } from '../../../stores/ui';
import { HomePage } from '../HomePage';

const mocks = vi.hoisted(() => ({
  projectList: vi.fn(),
  listWorks: vi.fn(),
  jobsList: vi.fn(),
  rpc: vi.fn(),
  restartService: vi.fn(),
  pickFolder: vi.fn(),
}));

vi.mock('../../../services/client', () => ({
  projectApi: {
    list: mocks.projectList,
    create: vi.fn(),
    scanEpisodes: vi.fn(),
  },
  listWorks: mocks.listWorks,
  jobsApi: { list: mocks.jobsList },
  rpc: mocks.rpc,
  restartService: mocks.restartService,
  pickFolder: mocks.pickFolder,
  mediaUrl: (path: string) => `media://${path}`,
  onServiceEvent: vi.fn(() => () => undefined),
}));

const NOW = 1_760_000_000_000;
const PROJECT: Project = {
  id: 'p1',
  name: '替嫁新娘',
  source_path: 'D:/替嫁新娘',
  status: 'ready',
  created_at: NOW - 86_400_000,
  episode_count: 6,
  settings: {},
};

const ENV_BANNED = [
  '环境就绪度',
  '快速上手',
  '本地运行环境',
  'FFmpeg',
  '模型',
  'LLM',
  'TTS',
];

beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }));
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
  vi.resetAllMocks();
  window.localStorage.clear();
  useUiStore.setState({ serviceState: 'ready' });
  mocks.projectList.mockResolvedValue([]);
  mocks.listWorks.mockResolvedValue([]);
  mocks.jobsList.mockResolvedValue({ jobs: [], server_time_ms: NOW });
});

afterEach(() => {
  cleanup();
  useUiStore.setState({ serviceState: 'starting' });
});

function renderHome() {
  return render(
    <AntdApp>
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    </AntdApp>,
  );
}

/** 页面级禁词：环境/模型信息只允许出现在引擎中心、设置、关于页。 */
function expectNoEnvCopy(container: HTMLElement, extra: readonly string[] = []): void {
  const text = container.textContent;
  for (const banned of [...ENV_BANNED, ...extra]) {
    expect(text, `工作台出现了环境/模型文案：${banned}`).not.toContain(banned);
  }
}

describe('HomePage 去环境化', () => {
  it('有剧：全宽单列，不出现环境右栏与模型/FFmpeg 文案', async () => {
    mocks.projectList.mockResolvedValue([PROJECT]);
    const { container } = renderHome();
    // 矩阵出现 = 三个数据源都已落地
    await screen.findByText('替嫁新娘');

    const body = container.querySelector<HTMLElement>('[data-testid="home-body"]');
    expect(body).not.toBeNull();
    expect(body?.style.gridTemplateColumns).toBe('minmax(0, 1fr)');
    expect(container.innerHTML).not.toContain('330px');

    expectNoEnvCopy(container);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('空态：只承诺选多个视频文件建剧，primary 只留新增项目', async () => {
    mocks.projectList.mockResolvedValue([]);
    // 任务状态失败会落一条待办：用它作为"数据已落地"的锚点，避免在装载中做断言
    mocks.jobsList.mockRejectedValue(new Error('RPC 断开'));
    const { container } = renderHome();
    await screen.findByText(/任务状态取不到/);

    expect(screen.getByText(/把整部短剧放进来/)).toBeTruthy();
    expect(screen.getByText('选择多个视频文件即可建剧，素材留在原位置。')).toBeTruthy();
    const primaries = container.querySelectorAll<HTMLElement>('.ant-btn-primary');
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.textContent).toContain('新增项目');

    expectNoEnvCopy(container, ['三步开始', '装一个', '去下载', '去配置']);
    const body = container.querySelector<HTMLElement>('[data-testid="home-body"]');
    expect(body?.style.gridTemplateColumns).toBe('minmax(0, 1fr)');
  });
});
