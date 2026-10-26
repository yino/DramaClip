/** 统一新建项目弹窗（design D6 / tasks 4.3）。
 *
 * 关键纪律：**打开只渲染表单**——这里绝不预调 `pickVideoFiles`/`pickFolder`，
 * 只有用户点“选择视频文件”才唤起系统多选。素材只登记路径，不复制、不移动。
 *
 * 命名规则：用户没编辑过名称时，选文件后用父目录名预填（跨目录取第一个）；
 * 一旦编辑（含清空），后续选择不再覆盖。取消选择不是失败：当前名称与列表原样保留。
 */
import { VideoCameraAddOutlined } from '@ant-design/icons';
import { Alert, Button, Input, Modal } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PickedVideoFile, SkippedFile } from '@dramaclip/protocol';
import { pickVideoFiles } from '../../services/client';
import { tokens } from '../../styles/theme';
import { skippedFilesNote } from './projectSourceLabel';

export interface CreateProjectModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** 提交成功后由调用方负责 toast + 跳转；失败抛错，本弹窗留在原地显示 Alert。 */
  readonly onCreate: (name: string, files: string[]) => Promise<unknown>;
}

/** 规范化绝对路径：统一分隔符、压叠斜杠；Windows 盘符路径大小写不敏感。 */
export function normalizePickedPath(path: string): string {
  const unified = path.replaceAll('\\', '/').replace(/\/{2,}/g, '/');
  return /^[a-zA-Z]:\//.test(unified) ? unified.toLowerCase() : unified;
}

/** 前端先按规范化路径剔除重复项（服务端仍会兜底），顺序按用户选择。 */
export function dedupePickedFiles(files: readonly PickedVideoFile[]): PickedVideoFile[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    const key = normalizePickedPath(file.path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 文件所在目录名：`D:\\素材\\复仇千金\\01.mp4` → `复仇千金`。 */
export function parentDirName(path: string): string {
  const unified = path.replaceAll('\\', '/').replace(/\/+$/, '');
  const cut = unified.lastIndexOf('/');
  if (cut < 0) return '';
  const name = unified.slice(0, cut).split('/').pop() ?? '';
  // 盘符根（`D:`）没有可用的目录名。
  return /^[a-zA-Z]:$/.test(name) ? '' : name;
}

/** 选文件后的默认项目名：同目录取目录名，跨目录取第一个文件的父目录名。 */
export function inferredProjectName(files: readonly PickedVideoFile[]): string {
  const first = files[0];
  if (first === undefined) return '';
  // 同目录/跨目录都取第一个文件的父目录名：跨目录时“第一个”就是用户选择的起点。
  return parentDirName(first.path);
}

/** 文件大小人话：B/KB/MB/GB，保留一位小数。 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${String(Math.round(value))} B` : `${value.toFixed(1)} ${units[unit] ?? 'B'}`;
}

function totalSize(files: readonly PickedVideoFile[]): number {
  return files.reduce((sum, file) => sum + (Number.isFinite(file.size) ? file.size : 0), 0);
}

/** 失败时尽量从错误对象里捞出服务端的跳过报告（当前 RPC 不带，留好扩展位）。 */
function skippedFromError(error: unknown): SkippedFile[] {
  if (typeof error === 'object' && error !== null && 'skipped' in error) {
    const value = (error as { skipped?: unknown }).skipped;
    if (Array.isArray(value)) return value as SkippedFile[];
  }
  return [];
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : String(error);
}

interface ProjectNameFieldProps {
  readonly name: string;
  readonly inputRef: React.RefObject<React.ComponentRef<typeof Input> | null>;
  readonly onChange: (value: string) => void;
  readonly onSubmit: () => void;
}

function ProjectNameField({ name, inputRef, onChange, onSubmit }: ProjectNameFieldProps): React.ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spaceSm }}>
      <label htmlFor="create-project-name" style={{ fontSize: tokens.text.body.size, lineHeight: tokens.text.body.leading, color: tokens.textSecondary }}>
        项目名称
      </label>
      <Input
        id="create-project-name"
        ref={inputRef}
        autoFocus
        value={name}
        maxLength={80}
        placeholder="例如：复仇千金"
        status={name.trim() === '' && name !== '' ? 'warning' : undefined}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        onPressEnter={onSubmit}
      />
      <div style={{ fontSize: tokens.text.badge.size, lineHeight: tokens.text.badge.leading, color: tokens.textTertiary }}>
        用于项目列表与导出文件名，稍后可改。
      </div>
    </div>
  );
}

interface FailureAlertProps {
  readonly note: string;
  readonly duplicateCount: number;
}

function FailureAlert({ note, duplicateCount }: FailureAlertProps): React.ReactElement {
  return (
    <Alert
      type="error"
      showIcon
      role="alert"
      title="创建失败"
      description={
        <>
          <div>{note}</div>
          {duplicateCount > 0 && <div>{`已跳过 ${String(duplicateCount)} 个重复文件`}</div>}
        </>
      }
    />
  );
}

interface MaterialPickerProps {
  readonly files: readonly PickedVideoFile[];
  readonly duplicateCount: number;
  readonly picking: boolean;
  readonly submitting: boolean;
  readonly onPick: () => void;
  readonly onClear: () => void;
  readonly onRemove: (path: string) => void;
}

function MaterialPicker({ files, duplicateCount, picking, submitting, onPick, onClear, onRemove }: MaterialPickerProps): React.ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spaceSm }}>
      <span style={{ fontSize: tokens.text.body.size, lineHeight: tokens.text.body.leading, color: tokens.textSecondary }}>剧集素材</span>
      {files.length === 0 ? (
        <button
          type="button"
          aria-label="选择视频文件"
          disabled={picking}
          onClick={onPick}
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: tokens.spaceSm,
            width: '100%',
            padding: `${tokens.spaceXl} ${tokens.spaceLg}`,
            background: tokens.bgInput,
            border: `1px dashed ${tokens.border}`,
            borderRadius: tokens.radiusControl,
            cursor: picking ? 'progress' : 'pointer',
            color: tokens.textSecondary,
          }}
        >
          <VideoCameraAddOutlined style={{ fontSize: tokens.glyph.poster, color: tokens.textTertiary }} />
          <span style={{ fontSize: tokens.text.body.size, lineHeight: tokens.text.body.leading, color: tokens.colorPrimary }}>选择视频文件</span>
          <span style={{ fontSize: tokens.text.badge.size, lineHeight: tokens.text.badge.leading, color: tokens.textTertiary }}>
            支持 MP4、MOV、AVI、MKV 等格式，可一次选择多个文件
          </span>
        </button>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spaceSm, flexWrap: 'wrap' }}>
            <span style={{ fontSize: tokens.text.meta.size, lineHeight: tokens.text.meta.leading, color: tokens.textSecondary }}>
              {`已选 ${String(files.length)} 个文件 · 共 ${formatFileSize(totalSize(files))}`}
            </span>
            <Button size="small" onClick={onPick} disabled={submitting}>
              重新选择
            </Button>
            <Button size="small" onClick={onClear} disabled={submitting}>
              清空
            </Button>
          </div>
          {duplicateCount > 0 && (
            <div style={{ fontSize: tokens.text.badge.size, lineHeight: tokens.text.badge.leading, color: tokens.colorWarning }}>
              {`已跳过 ${String(duplicateCount)} 个重复文件`}
            </div>
          )}
          <div
            role="list"
            style={{
              display: 'flex',
              flexDirection: 'column',
              maxHeight: 200,
              overflowY: 'auto',
              border: `1px solid ${tokens.borderSecondary}`,
              borderRadius: tokens.radiusControl,
            }}
          >
            {files.map((file, index) => (
              <div
                key={normalizePickedPath(file.path)}
                role="listitem"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: tokens.spaceSm,
                  padding: `${tokens.spaceXs} ${tokens.spaceSm}`,
                  borderBottom: `1px solid ${tokens.borderSecondary}`,
                }}
              >
                <span style={{ width: 24, fontSize: tokens.text.badge.size, color: tokens.textTertiary }}>{String(index + 1)}</span>
                <span
                  title={file.path}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontSize: tokens.text.meta.size,
                    lineHeight: tokens.text.meta.leading,
                    color: tokens.textPrimary,
                  }}
                >
                  {file.name}
                </span>
                <span style={{ fontSize: tokens.text.badge.size, lineHeight: tokens.text.badge.leading, color: tokens.textTertiary }}>
                  {formatFileSize(file.size)}
                </span>
                <Button
                  size="small"
                  type="text"
                  aria-label={`移除 ${file.name}`}
                  disabled={submitting}
                  onClick={() => {
                    onRemove(file.path);
                  }}
                >
                  移除
                </Button>
              </div>
            ))}
          </div>
        </>
      )}
      <div style={{ fontSize: tokens.text.badge.size, lineHeight: tokens.text.badge.leading, color: tokens.textTertiary }}>
        原文件保留在原位置，不会复制或移动。
      </div>
    </div>
  );
}

function useCreateProjectForm({ open, onClose, onCreate }: CreateProjectModalProps) {
  const [name, setName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const [files, setFiles] = useState<PickedVideoFile[]>([]);
  const [duplicateCount, setDuplicateCount] = useState(0);
  const [failure, setFailure] = useState<{ message: string; skipped: SkippedFile[] } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [picking, setPicking] = useState(false);
  const nameRef = useRef<React.ComponentRef<typeof Input>>(null);

  const reset = useCallback(() => {
    setName('');
    setNameEdited(false);
    setFiles([]);
    setDuplicateCount(0);
    setFailure(null);
    setSubmitting(false);
    setPicking(false);
  }, []);

  // 每次打开都回到初始态，并把焦点放到项目名称。
  useEffect(() => {
    if (!open) return;
    reset();
    const timer = window.setTimeout(() => nameRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [open, reset]);

  const pick = useCallback(async () => {
    if (picking || submitting) return;
    setPicking(true);
    try {
      const picked = await pickVideoFiles();
      // 取消（[]）不是失败：保留当前名称与已选文件。
      if (picked.length === 0) return;
      const deduped = dedupePickedFiles(picked);
      setFiles(deduped);
      setDuplicateCount(picked.length - deduped.length);
      setFailure(null);
      if (!nameEdited && name.trim() === '') {
        setName(inferredProjectName(deduped));
      }
    } catch (error) {
      setFailure({ message: errorText(error), skipped: [] });
    } finally {
      setPicking(false);
    }
  }, [name, nameEdited, picking, submitting]);

  const submit = useCallback(async () => {
    if (submitting || name.trim() === '' || files.length === 0) return;
    setSubmitting(true);
    setFailure(null);
    try {
      await onCreate(
        name.trim(),
        files.map((file) => file.path),
      );
      reset();
      onClose();
    } catch (error) {
      // 失败不关窗：用户改一改还能再提交。
      setFailure({ message: errorText(error), skipped: skippedFromError(error) });
    } finally {
      setSubmitting(false);
    }
  }, [files, name, onClose, onCreate, reset, submitting]);

  const failureNote = ((): string | null => {
    if (failure === null) return null;
    const note = skippedFilesNote(failure.skipped);
    return note === null ? failure.message : `${failure.message}；${note}`;
  })();

  return {
    name,
    nameRef,
    files,
    duplicateCount,
    submitting,
    picking,
    canSubmit: name.trim() !== '' && files.length > 0 && !submitting,
    failureNote,
    pick,
    submit,
    setName,
    setNameEdited,
    setFiles,
    setDuplicateCount,
    close: (): void => {
      if (submitting) return;
      onClose();
    },
    clear: (): void => {
      setFiles([]);
      setDuplicateCount(0);
    },
    remove: (path: string): void => {
      setFiles((prev) => prev.filter((item) => normalizePickedPath(item.path) !== normalizePickedPath(path)));
    },
  };
}

export function CreateProjectModal({ open, onClose, onCreate }: CreateProjectModalProps): React.ReactElement {
  const form = useCreateProjectForm({ open, onClose, onCreate });
  return (
    <Modal
      title="新建项目"
      open={open}
      width={720}
      closable={!form.submitting}
      keyboard={!form.submitting}
      mask={{ closable: !form.submitting }}
      okText={form.submitting ? '创建中…' : '创建项目'}
      cancelText="取消"
      okButtonProps={{ disabled: !form.canSubmit, loading: form.submitting, 'aria-busy': form.submitting }}
      cancelButtonProps={{ disabled: form.submitting }}
      onOk={() => {
        void form.submit();
      }}
      onCancel={form.close}
      afterOpenChange={(opened) => {
        if (opened) form.nameRef.current?.focus();
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spaceLg }}>
        <div style={{ fontSize: tokens.text.meta.size, lineHeight: tokens.text.meta.leading, color: tokens.textSecondary }}>
          先给项目起名，再选择要剪辑的视频素材。
        </div>

        {form.failureNote !== null && <FailureAlert note={form.failureNote} duplicateCount={form.duplicateCount} />}

        <ProjectNameField
          name={form.name}
          inputRef={form.nameRef}
          onChange={(value) => {
            form.setName(value);
            form.setNameEdited(true);
          }}
          onSubmit={() => {
            if (form.canSubmit) void form.submit();
          }}
        />

        <MaterialPicker
          files={form.files}
          duplicateCount={form.duplicateCount}
          picking={form.picking}
          submitting={form.submitting}
          onPick={() => {
            void form.pick();
          }}
          onClear={form.clear}
          onRemove={form.remove}
        />
      </div>
    </Modal>
  );
}
