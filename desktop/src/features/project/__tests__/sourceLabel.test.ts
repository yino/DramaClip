// @vitest-environment jsdom
/** 项目来源展示（4.5）：folder/files/mixed 三态 + 副本唯一键后缀剥离 + 跳过文案。 */
import { describe, expect, it } from 'vitest';
import type { Project, SkippedFile } from '@dramaclip/protocol';
import { projectSourceLabel, skippedFilesNote, skippedReasonLabel } from '../projectSourceLabel';

function project(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: '替嫁新娘',
    source_path: 'D:/素材/替嫁新娘',
    status: 'active',
    created_at: 0,
    episode_count: 32,
    settings: {},
    ...over,
  };
}

describe('projectSourceLabel', () => {
  it('folder：显示 source_root，剥掉 duplicate 的 #copy-<ms> 后缀', () => {
    expect(projectSourceLabel(project({ source_kind: 'folder', source_root: 'D:/素材/替嫁新娘' }))).toBe(
      'D:/素材/替嫁新娘',
    );
    expect(
      projectSourceLabel(
        project({ source_kind: 'folder', source_root: 'D:/素材/替嫁新娘#copy-1728000000000' }),
      ),
    ).toBe('D:/素材/替嫁新娘');
  });

  it('旧服务缺字段：按 folder 回退 source_path（仍剥副本后缀）', () => {
    expect(projectSourceLabel(project())).toBe('D:/素材/替嫁新娘');
    expect(projectSourceLabel(project({ source_path: 'D:/素材/替嫁新娘#copy-1' }))).toBe(
      'D:/素材/替嫁新娘',
    );
  });

  it('files：显示公共父目录；没有公共父目录时显示“多个位置”', () => {
    expect(projectSourceLabel(project({ source_kind: 'files', source_root: 'D:/素材/多选' }))).toBe(
      'D:/素材/多选',
    );
    expect(projectSourceLabel(project({ source_kind: 'files', source_root: '' }))).toBe('多个位置');
  });

  it('mixed：目录 + 多个位置', () => {
    expect(
      projectSourceLabel(project({ source_kind: 'mixed', source_root: 'D:/素材/替嫁新娘' })),
    ).toBe('D:/素材/替嫁新娘 · 多个位置');
  });
});

describe('skipped 文案', () => {
  it('五种原因都有中文', () => {
    expect(skippedReasonLabel('missing')).toBe('文件不存在');
    expect(skippedReasonLabel('unreadable')).toBe('无法读取');
    expect(skippedReasonLabel('unsupported')).toBe('不是支持的视频格式');
    expect(skippedReasonLabel('duplicate')).toBe('重复文件');
    expect(skippedReasonLabel('probe_failed')).toBe('读取视频信息失败');
  });

  it('按数量汇总并去重原因', () => {
    const skipped: SkippedFile[] = [
      { path: '/a/1.mov', reason: 'unsupported' },
      { path: '/a/1.mp4', reason: 'duplicate' },
      { path: '/a/2.mp4', reason: 'duplicate' },
    ];
    expect(skippedFilesNote(skipped)).toBe(
      '跳过 3 个文件（不是支持的视频格式、重复文件）',
    );
  });

  it('空数组不出文案', () => {
    expect(skippedFilesNote([])).toBeNull();
  });
});
