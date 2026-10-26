// @vitest-environment jsdom
/**
 * 出片记录必须能按时间区分：同一模式、同一时长跑过两次时，只有状态和时长看不出先后。
 * 已完成显示完成时间；进行中/失败没有完成时间，回退创建时间并标注「开始」。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExportJob } from '@dramaclip/protocol';
import { ExportsCard } from '../ExportsCard';

afterEach(() => {
  cleanup();
});

/** 本地时间构造，避免测试依赖运行机器时区。 */
const local = (hour: number, minute: number, second: number): number => new Date(2026, 9, 24, hour, minute, second).getTime();

function job(overrides: Partial<ExportJob>): ExportJob {
  return {
    id: 'job-1',
    project_id: 'proj',
    narration_mode: 'highlight_cut',
    status: 'completed',
    progress: 1,
    duration_s: 10.35,
    created_at: local(18, 15, 57),
    completed_at: local(18, 16, 13),
    ...overrides,
  };
}

function renderCard(exports: ExportJob[]): void {
  render(
    <MemoryRouter initialEntries={['/project/proj']}>
      <Routes>
        <Route path="/project/:id" element={<ExportsCard exports={exports} />} />
        <Route path="/works/:id" element={<div>成片详情页</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ExportsCard 时间展示', () => {
  it('两条同模式同时长的记录用完成时间区分', () => {
    renderCard([
      job({ id: 'a', created_at: local(17, 15, 42), completed_at: local(17, 15, 45) }),
      job({ id: 'b', created_at: local(18, 15, 57), completed_at: local(18, 16, 13) }),
    ]);

    const earlier = screen.getByText('10-24 17:15');
    const later = screen.getByText('10-24 18:16');
    expect(earlier.getAttribute('title')).toBe('完成于 2026-10-24 17:15:45');
    expect(later.getAttribute('title')).toBe('完成于 2026-10-24 18:16:13');
    expect(screen.getAllByText('高光混剪')).toHaveLength(2);
  });

  it('进行中/失败没有完成时间时回退创建时间并标注「开始」', () => {
    renderCard([job({ id: 'running', status: 'running', progress: 0.4, completed_at: undefined, created_at: local(9, 5, 0) })]);

    const started = screen.getByText('开始 10-24 09:05');
    expect(started.getAttribute('title')).toBe('创建于 2026-10-24 09:05:00');
  });

  it('点击记录仍进入成片详情', () => {
    renderCard([job({ id: 'opens-detail' })]);

    fireEvent.click(screen.getByText('10-24 18:16'));

    expect(screen.getByText('成片详情页')).toBeTruthy();
  });
});
