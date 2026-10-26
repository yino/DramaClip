/** 素材页「新增素材」：多选本地视频 → 追加到当前项目 → 刷新列表与统计。
 *
 * 三条边界：
 * 1. 只登记路径，不复制、不移动原文件；
 * 2. 追加完**不自动开始分析**——新集显示“待分析”，由用户决定何时开跑；
 * 3. 封面补拍只发起一次（前台短预算），失败不影响新增结果，剩余交给
 *    既有 scheduleCoverBackfill 涓流续拍。
 */
import { App as AntdApp } from 'antd';
import { useCallback, useRef, useState } from 'react';
import { pickVideoFiles, projectApi } from '../../services/client';
import { skippedFilesNote } from '../project/projectSourceLabel';

export interface AddMaterialController {
  /** 选择或追加进行中：入口按钮据此禁用，避免并发 -32105。 */
  adding: boolean;
  addMaterial: () => Promise<void>;
}

export function useAddMaterial(
  projectId: string,
  reloadProject: () => Promise<void>,
): AddMaterialController {
  const { message } = AntdApp.useApp();
  const [adding, setAdding] = useState(false);
  const busy = useRef(false);

  const addMaterial = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const picked = await pickVideoFiles();
      // 用户取消不是失败：什么都不改，也不提示。
      if (picked.length === 0) return;
      setAdding(true);
      const result = await projectApi.addEpisodes(
        projectId,
        picked.map((file) => file.path),
      );
      // 列表刷新失败不能掩盖“已经追加成功”这个事实。
      try {
        await reloadProject();
      } catch {
        // 由下一次正常刷新兜底；这里只保证不把成功误报成失败。
      }
      if (result.added === 0) {
        message.warning(skippedFilesNote(result.skipped) ?? '没有新增素材');
        return;
      }
      const skipped = skippedFilesNote(result.skipped);
      message.success(`已新增 ${String(result.added)} 集，待分析${skipped === null ? '' : `；${skipped}`}`);
      void projectApi.ensureCovers().catch(() => undefined);
    } catch (error) {
      message.error(error instanceof Error && error.message !== '' ? error.message : String(error));
    } finally {
      busy.current = false;
      setAdding(false);
    }
  }, [message, projectId, reloadProject]);

  return { adding, addMaterial };
}
