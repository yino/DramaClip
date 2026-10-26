// @vitest-environment jsdom
/**
 * 分析失败提示（spec desktop-cloud-asr §75-99）：
 * -32205 说「云端识别未就绪，请重新激活或联网」；积分不足说人话并给切换本地入口；
 * Python 堆栈不上界面；没有自动重试按钮。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { AsrCredits } from '@dramaclip/protocol';
import {
  ASR_CREDITS_TEXT,
  ASR_NOT_READY_TEXT,
  AnalysisFailureAlert,
  creditLine,
  describeAnalysisFailure,
  readableText,
  rpcErrorCode,
} from '../asrErrors';

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
      // Alert 不依赖布局尺寸；保留空实现避开 jsdom 缺口
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

afterEach(cleanup);

const exhausted: AsrCredits = {
  available: true,
  limit: 120,
  used: 120,
  remaining: 0,
  unit: 'minute',
  updated_at: '2026-10-24T00:00:00Z',
};

it('RPC 错误码从 `[code]` 前缀解析；没有前缀是 null', () => {
  expect(rpcErrorCode(new Error('[-32205] 云端识别未就绪：请重新激活或联网后重试'))).toBe(-32205);
  expect(rpcErrorCode(new Error('普通错误'))).toBeNull();
  expect(rpcErrorCode(undefined)).toBeNull();
});

it('-32205 配置未就绪：固定文案 + 切换本地入口，不带服务端堆栈', () => {
  const failure = describeAnalysisFailure(
    new Error('[-32205] 云端识别未就绪：请重新激活或联网后重试'),
  );
  expect(failure).toMatchObject({ kind: 'not-ready', title: ASR_NOT_READY_TEXT, switchLocal: true });
  expect(failure?.title).toBe('云端识别未就绪，请重新激活或联网');
  expect(failure?.detail).toBe('');
});

it('-32205 积分不足：文案说积分并带余额明细', () => {
  const failure = describeAnalysisFailure(
    new Error('[-32205] 云端识别积分不足：请补充积分或切换本地引擎'),
    exhausted,
  );
  expect(failure?.title).toBe(ASR_CREDITS_TEXT);
  expect(failure?.kind).toBe('credits');
  expect(failure?.switchLocal).toBe(true);
  expect(failure?.detail).toBe('已用 120.00/120.00 分钟，剩余 0.00 分钟');
  expect(creditLine(exhausted)).toBe(failure?.detail);
});

it('网关 402 原文（已用/上限/所需）：保留明细，仍给切换本地入口', () => {
  const failure = describeAnalysisFailure(
    new Error(
      '[-32603] 云端识别积分不足（HTTP 402 asr_credits_exhausted）：已用 120/120 积分，本次需要 6 积分；请补充积分或切换本地引擎',
    ),
  );
  expect(failure?.kind).toBe('credits');
  expect(failure?.detail).toContain('本次需要 6 积分');
  expect(failure?.switchLocal).toBe(true);
});

it('Python traceback 被裁掉，界面只留人话', () => {
  const raw = [
    '[-32603] 分析失败',
    'Traceback (most recent call last):',
    '  File "/srv/dramaclip/analysis.py", line 12, in run',
    '    raise RuntimeError("boom")',
    'RuntimeError: boom',
  ].join('\n');
  expect(readableText(raw)).toBe('分析失败');
  const failure = describeAnalysisFailure(new Error(raw));
  expect(failure?.kind).toBe('failed');
  expect(failure?.title).toBe('分析失败');
  expect(failure?.title).not.toContain('Traceback');
  expect(failure?.title).not.toContain('File "');
});

it('未知失败保留可读原文；空错误不弹横幅', () => {
  expect(describeAnalysisFailure(new Error('磁盘空间不足，转写未开始'))?.kind).toBe('failed');
  expect(describeAnalysisFailure('')).toBeNull();
  expect(describeAnalysisFailure(null)).toBeNull();
});

it('横幅给出切换本地入口，不提供自动重试', () => {
  const onSwitchLocal = vi.fn();
  render(
    <AnalysisFailureAlert
      failure={describeAnalysisFailure(
        new Error('[-32205] 云端识别积分不足：请补充积分或切换本地引擎'),
        exhausted,
      )}
      onSwitchLocal={onSwitchLocal}
    />,
  );
  expect(screen.getByText(ASR_CREDITS_TEXT)).toBeTruthy();
  expect(screen.getByText('已用 120.00/120.00 分钟，剩余 0.00 分钟')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '切换本地识别' }));
  expect(onSwitchLocal).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: /重试/ })).toBeNull();
});

it('无云端语义的失败不冒充「未就绪」，也不挂切换入口', () => {
  render(
    <AnalysisFailureAlert
      failure={describeAnalysisFailure(new Error('ffmpeg 未安装'))}
      onSwitchLocal={vi.fn()}
    />,
  );
  expect(screen.getByText('ffmpeg 未安装')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '切换本地识别' })).toBeNull();
  expect(screen.queryByText(ASR_NOT_READY_TEXT)).toBeNull();
});
