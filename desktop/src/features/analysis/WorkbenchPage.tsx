/** 项目详情工作台：步骤导航 + 转写档位 + 左素材列表 + 右复合面板（分割线可拖拽）。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Alert, App as AntdApp } from 'antd';
import type { AnalysisResults } from '@dramaclip/protocol';
import { analysisApi, asrApi, revealInFolder } from '../../services/client';
import { layout, tokens } from '../../styles/theme';
import { prescreenCoverage } from './analysisView';
import { AnalysisFailureAlert, describeAnalysisFailure } from './asrErrors';
import type { AnalysisFailure } from './asrErrors';
import { useAnalysisWorkspace } from './useAnalysisWorkspace';
import { useEpisodeOrder } from './useEpisodeOrder';
import { useProjectDetail, useEpisodeReorder } from './useProjectDetail';
import { useSplitDrag } from './useSplit';
import { useTranscribeTier } from './useTranscribeTier';
import { WorkbenchHeader } from './WorkbenchHeader';
import { PageFooter } from '../../components/layout/PageKit';
import { EpisodeListPanel } from './EpisodeListPanel';
import { useAddMaterial } from './useAddMaterial';
import { EpisodeDetail } from './EpisodeDetail';
import { useCloudNoticeGate } from './CloudNotice';

/** 分析工作台页（路由 /projects/:id/analysis）。 */
export function WorkbenchPage() {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  const { message } = AntdApp.useApp();
  const workspace = useAnalysisWorkspace(projectId);
  const { project, reloadProject } = useProjectDetail(projectId);
  const onReorder = useEpisodeReorder(projectId, reloadProject);
  // 首次云端识别告知：只在开始分析前拦一次；本地引擎、非托管云端都不弹。
  const cloudNotice = useCloudNoticeGate({
    navigate: (path) => {
      void navigate(path);
    },
    onError: (text) => {
      message.error(`切换本地识别没成：${text}`);
    },
  });
  // 新增素材与「重新扫描」不同：只追加、不重扫、不自动分析。刷新同时覆盖左侧列表
  // 与项目统计（workspace.reload 重拉项目+集；reloadProject 同步页头项目态）。
  const material = useAddMaterial(projectId, async () => {
    await Promise.all([reloadProject(), workspace.reload()]);
  });
  const onTierError = (text: string): void => {
    message.error(`转写档位没存上：${text}`);
  };
  const tierState = useTranscribeTier(projectId, project, onTierError);

  // 分析失败横幅：-32205 / 402 给同一套人话口径与「切换本地识别」入口（spec §75-99）。
  const [failure, setFailure] = useState<AnalysisFailure | null>(null);
  const reportFailure = useCallback((error: unknown): void => {
    const initial = describeAnalysisFailure(error);
    if (initial === null) return;
    setFailure(initial);
    if (initial.kind !== 'credits') return;
    // 402 原文未必带全已用/上限：补一次余额查询；查询失败保留原文，不盖掉真失败。
    asrApi
      .credits()
      .then((credits) => {
        const enriched = describeAnalysisFailure(error, credits);
        if (enriched !== null) setFailure(enriched);
      })
      .catch(() => undefined);
  }, []);
  // 整批失败由轮询把 job.status 落到 failed：同一次作业只报一次，后续轮询不重复弹。
  const reportedJobId = useRef('');
  useEffect(() => {
    const job = workspace.job;
    if (job?.status !== 'failed') return;
    if (reportedJobId.current === job.job_id) return;
    reportedJobId.current = job.job_id;
    reportFailure(job.error ?? '分析失败，请稍后重试');
  }, [workspace.job, reportFailure]);

  const running = workspace.job?.status === 'running' || workspace.job?.status === 'pending';
  const doneCount = workspace.episodes.filter((episode) => episode.status === 'done').length;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spaceLg, height: '100%' }}>
      <WorkbenchHeader
        projectId={projectId}
        project={project}
        total={workspace.episodes.length}
        doneCount={doneCount}
        running={running}
        progressPercent={running && workspace.job !== null ? workspace.job.progress : 0}
        tier={tierState.tier}
        onTierChange={tierState.setTier}
        onBatchAnalyze={() => {
          setFailure(null);
          const action = tierState.tier === 'recommended' ? workspace.startPrescreen : workspace.start;
          void cloudNotice.guard(() => {
            runAnalysis(action, reportFailure);
          });
        }}
        onCancel={() => {
          startAnalysis(workspace.cancel, message);
        }}
        onExportTranscripts={() => {
          exportTranscripts(projectId, message);
        }}
      />
      <AnalysisFailureAlert
        failure={failure}
        onSwitchLocal={() => {
          void navigate('/engines/asr');
        }}
        onDismiss={() => {
          setFailure(null);
        }}
      />
      <CoverageAlert results={workspace.results} />
      <TwoColumns
        projectId={projectId}
        episodes={workspace.episodes}
        results={workspace.results}
        activeEpisodeId={workspace.activeEpisodeId}
        selectedIds={workspace.selectedIds}
        running={running}
        adding={material.adding}
        onAddMaterial={() => {
          void material.addMaterial();
        }}
        onActivate={workspace.setActiveEpisodeId}
        onToggle={workspace.toggleSelected}
        onReorder={onReorder}
        onReload={() => {
          void workspace.reload();
        }}
      />
      <WorkbenchFooter projectId={projectId} doneCount={doneCount} />
      {cloudNotice.element}
    </div>
  );
}

/** 金色覆盖度告警（静默清单第 1 条·输入覆盖度）：预筛只放行一部分集时必须说出口，
 * 不说不等于没发生——其余集的台词根本没进模型视野。导出供单测直钉。 */
export function CoverageAlert({ results }: { results: AnalysisResults | null }): React.ReactElement | null {
  const coverage = prescreenCoverage(results);
  if (coverage === null || coverage.notRecommended === 0) return null;
  return (
    <Alert
      type="warning"
      showIcon
      title={`预筛只放行 ${String(coverage.recommended)}/${String(coverage.prescreened)} 集进入精转——其余 ${String(coverage.notRecommended)} 集的台词没有进入模型视野；改选「全部精转」重跑可补齐`}
    />
  );
}

function WorkbenchFooter({ projectId, doneCount }: { projectId: string; doneCount: number }): React.ReactElement {
  const navigate = useNavigate();
  return (
    <PageFooter
      step={1}
      total={4}
      canProceed={doneCount > 0}
      proceedHint={
        doneCount === 0
          ? '完成至少一集分析后进入出片'
          : `已完成 ${String(doneCount)} 集 · 到出片中心选择模式`
      }
      lockedHint="完成至少一集分析后解锁"
      nextLabel="选择出片模式"
      onPrev={() => {
        void navigate('/projects');
      }}
      onNext={() => {
        void navigate(`/projects/${projectId}/produce`);
      }}
    />
  );
}

/** 启动分析：失败交给页面横幅（云端识别类带切换本地入口），不再只闪一条 toast。 */
function runAnalysis(
  start: () => Promise<void>,
  onFailure: (error: unknown) => void,
): void {
  start().catch(onFailure);
}

function startAnalysis(
  start: () => Promise<void>,
  message: { error: (text: string) => void },
): void {
  start().catch((error: unknown) => {
    message.error(error instanceof Error ? error.message : String(error));
  });
}

/** 全部已分析集一次性导出（逐集 SRT + 全剧台词 TXT），完成自动打开导出目录。 */
function exportTranscripts(
  projectId: string,
  message: { success: (text: string) => void; error: (text: string) => void },
): void {
  analysisApi
    .exportTranscripts(projectId)
    .then((result) => {
      message.success(
        `已导出 ${String(result.exported)} 集转写${result.skipped > 0 ? `（跳过未分析 ${String(result.skipped)} 集）` : ''}`,
      );
      void revealInFolder(result.txt_path);
    })
    .catch((error: unknown) => {
      message.error(error instanceof Error ? error.message : String(error));
    });
}

interface TwoColumnsProps {
  projectId: string;
  episodes: ReturnType<typeof useAnalysisWorkspace>['episodes'];
  results: ReturnType<typeof useAnalysisWorkspace>['results'];
  activeEpisodeId: string | null;
  selectedIds: readonly string[];
  running: boolean;
  adding: boolean;
  onAddMaterial: () => void;
  onActivate: (id: string) => void;
  onToggle: (id: string, checked: boolean) => void;
  onReorder: (orderedIds: string[]) => void;
  onReload: () => void;
}

function TwoColumns(props: TwoColumnsProps): React.ReactElement {
  const { pct, containerRef, onHandleDown } = useSplitDrag();
  const order = useEpisodeOrder(props.episodes, props.onReorder);
  return (
    <div
      ref={containerRef}
      style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'stretch' }}
    >
      <div style={{ width: `${String(pct)}%`, minWidth: layout.split.minWidth, overflowY: 'auto' }}>
        <EpisodeListPanel
          orderedIds={order.orderedIds}
          byId={order.byId}
          highlights={props.results?.highlights ?? {}}
          activeEpisodeId={props.activeEpisodeId}
          selectedIds={props.selectedIds}
          running={props.running}
          adding={props.adding}
          onAddMaterial={props.onAddMaterial}
          onActivate={props.onActivate}
          onToggle={props.onToggle}
          dragIndex={order.dragIndex}
          overIndex={order.overIndex}
          setOverIndex={order.setOverIndex}
          onDragStart={order.onDragStart}
          onDrop={order.drop}
          onMove={order.move}
        />
      </div>
      <div
        onPointerDown={onHandleDown}
        style={{ width: layout.split.handle, cursor: 'col-resize', flexShrink: 0, background: tokens.borderSecondary }}
      />
      <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', paddingLeft: layout.split.paddingX }}>
        <EpisodeDetail
          projectId={props.projectId}
          episodes={props.episodes}
          activeEpisodeId={props.activeEpisodeId}
          results={props.results}
          onReload={props.onReload}
        />
      </div>
    </div>
  );
}
