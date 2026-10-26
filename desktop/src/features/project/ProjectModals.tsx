import { Input, Modal } from 'antd';
import { useState } from 'react';
import type { Project } from '@dramaclip/protocol';

/** 重命名弹窗：与新建项目弹窗同宽同 footer 规格（§8 max-lines：页面文件只留编排）。
 * 新建项目已迁到 `CreateProjectModal.tsx`——它承载「名称 + 多选素材」两段表单，
 * 不再是这里的单文件夹小表单。 */
export function RenameModal({
  target,
  onClose,
  onRename,
}: {
  target: Project | null;
  onClose: () => void;
  onRename: (name: string) => void;
}) {
  const [name, setName] = useState('');
  const initial = target?.name ?? '';
  return (
    <Modal
      title="重命名项目"
      open={target !== null}
      width={720}
      okButtonProps={{ disabled: name.trim() === '' }}
      onOk={() => {
        onRename(name.trim());
      }}
      onCancel={onClose}
      afterOpenChange={(opened) => {
        if (opened) setName(initial);
      }}
    >
      <Input
        value={name}
        onChange={(event) => {
          setName(event.target.value);
        }}
      />
    </Modal>
  );
}
