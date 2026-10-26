-- 023：项目来源类型与展示根（desktop-import-and-provisioning / D1）。
-- source_kind：folder（目录项目，存量默认）| files（多选文件引用）| mixed（目录项目追加过素材）。
-- source_root：仅用于展示，不参与解析；目录项目=source_path，文件项目=所选文件公共父目录。
-- 只加列不重建表：旧库零破坏；存量行回填 source_root=source_path，source_kind 取列默认 folder。
ALTER TABLE projects ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'folder';
ALTER TABLE projects ADD COLUMN source_root TEXT NOT NULL DEFAULT '';
UPDATE projects SET source_root = source_path WHERE source_root = '';
