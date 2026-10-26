"""project 命名空间：create / list / get / delete / scan_episodes。"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any
from uuid import uuid4

from dramaclip.api.context import AppContext
from dramaclip.api.ingest_guard import active_ingest_job
from dramaclip.api.project_import import (
    PLAN_APPEND,
    PLAN_CREATE,
    VIDEO_EXTENSIONS,
    natural_key,
    plan_import,
)
from dramaclip.infra.ffmpeg import cover as cover_engine
from dramaclip.infra.ffmpeg import probe
from dramaclip.infra.storage.repos import episodes as episodes_repo
from dramaclip.infra.storage.repos import projects as projects_repo
from dramaclip.transport.rpc import Router, RpcDomainError

_ERR_PROJECT_NOT_FOUND = -32101
_ERR_SOURCE_INVALID = -32102
_ERR_NO_EPISODES = -32103
_ERR_INVALID_SETTINGS = -32104
_ERR_ANALYZING = -32105


def register(router: Router, context: AppContext) -> None:
    router.register("project.create", lambda params: create(context, params))
    router.register("project.create_from_files", lambda params: create_from_files(context, params))
    router.register("project.add_episodes", lambda params: add_episodes(context, params))
    router.register("project.list", lambda _params: list_all(context))
    router.register("project.get", lambda params: get(context, params))
    router.register("project.delete", lambda params: delete(context, params))
    router.register("project.rename", lambda params: rename(context, params))
    router.register("project.update_settings", lambda params: update_settings(context, params))
    router.register("project.duplicate", lambda params: duplicate(context, params))
    router.register("project.scan_episodes", lambda params: scan_episodes(context, params))
    router.register("project.dashboard_summary", lambda _params: dashboard_summary(context))
    router.register("project.ensure_covers", lambda params: ensure_covers(context, params))
    router.register("project.reorder_episodes", lambda params: reorder_episodes(context, params))


def create(context: AppContext, params: dict[str, Any]) -> dict[str, Any]:
    name = str(params.get("name", "")).strip()
    source_path = str(params.get("source_path", "")).strip()
    if not name or not source_path:
        raise RpcDomainError(_ERR_SOURCE_INVALID, "name 与 source_path 必填")
    directory = Path(source_path)
    if not directory.is_dir():
        raise RpcDomainError(_ERR_SOURCE_INVALID, f"目录不存在：{source_path}")
    return projects_repo.create(context.conn, name, source_path)


def create_from_files(context: AppContext, params: dict[str, Any]) -> dict[str, Any]:
    """多选文件建项目：只登记所选文件，绝不扫它们所在的目录（design D1/D2）。

    来源三件套：source_path 是 ``files:<uuid>``（目录项目才有真目录，文件项目没有
    可重扫的根），source_kind 标 files，source_root 记公共父目录（跨目录为空串，
    界面显示“多个位置”）。源文件只被引用不被复制——用户删了原片，项目就该如实
    显示缺源，而不是悄悄占一份副本。
    """
    name = str(params.get("name", "")).strip()
    if not name:
        raise RpcDomainError(_ERR_SOURCE_INVALID, "项目名不能为空")
    plan = plan_import(_require_files(params), mode=PLAN_CREATE)
    if not plan.accepted:
        raise RpcDomainError(_ERR_NO_EPISODES, "所选文件里没有可用的视频")
    source_path = f"files:{uuid4().hex}"
    # 建项目与插集必须同一事务：插入半批失败时不能留下一个空项目让用户去重扫。
    with context.conn:
        project = projects_repo.create(
            context.conn,
            name,
            source_path,
            source_kind="files",
            source_root=plan.common_parent,
            commit=False,
        )
        episodes_repo.append_many(
            context.conn,
            str(project["id"]),
            [item.as_episode() for item in plan.accepted],
            commit=False,
        )
    project_id = str(project["id"])
    _ensure_project_cover(context, project)
    detail = get(context, {"project_id": project_id})
    from dramaclip.api.analysis import autostart_after_scan

    # 创建后沿用扫集后的自动分析；它内部吞掉 RpcDomainError，建项目成功不因
    # 「自动分析没起来」变成失败响应（2.3）。
    autostart_after_scan(context, project_id, len(plan.accepted))
    return {
        "project": detail["project"],
        "episodes": detail["episodes"],
        "skipped": [item.as_row() for item in plan.skipped],
    }


def add_episodes(context: AppContext, params: dict[str, Any]) -> dict[str, Any]:
    """给既有项目追加素材：不替换、不重编号、不自动分析（design D3）。

    分析/预筛进行中一律拒绝：运行中的作业已按旧集列表取了产物目标，此时插入新集
    会让它读到移动中的列表。拒绝发生在任何写入之前，保证拒绝即无部分写入。
    """
    project_id = str(params.get("project_id", ""))
    project = projects_repo.get(context.conn, project_id)
    if project is None:
        raise RpcDomainError(_ERR_PROJECT_NOT_FOUND, f"项目不存在: {project_id}")
    job = active_ingest_job(context.conn, project_id)
    if job is not None:
        raise RpcDomainError(
            _ERR_ANALYZING, f"项目正在{job['type']}，请等当前任务结束后再新增素材"
        )
    files = _require_files(params)
    existing = [
        str(row["source_path"])
        for row in episodes_repo.list_by_project(context.conn, project_id)
    ]
    plan = plan_import(files, mode=PLAN_APPEND, existing=existing)
    if not plan.accepted:
        raise RpcDomainError(_ERR_NO_EPISODES, "所选文件里没有可新增的视频")
    with context.conn:
        added = episodes_repo.append_many(
            context.conn,
            project_id,
            [item.as_episode() for item in plan.accepted],
            commit=False,
        )
        if str(project.get("source_kind", "folder")) == "folder":
            # 目录项目追加了外部文件 → mixed，但 source_root 仍是原目录：它既是
            # 来源展示的落点，也是“还能不能重扫/从哪补封面”的判据，不能被覆盖。
            context.conn.execute(
                "UPDATE projects SET source_kind = 'mixed', updated_at = ? WHERE id = ?",
                (int(time.time() * 1000), project_id),
            )
    _ensure_project_cover(context, project)
    episodes = get(context, {"project_id": project_id})["episodes"]
    return {
        "added": added,
        "skipped": [item.as_row() for item in plan.skipped],
        "episodes": episodes[-added:],
    }


def list_all(context: AppContext) -> list[dict[str, Any]]:
    return projects_repo.list_all(context.conn)


def get(context: AppContext, params: dict[str, Any]) -> dict[str, Any]:
    project_id = str(params.get("project_id", ""))
    project = projects_repo.get(context.conn, project_id)
    if project is None:
        raise RpcDomainError(_ERR_PROJECT_NOT_FOUND, f"项目不存在: {project_id}")
    episodes = [
        _episode_out(row) for row in episodes_repo.list_by_project(context.conn, project_id)
    ]
    return {"project": project, "episodes": episodes}


def delete(context: AppContext, params: dict[str, Any]) -> dict[str, Any]:
    project_id = str(params.get("project_id", ""))
    if not projects_repo.delete(context.conn, project_id):
        raise RpcDomainError(_ERR_PROJECT_NOT_FOUND, f"项目不存在: {project_id}")
    return {"ok": True}


def rename(context: AppContext, params: dict[str, Any]) -> dict[str, Any]:
    project_id = str(params.get("project_id", ""))
    name = str(params.get("name", "")).strip()
    if not name:
        raise RpcDomainError(_ERR_SOURCE_INVALID, "项目名不能为空")
    if not projects_repo.rename(context.conn, project_id, name):
        raise RpcDomainError(_ERR_PROJECT_NOT_FOUND, f"项目不存在: {project_id}")
    return projects_repo.get(context.conn, project_id) or {}


def update_settings(context: AppContext, params: dict[str, Any]) -> dict[str, Any]:
    """项目级参数覆盖（K / 转写档位 / 风格 / 字幕预设）。null 值=恢复该项默认。"""
    project_id = str(params.get("project_id", ""))
    changes = params.get("settings")
    if not isinstance(changes, dict):
        raise RpcDomainError(_ERR_INVALID_SETTINGS, "settings 必须是对象")
    merged = projects_repo.update_settings(context.conn, project_id, changes)
    if merged is None:
        raise RpcDomainError(_ERR_PROJECT_NOT_FOUND, f"项目不存在: {project_id}")
    return {"project_id": project_id, "settings": merged}


def duplicate(context: AppContext, params: dict[str, Any]) -> dict[str, Any]:
    project_id = str(params.get("project_id", ""))
    source = projects_repo.get(context.conn, project_id)
    if source is None:
        raise RpcDomainError(_ERR_PROJECT_NOT_FOUND, f"项目不存在: {project_id}")
    created = projects_repo.duplicate(context.conn, project_id, f"{source['name']}（副本）")
    return created or {}


def dashboard_summary(context: AppContext) -> dict[str, int]:
    return projects_repo.summary(context.conn)


def scan_episodes(context: AppContext, params: dict[str, Any]) -> list[dict[str, Any]]:
    """扫描项目目录：视频文件自然排序 → ffprobe 逐个 → 全量替换 episodes。

    只适用于目录来源项目：files/mixed 的 source_path 是内置引用或补丁目录，重扫
    既可能空目录报错，也会用目录快照覆盖掉多选文件集——那类项目走「新增素材」。
    """
    project_id = str(params.get("project_id", ""))
    project = projects_repo.get(context.conn, project_id)
    if project is None:
        raise RpcDomainError(_ERR_PROJECT_NOT_FOUND, f"项目不存在: {project_id}")
    if str(project.get("source_kind", "folder")) != "folder":
        raise RpcDomainError(
            _ERR_SOURCE_INVALID,
            f"仅目录来源项目支持重扫，文件/混合项目请使用新增素材：{project['name']}",
        )
    videos = sorted(
        (p for p in Path(project["source_path"]).iterdir() if _is_video(p)),
        key=lambda path: natural_key(path.name),
    )
    if not videos:
        raise RpcDomainError(_ERR_NO_EPISODES, f"目录中没有视频文件：{project['source_path']}")

    scanned: list[dict[str, Any]] = []
    for number, video in enumerate(videos, start=1):
        media = probe.probe(video)
        scanned.append(
            {
                "episode_number": number,
                "name": video.stem,
                "source_path": str(video),
                "duration": round(media.duration_s, 3),
                "size_bytes": video.stat().st_size,
                "has_audio": media.has_audio,
            }
        )
    episodes_repo.replace_all(context.conn, project_id, scanned)
    _ensure_cover(context, project)
    for episode in episodes_repo.list_by_project(context.conn, project_id):
        _ensure_episode_cover(context, episode)
    from dramaclip.api.analysis import autostart_after_scan

    autostart_after_scan(context, project_id, len(scanned))
    return scanned


_COVER_BUDGET_S = 8.0
"""ensure_covers 单次时间预算（秒）。RPC dispatch 是单线程：补拍长堵会把 system.health
一起排队堵死，ServiceManager 便误判服务已死、杀进程重启（50 剧×579 集死路径库实测
~1900 次 ffmpeg 进程拉起）。超预算就收手，欠账用 remaining 如实上报，渲染层涓流续拍。"""


def ensure_covers(context: AppContext, params: dict[str, Any]) -> dict[str, Any]:
    """为缺封面的项目与各集补截帧（幂等；已有封面的跳过）。

    两条纪律护住单线程 dispatch：源文件不在场直接跳过（死路径不配拉起 ffmpeg，
    每集三段 seek 回退就是三次进程开销）；单次调用最多花 _COVER_BUDGET_S 秒，
    预算耗尽收手，remaining 报还欠多少——封面是增强项，慢补可以，堵死服务不行。
    """
    deadline = time.monotonic() + _COVER_BUDGET_S
    generated = 0
    remaining = 0
    for project in projects_repo.list_all(context.conn):
        if _cover_missing(project["cover_path"]):
            if time.monotonic() < deadline and _ensure_cover(context, project):
                generated += 1
            else:
                remaining += 1
        for episode in episodes_repo.list_by_project(context.conn, str(project["id"])):
            if not _cover_missing(episode["cover_path"]):
                continue
            if time.monotonic() < deadline and _ensure_episode_cover(context, episode):
                generated += 1
            else:
                remaining += 1
    return {"ok": True, "generated": generated, "remaining": remaining}


def reorder_episodes(context: AppContext, params: dict[str, Any]) -> dict[str, Any]:
    """手动排序：按给定 episode_ids 顺序重编号。"""
    project_id = str(params.get("project_id", ""))
    if projects_repo.get(context.conn, project_id) is None:
        raise RpcDomainError(_ERR_PROJECT_NOT_FOUND, f"项目不存在: {project_id}")
    ordered = params.get("episode_ids")
    if not isinstance(ordered, list):
        raise RpcDomainError(_ERR_SOURCE_INVALID, "episode_ids 必须为数组")
    ok = episodes_repo.reorder(context.conn, project_id, [str(item) for item in ordered])
    if not ok:
        raise RpcDomainError(_ERR_NO_EPISODES, "episode_ids 与项目剧集不一致")
    return {"ok": True}


def _episode_out(row: dict[str, Any]) -> dict[str, Any]:
    """episodes 出参：库里的 0/1 还原成布尔；NULL（迁移前的旧集，未重扫）原样保留——
    取不到 ≠ 没有，渲染层据此不发缺音轨告警。"""
    out = dict(row)
    if out.get("has_audio") is not None:
        out["has_audio"] = bool(out["has_audio"])
    return out


def _ensure_episode_cover(context: AppContext, episode: dict[str, Any]) -> bool:
    source = Path(str(episode["source_path"]))
    if not source.is_file():
        return False  # 死路径快失败：不拉起注定失败的 ffmpeg（外置盘离线/造数库常态）
    cover_dir = context.data_dir / "covers"
    cover_dir.mkdir(parents=True, exist_ok=True)
    out_path = cover_dir / f"ep_{episode['id']}.jpg"
    if not cover_engine.extract_cover(source, out_path):
        return False
    episodes_repo.set_cover(context.conn, str(episode["id"]), str(out_path))
    return True


def _cover_missing(cover_path: Any) -> bool:
    return cover_path is None or not Path(str(cover_path)).is_file()


def _ensure_cover(context: AppContext, project: dict[str, Any]) -> bool:
    """从第一集视频截帧生成封面；无集/源不在场/截帧失败返回 False。"""
    project_id = str(project["id"])
    episodes = episodes_repo.list_by_project(context.conn, project_id)
    if not episodes:
        return False
    first = min(episodes, key=lambda ep: int(ep["episode_number"]))
    source = Path(str(first["source_path"]))
    if not source.is_file():
        return False  # 同 _ensure_episode_cover：死路径不配拉起 ffmpeg
    cover_dir = context.data_dir / "covers"
    cover_dir.mkdir(parents=True, exist_ok=True)
    out_path = cover_dir / f"{project_id}.jpg"
    if not cover_engine.extract_cover(source, out_path):
        return False
    projects_repo.set_cover(context.conn, project_id, str(out_path))
    return True


def _ensure_project_cover(context: AppContext, project: dict[str, Any]) -> bool:
    """只补项目封面（缺封面才拍）。

    逐集封面交给 ensure_covers 的 8 秒预算涓流：导入接口里再复刻一遍无预算的逐集
    循环，会把单线程 dispatch 堵到 ServiceManager 误判服务已死。追加素材时项目
    封面通常已在，不为补一集重拍第一帧。
    """
    if not _cover_missing(project.get("cover_path")):
        return False
    return _ensure_cover(context, project)


def _is_video(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() in VIDEO_EXTENSIONS


def _require_files(params: dict[str, Any]) -> list[Any]:
    files = params.get("files")
    if not isinstance(files, list) or not files:
        raise RpcDomainError(_ERR_SOURCE_INVALID, "files 必须为非空数组")
    return files
