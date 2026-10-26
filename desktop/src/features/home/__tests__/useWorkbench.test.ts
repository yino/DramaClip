/** 工作台数据装载：只取项目/成品/任务；models.list 与 settings.get 已随环境右栏移除。 */
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUiStore } from '../../../stores/ui';
import { JOBS_SCAN_LIMIT, useWorkbench } from '../useWorkbench';

const mocks = vi.hoisted(() => ({
  projectList: vi.fn(),
  listWorks: vi.fn(),
  jobsList: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('../../../services/client', () => ({
  projectApi: { list: mocks.projectList },
  listWorks: mocks.listWorks,
  jobsApi: { list: mocks.jobsList },
  rpc: mocks.rpc,
  onServiceEvent: vi.fn(() => () => undefined),
}));

const NOW = 1_760_000_000_000;

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({ serviceState: 'ready' });
});

afterEach(() => {
  useUiStore.setState({ serviceState: 'starting' });
});

describe('useWorkbench', () => {
  it('只请求项目、成品、任务，不再取 models.list / settings.get', async () => {
    mocks.projectList.mockResolvedValue([]);
    mocks.listWorks.mockResolvedValue([]);
    mocks.jobsList.mockResolvedValue({ jobs: [], server_time_ms: NOW });

    const { result } = renderHook(() => useWorkbench());
    await waitFor(() => {
      expect(result.current.data.jobsAvailable).toBe(true);
    });

    expect(mocks.projectList).toHaveBeenCalledTimes(1);
    expect(mocks.listWorks).toHaveBeenCalledTimes(1);
    expect(mocks.jobsList).toHaveBeenCalledWith(JOBS_SCAN_LIMIT);
    expect(mocks.rpc).not.toHaveBeenCalled();
    // 工作台不再持有模型/LLM/TTS 字段——没有消费方，也不该被请求
    expect(Object.keys(result.current.data).sort()).toEqual([
      'jobs',
      'jobsAvailable',
      'jobsError',
      'projects',
      'serverTimeMs',
      'works',
    ]);
  });

  it('jobs.list 失败时如实标不可用，时钟退回本机', async () => {
    mocks.projectList.mockResolvedValue([]);
    mocks.listWorks.mockResolvedValue([]);
    mocks.jobsList.mockRejectedValue(new Error('RPC 断开'));
    const before = Date.now();

    const { result } = renderHook(() => useWorkbench());
    await waitFor(() => {
      expect(result.current.data.jobsError).toContain('RPC 断开');
    });
    expect(result.current.data.jobsAvailable).toBe(false);
    expect(result.current.data.serverTimeMs).toBeGreaterThanOrEqual(before);
  });
});
