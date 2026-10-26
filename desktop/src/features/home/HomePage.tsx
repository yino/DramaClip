/** 工作台（规格 desktop-workbench）：回答"今天该干什么"。
 *
 * 主区 = 继续创作 / 空态引导 + 成品类型说明，下方承接待办与剧矩阵。
 * 工作台不设环境/引擎右栏：模型、本地运行环境、FFmpeg 只在引擎中心、设置、
 * 关于页出现（规格「工作台不展示模型与环境信息」）。
 *
 * 原六块变四块的理由：芯片/成品/继续卡片各自只有一行信息量，摊开是三块地皮；
 * 矩阵一行一部剧，把同一部剧的阶段、卡点、成品数、继续入口收进一眼（卷三图 1）。
 * 「继续上次」不再是独立卡片——最近打开的剧在矩阵置顶 + 铺底 + 芯片点名。
 */
import { App as AntdApp } from 'antd';
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { JobInfo } from '@dramaclip/protocol';
import { PageShell } from '../../components/layout/PageKit';
import { CreateProjectModal } from '../project/CreateProjectModal';
import { useCreateProject } from '../project/useProjects';
import { restartService } from '../../services/client';
import { tokens } from '../../styles/theme';
import { DramaMatrix } from './DramaMatrix';
import { EmptyWorkbench, HomeGuide } from './EmptyWorkbench';
import { HomeCapabilityPanel } from './HomeCapabilityPanel';
import { ContinueHero } from './HomeContinueHero';
import { TodoList } from './TodoList';
import { buildStats, type WorkbenchStats } from './stats';
import { buildDramas, buildTodos, type FailedJob, type TodoItem } from './todos';
import { useWorkbench, type WorkbenchData } from './useWorkbench';

/** ref_id 是 project_id 的任务类型——与 todos.ts 的 JOB_ROUTES 同一批。
 *  这里再判一次是因为 ref_id 语义异构（export 的是 export_id、model_download 的是
 *  model_id），把它们的 ref_id 当 project_id 拼路径会跳错剧。 */
const PROJECT_JOB_TYPES = new Set(['prescreen', 'analysis', 'narration']);

/** 建剧与重启服务两个动作：状态 + 回调收拢，让 HomePage 只剩编排。
 * 「新增项目」只开统一弹窗（4.4）：绝不先弹系统文件夹/文件对话框；
 * 选文件与建项目都在弹窗内完成，成功后由 useCreateProject 跳转。 */
function useHomeActions() {
  const { message } = AntdApp.useApp();
  const [createOpen, setCreateOpen] = useState(false);
  const createProject = useCreateProject();

  const openCreate = useCallback(() => {
    setCreateOpen(true);
  }, []);
  const closeCreate = useCallback(() => {
    setCreateOpen(false);
  }, []);

  const onRestart = useCallback(() => {
    restartService().catch((error: unknown) => {
      message.error(error instanceof Error ? error.message : String(error));
    });
  }, [message]);

  return { createOpen, openCreate, closeCreate, createProject, onRestart };
}

export function HomePage() {
  const { data, ready } = useWorkbench();
  const { createOpen, openCreate, closeCreate, createProject, onRestart } = useHomeActions();

  const dramas = buildDramas(data.projects, data.works);
  const todos = buildTodos({
    serviceDown: !ready,
    dramas,
    failedJobs: failedJobs(data.jobs),
    jobsAvailable: data.jobsAvailable,
    jobsError: data.jobsError,
    serverTimeMs: data.serverTimeMs,
  });
  const stats = buildStatsFromData(data);
  const hasDramas = data.projects.length > 0;

  return (
    <PageShell>
      <HomeBody
        data={data}
        todos={todos}
        stats={stats}
        hasDramas={hasDramas}
        creating={false}
        onCreate={openCreate}
        onRestart={onRestart}
      />
      <CreateProjectModal open={createOpen} onClose={closeCreate} onCreate={createProject} />
    </PageShell>
  );
}

/** 单列主体内部先铺一张双列引导台，再接待办与剧矩阵。
 *  工作台不设环境/引擎右栏——那些信息只在引擎中心、设置、关于页出现。 */
function HomeBody({
  data,
  todos,
  stats,
  hasDramas,
  creating,
  onCreate,
  onRestart,
}: {
  data: WorkbenchData;
  todos: TodoItem[];
  stats: WorkbenchStats;
  hasDramas: boolean;
  creating: boolean;
  onCreate: () => void;
  onRestart: () => void;
}): React.ReactElement {
  const navigate = useNavigate();
  return (
    <div
      data-testid="home-body"
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr)',
        gap: tokens.space2xl,
        minWidth: 0,
      }}
    >
      <div className="home-top-grid" style={{ gap: tokens.spaceXl }}>
        {hasDramas ? (
          <ContinueHero
            projects={data.projects}
            works={data.works}
            jobs={data.jobs}
            serverTimeMs={data.serverTimeMs}
            stats={stats}
            onCreate={onCreate}
            onNavigate={(path) => {
              void navigate(path);
            }}
          />
        ) : (
          <EmptyWorkbench creating={creating} onCreate={onCreate} />
        )}
        <HomeCapabilityPanel />
      </div>
      <TodoList
        items={todos}
        onNavigate={(path) => {
          void navigate(path);
        }}
        onRestartService={onRestart}
      />
      {hasDramas ? (
        <DramaMatrix
          projects={data.projects}
          works={data.works}
          jobs={data.jobs}
          serverTimeMs={data.serverTimeMs}
          etaLabel={stats.runningEtaLabel}
          onNavigate={(route) => {
            void navigate(route);
          }}
        />
      ) : (
        <HomeGuide />
      )}
    </div>
  );
}

function failedJobs(jobs: readonly JobInfo[]): FailedJob[] {
  // 同项目同类型已有更新（pending/running）的在跑作业 → 旧失败自动过期，不再待办
  const superseded = new Set(
    jobs
      .filter((job) => (job.status === 'pending' || job.status === 'running') && PROJECT_JOB_TYPES.has(job.type))
      .map((job) => `${job.type}:${job.ref_id ?? ''}`),
  );
  return jobs
    .filter(
      (job) =>
        job.status === 'failed' &&
        PROJECT_JOB_TYPES.has(job.type) &&
        !superseded.has(`${job.type}:${job.ref_id ?? ''}`),
    )
    .map((job) => ({
      id: job.id,
      type: job.type,
      refId: job.ref_id ?? null,
      error: job.error ?? '',
    }));
}

function buildStatsFromData(data: WorkbenchData): WorkbenchStats {
  return buildStats({
    dramaCount: data.projects.length,
    running: data.jobs
      .filter((job) => job.status === 'running' || job.status === 'pending')
      .map((job) => ({ id: job.id, progress: job.progress, createdAtMs: job.created_at })),
    serverTimeMs: data.serverTimeMs,
    jobsAvailable: data.jobsAvailable,
    works: data.works,
  });
}

