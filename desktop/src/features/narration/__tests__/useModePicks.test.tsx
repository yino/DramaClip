// @vitest-environment jsdom
/**
 * 出片中心的模式勾选初始化：上一批方案规格 > AI 推荐 > 空。
 *
 * 2026-10-24 真机回归：只勾「高光混剪」生成方案、出片后返回，页面按 AI 推荐勾成
 * 三个模式。服务端已把上一批 {modes,k} 写进项目设置，这里钉住恢复顺序与手选不被
 * 晚到的异步默认值覆盖。
 */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ModeRecommendation, Project } from '@dramaclip/protocol';
import { DEFAULT_K, useModePicks } from '../useModePicks';

function makeProject(id = 'p1', settings: Record<string, unknown> = {}): Project {
  return {
    id,
    name: '猛鬼宿舍',
    source_path: '/media/shows',
    status: 'ready',
    created_at: 1,
    episode_count: 1,
    settings,
  };
}

const RECOMMENDATION: ModeRecommendation = {
  modes: [
    { mode: 'ultra_short_hook', reason: '超短悬念' },
    { mode: 'highlight_cut', reason: '高密度反转' },
    { mode: 'cross_narration', reason: '双线交叉' },
  ],
};

interface Props {
  id: string;
  project: Project | null;
  recommendation: ModeRecommendation | null;
  settled: boolean;
}

function renderPicks(initial: Props) {
  return renderHook(
    (props: Props) => useModePicks(props.id, props.project, props.recommendation, props.settled),
    { initialProps: initial },
  );
}

describe('useModePicks', () => {
  it('有上一批方案时恢复当时的模式与 K，不被 AI 推荐覆盖', () => {
    const { result } = renderPicks({
      id: 'p1',
      project: makeProject('p1', {
        last_plan_batch: { batch_id: 'b1', modes: ['highlight_cut'], k: 1 },
      }),
      recommendation: RECOMMENDATION,
      settled: true,
    });
    expect(result.current.modes).toEqual(['highlight_cut']);
    expect(result.current.k).toBe(1);
  });

  it('从未生成过方案的新项目：回退到 AI 推荐', () => {
    const { result } = renderPicks({
      id: 'p1',
      project: makeProject(),
      recommendation: RECOMMENDATION,
      settled: true,
    });
    expect(result.current.modes).toEqual(['ultra_short_hook', 'highlight_cut', 'cross_narration']);
  });

  it('推荐未落定时等它落定再勾；项目详情先到也不提前按空推荐初始化', () => {
    const empty: ModeRecommendation = { modes: [] };
    const { result, rerender } = renderPicks({
      id: 'p1',
      project: makeProject(),
      recommendation: empty,
      settled: false,
    });
    expect(result.current.modes).toEqual([]);

    rerender({ id: 'p1', project: makeProject(), recommendation: RECOMMENDATION, settled: true });
    expect(result.current.modes).toEqual(['ultra_short_hook', 'highlight_cut', 'cross_narration']);
  });

  it('用户先手选：晚到的上一批规格不覆盖', () => {
    const { result, rerender } = renderPicks({
      id: 'p1',
      project: null,
      recommendation: null,
      settled: false,
    });
    act(() => {
      result.current.toggleMode('cross_narration');
    });

    rerender({
      id: 'p1',
      project: makeProject('p1', { last_plan_batch: { modes: ['highlight_cut'], k: 1 } }),
      recommendation: null,
      settled: false,
    });
    expect(result.current.modes).toEqual(['cross_narration']);
  });

  it('全局默认 K 晚到：不覆盖上一批方案或用户已选的 K', () => {
    const { result } = renderPicks({
      id: 'p1',
      project: makeProject('p1', { last_plan_batch: { modes: ['highlight_cut'], k: 1 } }),
      recommendation: null,
      settled: false,
    });
    act(() => {
      result.current.setDefaultK(5);
    });
    expect(result.current.k).toBe(1);

    act(() => {
      result.current.setK(2);
      result.current.setDefaultK(7);
    });
    expect(result.current.k).toBe(2);
  });

  it('没有上一批规格时，全局默认 K 仍生效', () => {
    const { result } = renderPicks({
      id: 'p1',
      project: makeProject(),
      recommendation: null,
      settled: true,
    });
    act(() => {
      result.current.setDefaultK(4);
    });
    expect(result.current.k).toBe(4);
  });

  it('形状不对的 last_plan_batch 当没有：未知模式被忽略后为空则回退推荐', () => {
    const { result } = renderPicks({
      id: 'p1',
      project: makeProject('p1', { last_plan_batch: { modes: ['gone_mode'], k: 99 } }),
      recommendation: RECOMMENDATION,
      settled: true,
    });
    expect(result.current.modes).toEqual(['ultra_short_hook', 'highlight_cut', 'cross_narration']);
    expect(result.current.k).toBe(DEFAULT_K);
  });

  it('切项目：清空旧勾选并应用新项目的上一批规格', () => {
    const { result, rerender } = renderPicks({
      id: 'p1',
      project: makeProject('p1', { last_plan_batch: { modes: ['highlight_cut'], k: 1 } }),
      recommendation: null,
      settled: false,
    });
    expect(result.current.modes).toEqual(['highlight_cut']);

    rerender({
      id: 'p2',
      project: makeProject('p2', { last_plan_batch: { modes: ['intro_narration'], k: 2 } }),
      recommendation: null,
      settled: false,
    });
    expect(result.current.modes).toEqual(['intro_narration']);
    expect(result.current.k).toBe(2);
  });
});
