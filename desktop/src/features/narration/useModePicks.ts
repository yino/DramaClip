/** ③ 模式勾选的初始化优先级：**上一次提交的方案规格 > AI 推荐 > 空**。
 *
 * 从作品库/出片记录回到出片中心时页面会重挂载，若只按 AI 推荐预填，用户明明只勾了
 * 「高光混剪」，回来却变成推荐的三个模式（2026-10-24 真机反馈）。服务端在创建规划
 * 批次时已把 `{modes,k}` 写进项目设置 `last_plan_batch`，这里优先用它恢复现场；
 * 只有从未生成过方案的新项目，才回退到 AI 推荐。用户一旦手选（含重新推荐/改 K），
 * 任何异步到达的默认值都不再覆盖。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModeRecommendation, NarrationMode, Project } from '@dramaclip/protocol';
import { MODE_INFO } from '../../components/modeMeta';

/** K 的兜底值与合法区间：与服务端 narration.variants_per_mode / ModePicker 下拉同口径。 */
export const DEFAULT_K = 3;
export const K_MIN = 1;
export const K_MAX = 8;

const KNOWN_MODES: readonly NarrationMode[] = MODE_INFO.map((item) => item.mode as NarrationMode);

function clampK(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= K_MIN && value <= K_MAX
    ? value
    : null;
}

/** 读项目设置里的上一批规划规格；形状不对就当没有（不阻塞推荐兜底）。 */
export function readLastPlanBatch(
  settings: Record<string, unknown> | undefined,
): { modes: NarrationMode[]; k: number } | null {
  const stored = settings?.last_plan_batch;
  if (stored === null || typeof stored !== 'object') return null;
  const rawModes: unknown = (stored as { modes?: unknown }).modes;
  if (!Array.isArray(rawModes)) return null;
  const modes = rawModes.filter(
    (mode): mode is NarrationMode =>
      typeof mode === 'string' && KNOWN_MODES.includes(mode as NarrationMode),
  );
  if (modes.length === 0) return null;
  return { modes, k: clampK((stored as { k?: unknown }).k) ?? DEFAULT_K };
}

export interface ModePicks {
  modes: NarrationMode[];
  k: number;
  toggleMode: (mode: NarrationMode) => void;
  replaceModes: (modes: NarrationMode[]) => void;
  setK: (k: number) => void;
  /** 全局默认 K（设置页）到达时调用：不覆盖上一批方案或用户已选的 K。 */
  setDefaultK: (k: number) => void;
}

export function useModePicks(
  projectId: string,
  project: Project | null,
  recommendation: ModeRecommendation | null,
  recommendationSettled: boolean,
): ModePicks {
  const [modes, setModes] = useState<NarrationMode[]>([]);
  const [k, setKState] = useState<number>(DEFAULT_K);
  const userPickedRef = useRef(false);
  const initializedRef = useRef(false);
  const batchKRef = useRef(false);

  // 切项目必须重来：路由参数变化不重挂组件，旧项目的勾选不能带到新项目。
  useEffect(() => {
    userPickedRef.current = false;
    initializedRef.current = false;
    batchKRef.current = false;
    setModes([]);
    setKState(DEFAULT_K);
  }, [projectId]);

  useEffect(() => {
    // 切项目时旧 project 会短暂留任，等新项目详情到位再初始化。
    if (initializedRef.current || project?.id !== projectId) return;
    const lastBatch = readLastPlanBatch(project.settings);
    if (lastBatch !== null) {
      if (!userPickedRef.current) {
        setModes(lastBatch.modes);
        setKState(lastBatch.k);
        batchKRef.current = true;
      }
      initializedRef.current = true;
      return;
    }
    // 没有历史方案：等推荐落定（成功或失败）再决定默认勾选，避免推荐晚到覆盖手选。
    if (!recommendationSettled) return;
    if (!userPickedRef.current && recommendation !== null) {
      setModes(recommendation.modes.map((item) => item.mode) as NarrationMode[]);
    }
    initializedRef.current = true;
  }, [project, projectId, recommendation, recommendationSettled]);

  const toggleMode = useCallback((mode: NarrationMode) => {
    userPickedRef.current = true;
    setModes((prev) => (prev.includes(mode) ? prev.filter((item) => item !== mode) : [...prev, mode]));
  }, []);

  const replaceModes = useCallback((next: NarrationMode[]) => {
    userPickedRef.current = true;
    setModes(next);
  }, []);

  const setK = useCallback((next: number) => {
    userPickedRef.current = true;
    setKState(next);
  }, []);

  const setDefaultK = useCallback((next: number) => {
    if (userPickedRef.current || batchKRef.current) return;
    setKState(next);
  }, []);

  return { modes, k, toggleMode, replaceModes, setK, setDefaultK };
}
