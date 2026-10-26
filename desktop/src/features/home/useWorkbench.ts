/** 工作台数据装载：一次并发取全，服务就绪前不发请求。
 *
 * "就绪前不发"沿用 HomePage 既有的时序修复——服务就绪前发起的 RPC
 * 会失败，否则每次冷启都会打出一串红色 message。
 *
 * 三个数据源全部是既有方法，本片零后端：
 *   project.list · export.list_works · jobs.list
 *
 * 不调 models.list / settings.get：工作台不展示模型、引擎与本地运行环境
 * （规格 desktop-workbench「工作台不展示模型与环境信息」）。这些状态只在
 * 引擎中心、设置、关于页出现，工作台不必为不显示的字段付两次 RPC。
 *
 * 不调 project.dashboard_summary：它唯一的用处是 project_count，而 projects.length
 * 就是同一个数；它的 export_count 反而不可用（见 stats.ts 顶部注释）。少一次 RPC。
 *
 * 不调 analysis.results：它按剧逐个取，是 N+1，且每次会把该剧全部 ASR 段拖回来。
 * 失败任务的 error 原文改从 jobs.list 拿——一次 RPC，jobs 行里有 error。
 */
import { useCallback, useEffect, useState } from 'react';
import type { JobInfo, JobsListResult, Project, WorkItem } from '@dramaclip/protocol';
import { jobsApi, listWorks, projectApi } from '../../services/client';
import { useUiStore } from '../../stores/ui';
import { WORKS_SCAN_LIMIT } from './stats';

/** jobs 扫描上限。schema 的 maximum 是 200（protocol/schemas/jobs.json），超了服务端钳回来。 */
export const JOBS_SCAN_LIMIT = 200;

export interface WorkbenchData {
  readonly projects: Project[];
  readonly jobs: JobInfo[];
  /** jobs.list 是否取到；取不到时 jobsError 是原因原文。 */
  readonly jobsAvailable: boolean;
  readonly jobsError: string | null;
  readonly serverTimeMs: number;
  readonly works: WorkItem[];
}

const EMPTY: WorkbenchData = {
  projects: [],
  jobs: [],
  jobsAvailable: false,
  jobsError: null,
  serverTimeMs: 0,
  works: [],
};

export interface Workbench {
  readonly data: WorkbenchData;
  readonly ready: boolean;
  readonly reload: () => Promise<void>;
}

export function useWorkbench(): Workbench {
  const serviceState = useUiStore((state) => state.serviceState);
  const [data, setData] = useState<WorkbenchData>(EMPTY);

  const reload = useCallback(async () => {
    const [projects, works, jobs] = await Promise.all([
      projectApi.list(),
      listWorks(WORKS_SCAN_LIMIT).catch((): WorkItem[] => []),
      jobsApi
        .list(JOBS_SCAN_LIMIT)
        .then((result): JobsListResult | Error => result)
        .catch((error: unknown): JobsListResult | Error =>
          error instanceof Error ? error : new Error(String(error)),
        ),
    ]);
    setData({
      projects,
      jobs: jobs instanceof Error ? [] : jobs.jobs,
      jobsAvailable: !(jobs instanceof Error),
      jobsError: jobs instanceof Error ? `${jobs.name}: ${jobs.message}` : null,
      // 服务端时钟优先：ETA 与周增都要与 created_at/completed_at 同量纲同源。
      // jobs.list 取不到时退回本机时钟——次优，但拿 0 当"现在"更糟。
      serverTimeMs: jobs instanceof Error ? Date.now() : jobs.server_time_ms,
      works,
    });
  }, []);

  useEffect(() => {
    if (serviceState === 'ready') void reload();
  }, [reload, serviceState]);

  return { data, ready: serviceState === 'ready', reload };
}
