"""多选文件导入的纯规划器：所选路径列表 → ImportPlan（design D2）。

只做判定，不落库、不复制源文件：`project.create_from_files`（新建）与
`project.add_episodes`（追加）共用这一套「哪些能进、哪些跳过、为什么、按什么顺序、
默认叫什么」。两边各写一套校验，迟早一边放行一边拦截；而规划本身是纯函数，
跳过原因的每一条都能单独单测，不必先有一个能读的视频文件库。
"""

from __future__ import annotations

import os
import re
import subprocess
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from dramaclip.infra.ffmpeg import probe

VIDEO_EXTENSIONS = frozenset({".mp4", ".mov", ".avi", ".mkv", ".wmv", ".webm", ".flv"})
"""受支持的视频扩展名。与目录重扫同一口径：扫出来的和选进来的必须互认。"""

SKIP_MISSING = "missing"
SKIP_UNREADABLE = "unreadable"
SKIP_UNSUPPORTED = "unsupported"
SKIP_DUPLICATE = "duplicate"
SKIP_PROBE_FAILED = "probe_failed"

SKIP_REASONS = (
    SKIP_MISSING,
    SKIP_UNREADABLE,
    SKIP_UNSUPPORTED,
    SKIP_DUPLICATE,
    SKIP_PROBE_FAILED,
)
"""skipped 报告的全部原因；协议 schema 与渲染层提示共用这组字面量。"""

PLAN_CREATE = "create"
PLAN_APPEND = "append"

_NATURAL_KEY_PATTERN = re.compile(r"(\d+)")


@dataclass(frozen=True)
class ProbedEpisode:
    """一条探好的候选集：落库所需的元数据 + 探测结果。"""

    source_path: str
    name: str
    duration: float
    size_bytes: int
    has_audio: bool

    def as_episode(self) -> dict[str, Any]:
        """转 episodes_repo.append_many 的入参（只带它认的键）。"""
        return {
            "source_path": self.source_path,
            "name": self.name,
            "duration": self.duration,
            "has_audio": self.has_audio,
        }


@dataclass(frozen=True)
class SkippedFile:
    """被跳过的所选路径与原因；path 原样回显用户选的那条，便于界面定位。"""

    path: str
    reason: str

    def as_row(self) -> dict[str, str]:
        return {"path": self.path, "reason": self.reason}


@dataclass(frozen=True)
class ImportPlan:
    """一次导入的完整规划结果。"""

    accepted: list[ProbedEpisode]
    skipped: list[SkippedFile]
    common_parent: str
    # 全部有效文件的共同父目录；跨目录时为空串（项目来源显示“多个位置”）
    mode: str
    # 选择顺序里第一条有效文件的父目录：跨目录时默认名取它（spec：第一个所选文件）
    first_parent: str = ""

    @property
    def default_name(self) -> str:
        """默认项目名：同目录取目录名，跨目录取第一个所选文件的父目录名。"""
        if not self.accepted:
            return ""
        parent = self.common_parent or self.first_parent
        return Path(parent).name


def natural_key(text: str) -> list[int | str]:
    """数字感知排序键：ep2 < ep10。纯函数可单测。"""
    return [int(part) if part.isdigit() else part for part in _NATURAL_KEY_PATTERN.split(text)]


def import_key(raw: str | os.PathLike[str]) -> str:
    """去重键：规范化绝对路径（Windows 下大小写不敏感）。

    同一文件经相对路径、符号链接、大小写变体选两次必须只算一次——重复键若按
    输入字符串比较，界面把相对路径交上来就会变成两集。
    """
    return os.path.normcase(str(_resolve(str(raw))))


def plan_import(
    files: Sequence[Any],
    *,
    mode: str = PLAN_CREATE,
    existing: Iterable[str] = (),
) -> ImportPlan:
    """把所选路径规划成 ImportPlan（纯函数：无副作用、可单测）。

    existing 是项目已有素材路径（追加场景）：与它规范化重复的路径一律记 duplicate，
    不进 accepted——「再选一次已导入的片子」不该变成第二集。
    """
    if mode not in (PLAN_CREATE, PLAN_APPEND):
        raise ValueError(f"未知导入模式: {mode}")
    seen = {import_key(path) for path in existing}
    accepted: list[ProbedEpisode] = []
    skipped: list[SkippedFile] = []
    first_parent = ""
    for raw in files:
        text = "" if raw is None else str(raw).strip()
        if not text:
            skipped.append(SkippedFile(path=text, reason=SKIP_MISSING))
            continue
        # 先查重再校验：重复是“选重了”，比“扩展名不支持”更能解释用户看到的跳过。
        key = import_key(text)
        if key in seen:
            skipped.append(SkippedFile(path=text, reason=SKIP_DUPLICATE))
            continue
        seen.add(key)
        path = _resolve(text)
        if not path.is_file():
            skipped.append(SkippedFile(path=text, reason=SKIP_MISSING))
            continue
        if path.suffix.lower() not in VIDEO_EXTENSIONS:
            skipped.append(SkippedFile(path=text, reason=SKIP_UNSUPPORTED))
            continue
        if not _readable(path):
            skipped.append(SkippedFile(path=text, reason=SKIP_UNREADABLE))
            continue
        try:
            media = probe.probe(path)
            size_bytes = path.stat().st_size
        except (OSError, ValueError, subprocess.SubprocessError):
            # 扩展名对、文件能打开，但容器/编码读不出时长：宁可跳过也不建一条
            # duration=0 的“幽灵集”进分析队列。
            skipped.append(SkippedFile(path=text, reason=SKIP_PROBE_FAILED))
            continue
        if not first_parent:
            first_parent = str(path.parent)
        accepted.append(
            ProbedEpisode(
                source_path=str(path),
                name=path.stem,
                duration=round(float(media.duration_s), 3),
                size_bytes=size_bytes,
                has_audio=bool(media.has_audio),
            )
        )
    # 跨目录选择按 (父目录, 自然名) 排：同一目录内 ep2 在 ep10 前，跨目录时目录成组，
    # 界面上的集序不会随“用户先点哪个目录”漂移。
    accepted.sort(key=lambda item: (str(Path(item.source_path).parent), natural_key(item.name)))
    parents = {str(Path(item.source_path).parent) for item in accepted}
    common_parent = next(iter(parents)) if len(parents) == 1 else ""
    return ImportPlan(
        accepted=accepted,
        skipped=skipped,
        common_parent=common_parent,
        mode=mode,
        first_parent=first_parent,
    )


def _resolve(text: str) -> Path:
    """解析成绝对路径；解析失败（环形链接等）退回原路径，交给后续 is_file 判跳过。"""
    try:
        return Path(text).resolve()
    except OSError:
        return Path(text)


def _readable(path: Path) -> bool:
    """能打开读才算可读：is_file 对无读权限的文件同样返回 True。"""
    try:
        with path.open("rb"):
            return True
    except OSError:
        return False
