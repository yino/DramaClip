/** 无剧时的主区引导（规格 desktop-workbench 空态）：只给文件导入承诺与唯一 primary；
 *  不出现模型、引擎、本地运行环境等安装引导。 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmptyWorkbench } from '../EmptyWorkbench';

afterEach(cleanup);

function renderEmpty(creating = false) {
  const onCreate = vi.fn();
  const view = render(<EmptyWorkbench creating={creating} onCreate={onCreate} />);
  return { ...view, onCreate };
}

describe('EmptyWorkbench', () => {
  it('一句话说清开始形态：整部短剧进来，素材位置不变', () => {
    renderEmpty();
    expect(screen.getByText(/把整部短剧放进来/)).toBeTruthy();
    expect(screen.getByText('选择多个视频文件即可建剧，素材留在原位置。')).toBeTruthy();
  });

  it('primary 仍只有一个（新增项目），点击开始建剧', () => {
    const { onCreate } = renderEmpty();
    const primaries = document.querySelectorAll<HTMLElement>('.ant-btn-primary');
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.textContent).toContain('新增项目');
    primaries[0]?.click();
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('建剧中时按钮进 loading 且不可再点', () => {
    renderEmpty(true);
    const primary = document.querySelector<HTMLElement>('.ant-btn-primary');
    expect(primary?.textContent).toContain('新增项目');
    expect(primary?.hasAttribute('disabled')).toBe(true);
  });

  it('不出现模型/引擎/环境安装引导，也不承诺未实装能力', () => {
    const { container } = renderEmpty();
    const text = container.textContent;
    for (const banned of [
      '环境就绪度',
      '本地运行环境',
      'FFmpeg',
      '模型',
      'LLM',
      '装一个',
      '三步开始',
      '去下载',
      '去配置',
      '拖',
      '下载短剧',
      '网盘',
      '授权书',
      '即将',
    ]) {
      expect(text, `空态文案里出现了 ${banned}`).not.toContain(banned);
    }
  });
});
