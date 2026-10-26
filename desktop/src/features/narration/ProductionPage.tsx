/** 出片中心：③ 选模式出 K 条方案 → 勾选方案 → ④ 出片所选，成品入作品库。 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ExportJob, ModeRecommendation, NarrationMode, Project } from '@dramaclip/protocol';
import { PageHeader as PageKitHeader, PageShell } from '../../components/layout/PageKit';
import { MODE_INFO } from '../../components/modeMeta';
import { K_MAX, K_MIN, useModePicks } from './useModePicks';
import { exportApi, narrationApi, projectApi, settingsApi } from '../../services/client';
import { rememberDrama } from '../../stores/lastDrama';
import { useUiStore } from '../../stores/ui';
import { layout, tokens } from '../../styles/theme';
import { isLlmBlocked } from '../activation/activationView';
import { useActivation } from '../activation/useActivation';
import { ExportsCard } from './ExportsCard';
import { ModePicker } from './ModePicker';
import { PlanPickList } from './PlanPickList';
import { PlanQueue } from './PlanQueue';
import { avgCompletedBytes } from './produceView';
import { StyleSelectCard } from './StyleSelectCard';
import { useExportQueue } from './useExportQueue';
import { useFocusScroll } from './useFocusScroll';
import { usePlanBatch } from './usePlanBatch';

const ALL_MODES = MODE_INFO.map((item) => item.mode) as NarrationMode[];

/** K 默认初值读设置页同键 narration.variants_per_mode（键与消费端同源）；
 * 读不到、读脏或越界（K 下拉只有 1–8）就保持兜底值，不硬塞。 */
function useKDefault(serviceState: string, setDefaultK: (k: number) => void): void {
  useEffect(() => {
    if (serviceState !== 'ready') return;
    void settingsApi
      .get()
      .then((values) => {
        const parsed = Number.parseInt(values['narration.variants_per_mode'] ?? '', 10);
        if (Number.isFinite(parsed) && parsed >= K_MIN && parsed <= K_MAX) setDefaultK(parsed);
      })
      .catch(() => undefined);
  }, [serviceState, setDefaultK]);
}

/** ③ 区段容器：与 PageShell 同一节奏的纵向排布，focus 滚动的锚。 */
function sectionStyle(): React.CSSProperties {
  return { display: 'flex', flexDirection: 'column', gap: layout.page.gap };
}

/** 页面装载：拉项目详情（名称/集数/源集封面）+ 登记当前项目与最近打开的剧。
 * 卸载时清当前项目，但 rememberDrama 不清——「最近剧库」是跨页面的。 */
function useProductionProject(projectId: string): {
  project: Project | null;
  episodeCount: number;
  episodeCovers: Record<string, { cover: string | null; number: number }>;
} {
  const setCurrentProjectId = useUiStore((state) => state.setCurrentProjectId);
  const [project, setProject] = useState<Project | null>(null);
  const [episodeCount, setEpisodeCount] = useState(0);
  const [episodeCovers, setEpisodeCovers] = useState<
    Record<string, { cover: string | null; number: number }>
  >({});
  useEffect(() => {
    setCurrentProjectId(projectId === '' ? null : projectId);
    void projectApi.get(projectId).then((detail) => {
      setProject(detail.project);
      setEpisodeCount(detail.episodes.length);
      setEpisodeCovers(
        Object.fromEntries(
          detail.episodes.map((episode) => [
            episode.id,
            { cover: episode.cover_path ?? null, number: episode.episode_number },
          ]),
        ),
      );
      rememberDrama(detail.project.id, detail.project.name);
    });
    return () => {
      setCurrentProjectId(null);
    };
  }, [projectId, setCurrentProjectId]);
  return { project, episodeCount, episodeCovers };
}

/** 规划和渲染是两步：先看清 K 条方案各说什么，再决定出哪几条。 */
export function ProductionPage() {
  const { projectId = '' } = useParams();
  const serviceState = useUiStore((state) => state.serviceState);
  const [recommendation, setRecommendation] = useState<ModeRecommendation | null>(null);
  const [recLoading, setRecLoading] = useState(false);
  const [recSettled, setRecSettled] = useState(false);
  const [exports, setExports] = useState<ExportJob[] | null>(null);
  const { project, episodeCount, episodeCovers } = useProductionProject(projectId);
  const picks = useModePicks(projectId, project, recommendation, recSettled);
  const { planningRef, exportRef } = useFocusScroll();

  const reloadExports = useCallback(async () => {
    setExports(await exportApi.list(projectId));
  }, [projectId]);

  useEffect(() => {
    if (serviceState !== 'ready') return;
    void reloadExports();
  }, [reloadExports, serviceState]);

  // K 默认（09-10 §4.6「生产线默认值」）：初值读设置页同键，不写死 3；
  // 但上一批方案规格或用户已手选的 K 优先，晚到的全局默认不覆盖。
  useKDefault(serviceState, picks.setDefaultK);

  // AI 模式推荐：服务端随项目缓存（命中秒回，未命中现算并落缓存）。
  // 勾选初始化在 useModePicks：上一批方案 > 推荐 > 空。
  useEffect(() => {
    if (serviceState !== 'ready' || projectId === '') return;
    let cancelled = false;
    setRecLoading(true);
    setRecSettled(false);
    narrationApi
      .recommendModes(projectId)
      .then((rec) => {
        if (!cancelled) setRecommendation(rec);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) {
          setRecLoading(false);
          setRecSettled(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, serviceState]);

  const replaceModes = picks.replaceModes;
  const onRerollRecommendation = useCallback(() => {
    setRecLoading(true);
    narrationApi
      .recommendModes(projectId, true)
      .then((rec) => {
        setRecommendation(rec);
        // 显式重算=用户授权覆盖（同时把 K 视为已手选，晚到的默认值不覆盖）
        replaceModes(rec.modes.map((m) => m.mode) as NarrationMode[]);
      })
      .catch(() => undefined)
      .finally(() => {
        setRecLoading(false);
      });
  }, [projectId, replaceModes]);

  const batch = usePlanBatch(projectId);
  // 受管模型暂停：方案生成/重新推荐是 LLM 入口，禁用但不禁用页面其它本地操作
  const activation = useActivation();
  const llmBlocked = isLlmBlocked(activation.snapshot);

  const onGenerate = useCallback(
    (modes: NarrationMode[], k: number) => {
      void batch.run(modes, k); // 规格由 hook 记录（batch.spec），规划队列据此画骨架
    },
    [batch],
  );
  const queue = useExportQueue(reloadExports);
  // 磁盘预估系数：本剧已完成成片的实测均值（意见08「估」字要带得出出处）
  const avgBytes = useMemo(() => avgCompletedBytes(exports), [exports]);

  return (
    <PageShell>
      <PageHeader projectName={project?.name} />
      <div ref={planningRef} style={sectionStyle()}>
        <StyleSelectCard />
        <ModePicker
          batch={batch}
          modes={picks.modes}
          onGenerate={onGenerate}
          recommendation={recommendation}
          recLoading={recLoading}
          onReroll={onRerollRecommendation}
          k={picks.k}
          onToggleMode={picks.toggleMode}
          onSelectAll={() => {
            picks.replaceModes(ALL_MODES);
          }}
          onKChange={picks.setK}
          llmBlocked={llmBlocked}
        />
        {batch.planning ? (
          <PlanQueue batch={batch} spec={batch.spec} />
        ) : (
          <PlanPickList
            batch={batch}
            queue={queue}
            episodeCount={episodeCount}
            avgBytes={avgBytes}
            episodeCovers={episodeCovers}
          />
        )}
      </div>
      <div ref={exportRef}>
        <ExportsCard exports={exports} />
      </div>
    </PageShell>
  );
}

function PageHeader({ projectName }: { projectName?: string }): React.ReactElement {
  return (
    <PageKitHeader
      title={`${projectName ?? '…'} · 出片中心`}
      desc="先出方案再出片：AI 编排的角度、文案、配音在这一步看得见"
      actions={
        <Link to="/works" style={{ fontSize: tokens.text.body.size, lineHeight: tokens.text.body.leading, color: tokens.colorPrimary }}>
          前往作品库 →
        </Link>
      }
    />
  );
}
