// @vitest-environment jsdom
/** 暂停态拦截 LLM 入口（desktop-activation 9.3）：按钮禁用 + 统一提示，本地功能不受影响。 */
import { App as AntdApp } from 'antd';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { ModeRecommendation, NarrationMode } from '@dramaclip/protocol';
import { ModePicker } from '../ModePicker';
import type { PlanBatch } from '../usePlanBatch';

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
      // 仅测试挂载
    }

    unobserve(): void {
      // 仅测试挂载
    }

    disconnect(): void {
      // 仅测试挂载
    }
  }
  globalThis.ResizeObserver = NoResizeObserver;
});

function batch(): PlanBatch {
  return {
    planning: false,
    percent: 0,
    stageText: '',
    plans: [],
    failDetail: '',
    batchId: null,
    spec: null,
    error: '',
    run: vi.fn(() => Promise.resolve(undefined)),
    cancel: vi.fn(() => Promise.resolve(undefined)),
  };
}

const RECOMMENDATION: ModeRecommendation = {
  modes: [{ mode: 'raw_clip', reason: '素材完整' }],
};

function mountPicker(llmBlocked: boolean): void {
  render(
    <AntdApp>
      <ModePicker
        batch={batch()}
        modes={['raw_clip'] as NarrationMode[]}
        k={3}
        recommendation={RECOMMENDATION}
        onReroll={() => undefined}
        onGenerate={() => undefined}
        onToggleMode={() => undefined}
        onSelectAll={() => undefined}
        onKChange={() => undefined}
        llmBlocked={llmBlocked}
      />
    </AntdApp>,
  );
}

afterEach(() => {
  cleanup();
});

it('暂停态：生成方案与重新推荐禁用，并显示暂停提示', () => {
  mountPicker(true);

  expect(screen.getByText(/受管模型已暂停/)).toBeTruthy();
  expect(screen.getByText(/本地转写、字幕、剪辑与导出不受影响/)).toBeTruthy();
  expect(screen.getByRole('button', { name: '生成方案' })).toHaveProperty('disabled', true);
  expect(screen.getByRole('button', { name: '重新推荐' })).toHaveProperty('disabled', true);
  // 本地模式勾选/全选仍可用
  expect(screen.getByRole('button', { name: /全\s*选/ })).toHaveProperty('disabled', false);
});

it('正常态：不出现暂停提示，生成方案可用', () => {
  mountPicker(false);

  expect(screen.queryByText(/受管模型已暂停/)).toBeNull();
  expect(screen.getByRole('button', { name: '生成方案' })).toHaveProperty('disabled', false);
});
