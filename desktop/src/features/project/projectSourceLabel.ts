/** 项目来源展示与导入结果文案（design D3/D6）。
 *
 * 三种来源共用一句人话：目录项目显示目录，文件项目显示公共父目录（跨目录为
 * “多个位置”），混合项目两者都说。`duplicate` 合成唯一键带 `#copy-<ms>` 后缀，
 * 那是存储实现，不该漏到界面上。
 */
import type { Project, SkippedFile, SkippedReason } from '@dramaclip/protocol';

const COPY_SUFFIX = /#copy-\d+$/;

/** 剥掉 `project.duplicate` 拼进 source_path 的唯一键后缀。 */
function stripCopySuffix(value: string): string {
  return value.replace(COPY_SUFFIX, '');
}

/** 来源一句话：folder=目录；files=公共父目录或“多个位置”；mixed=目录 · 多个位置。 */
export function projectSourceLabel(project: Project): string {
  const kind = project.source_kind ?? 'folder';
  if (kind === 'files') {
    const root = stripCopySuffix(project.source_root ?? '');
    return root === '' ? '多个位置' : root;
  }
  // 旧服务没有 source_root：目录仍可从 source_path 读出来（兼容迁移后的老项目）。
  const root = stripCopySuffix(project.source_root ?? project.source_path);
  if (kind !== 'mixed') return root;
  return root === '' ? '多个位置' : `${root} · 多个位置`;
}

const SKIPPED_REASON_LABELS: Partial<Record<SkippedReason, string>> = {
  missing: '文件不存在',
  unreadable: '无法读取',
  unsupported: '不是支持的视频格式',
  duplicate: '重复文件',
  probe_failed: '读取视频信息失败',
};

/** 服务端稳定枚举 → 界面中文原因。 */
export function skippedReasonLabel(reason: SkippedReason): string {
  return SKIPPED_REASON_LABELS[reason] ?? '无法导入';
}

/** 跳过报告一句话：数量 + 合并后的原因（不按文件刷屏）。空数组返回 null。 */
export function skippedFilesNote(skipped: readonly SkippedFile[]): string | null {
  if (skipped.length === 0) return null;
  const reasons = [...new Set(skipped.map((item) => skippedReasonLabel(item.reason)))].join('、');
  return `跳过 ${String(skipped.length)} 个文件（${reasons}）`;
}
