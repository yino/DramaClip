"""api.project.create_from_files：多选建项目（只登记所选文件，不扫目录、不复制源）。"""

from __future__ import annotations

import re
import shutil
import sqlite3
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from dramaclip.api import analysis as analysis_api
from dramaclip.api import project as project_api
from dramaclip.infra import jobs
from dramaclip.transport.notify import Notifier
from dramaclip.transport.rpc import Router, RpcDomainError, RpcRequest

_FILES_SOURCE = re.compile(r"^files:[0-9a-f]{32}$")


def _router(
    conn: sqlite3.Connection, data_dir: Path, **extra: Any
) -> Router:
    context = SimpleNamespace(
        conn=conn, data_dir=data_dir, work_dir=data_dir / "cache", **extra
    )
    router = Router()
    project_api.register(router, context)  # type: ignore[arg-type]
    return router


def _call(router: Router, method: str, params: dict[str, Any]) -> Any:
    return router.dispatch(RpcRequest(id=1, method=method, params=params))


def _create(router: Router, files: list[Path], name: str = "剧集") -> Any:
    return _call(
        router,
        "project.create_from_files",
        {"name": name, "files": [str(path) for path in files]},
    )


def _count(conn: sqlite3.Connection, table: str) -> int:
    row = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()
    return int(row[0]) if row is not None else 0


def _episodes(conn: sqlite3.Connection, project_id: str) -> list[dict[str, Any]]:
    from dramaclip.infra.storage.repos import episodes as episodes_repo

    return episodes_repo.list_by_project(conn, project_id)


def test_create_registers_only_selected_files(
    memory_db: sqlite3.Connection, tmp_path: Path, sample_video: Path
) -> None:
    media = tmp_path / "media"
    media.mkdir()
    picked = media / "ep1.mp4"
    unselected = media / "ep2.mp4"
    shutil.copy(sample_video, picked)
    shutil.copy(sample_video, unselected)

    result = _create(_router(memory_db, tmp_path / "data"), [picked]).result

    assert _FILES_SOURCE.match(result["project"]["source_path"]), "文件项目没有可重扫的目录"
    assert result["project"]["source_kind"] == "files"
    assert result["project"]["source_root"] == str(media.resolve())
    assert result["project"]["episode_count"] == 1
    assert [ep["name"] for ep in result["episodes"]] == ["ep1"], "同目录未选中的文件不得被导入"
    assert result["skipped"] == []
    assert len(_episodes(memory_db, result["project"]["id"])) == 1


def test_create_does_not_copy_sources(
    memory_db: sqlite3.Connection, tmp_path: Path, sample_video: Path
) -> None:
    media = tmp_path / "media"
    media.mkdir()
    picked = media / "ep1.mp4"
    shutil.copy(sample_video, picked)
    data_dir = tmp_path / "data"

    result = _create(_router(memory_db, data_dir), [picked]).result

    assert picked.is_file(), "源文件只被引用，不被移动"
    assert list(media.iterdir()) == [picked]
    assert not list(data_dir.rglob("*.mp4")), "导入不得在数据目录复制一份源文件"
    stored = _episodes(memory_db, result["project"]["id"])[0]["source_path"]
    assert stored == str(picked.resolve()), "登记的是源文件原路径"


def test_create_cross_directory_has_empty_source_root(
    memory_db: sqlite3.Connection, tmp_path: Path, sample_video: Path
) -> None:
    first, second = tmp_path / "a", tmp_path / "b"
    first.mkdir()
    second.mkdir()
    a = first / "ep1.mp4"
    b = second / "ep2.mp4"
    shutil.copy(sample_video, a)
    shutil.copy(sample_video, b)

    result = _create(_router(memory_db, tmp_path / "data"), [b, a]).result

    assert result["project"]["source_kind"] == "files"
    assert result["project"]["source_root"] == "", "跨目录没有公共父目录"
    assert [ep["name"] for ep in result["episodes"]] == ["ep1", "ep2"], "跨目录按父目录分组稳定"


def test_create_reports_skipped_text_file(
    memory_db: sqlite3.Connection, tmp_path: Path, sample_video: Path
) -> None:
    media = tmp_path / "media"
    media.mkdir()
    for name in ("ep1.mp4", "ep2.mp4"):
        shutil.copy(sample_video, media / name)
    text = media / "readme.txt"
    text.write_text("not video", encoding="utf-8")

    router = _router(memory_db, tmp_path / "data")
    result = _create(router, [media / "ep1.mp4", text, media / "ep2.mp4"]).result

    assert [ep["name"] for ep in result["episodes"]] == ["ep1", "ep2"]
    assert result["skipped"] == [{"path": str(text), "reason": "unsupported"}]
    assert result["project"]["episode_count"] == 2


def test_create_reports_missing_file_and_keeps_valid_ones(
    memory_db: sqlite3.Connection, tmp_path: Path, sample_video: Path
) -> None:
    media = tmp_path / "media"
    media.mkdir()
    picked = media / "ep1.mp4"
    shutil.copy(sample_video, picked)
    gone = media / "gone.mp4"

    result = _create(_router(memory_db, tmp_path / "data"), [picked, gone]).result

    assert [ep["name"] for ep in result["episodes"]] == ["ep1"]
    assert result["skipped"] == [{"path": str(gone), "reason": "missing"}]


def test_create_requires_name(memory_db: sqlite3.Connection, tmp_path: Path) -> None:
    response = _call(
        _router(memory_db, tmp_path / "data"),
        "project.create_from_files",
        {"name": "   ", "files": [str(tmp_path / "ep1.mp4")]},
    )
    assert response.error is not None and response.error.code == -32102
    assert _count(memory_db, "projects") == 0


@pytest.mark.parametrize("files", [None, [], "not-a-list"])
def test_create_requires_non_empty_file_list(
    memory_db: sqlite3.Connection, tmp_path: Path, files: Any
) -> None:
    response = _call(
        _router(memory_db, tmp_path / "data"),
        "project.create_from_files",
        {"name": "剧集", "files": files},
    )
    assert response.error is not None and response.error.code == -32102
    assert _count(memory_db, "projects") == 0


def test_create_rejects_all_invalid_files(
    memory_db: sqlite3.Connection, tmp_path: Path
) -> None:
    text = tmp_path / "readme.txt"
    text.write_text("not video", encoding="utf-8")
    response = _create(_router(memory_db, tmp_path / "data"), [text])
    assert response.error is not None and response.error.code == -32103
    assert _count(memory_db, "projects") == 0
    assert _count(memory_db, "episodes") == 0


def test_create_rolls_back_project_and_episodes_on_failure(
    memory_db: sqlite3.Connection,
    tmp_path: Path,
    sample_video: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    media = tmp_path / "media"
    media.mkdir()
    for name in ("ep1.mp4", "ep2.mp4"):
        shutil.copy(sample_video, media / name)

    def _boom(*_args: Any, **_kwargs: Any) -> int:
        raise sqlite3.OperationalError("disk I/O error (simulated)")

    from dramaclip.infra.storage.repos import episodes as episodes_repo

    monkeypatch.setattr(episodes_repo, "append_many", _boom)
    router = _router(memory_db, tmp_path / "data")
    response = _create(router, [media / "ep1.mp4", media / "ep2.mp4"])

    assert response.error is not None and response.error.code == -32603
    assert "simulated" in response.error.message
    assert _count(memory_db, "projects") == 0, "插入集失败不得留下半截项目"
    assert _count(memory_db, "episodes") == 0


class _CapturingExecutor:
    """只记录提交，不真的跑分析——测试断言的是“任务已受理”，不是分析结果。"""

    def __init__(self) -> None:
        self.submitted: list[Any] = []

    def submit(self, fn: Any) -> None:
        self.submitted.append(fn)


def test_create_autostarts_analysis(
    memory_db: sqlite3.Connection, tmp_path: Path, sample_video: Path
) -> None:
    media = tmp_path / "media"
    media.mkdir()
    picked = media / "ep1.mp4"
    shutil.copy(sample_video, picked)
    sent: list[dict[str, Any]] = []
    executor = _CapturingExecutor()
    router = _router(
        memory_db,
        tmp_path / "data",
        settings={"analysis.full_threshold": 15},
        notifier=Notifier(sent.append),
        executor=executor,
        job_store=jobs.JobStore(memory_db),
        cancel_events={},
    )

    result = _create(router, [picked]).result

    project_id = result["project"]["id"]
    rows = memory_db.execute(
        "SELECT type, ref_id FROM jobs WHERE ref_id = ?", (project_id,)
    ).fetchall()
    assert [tuple(row) for row in rows] == [("analysis", project_id)]
    assert len(executor.submitted) == 1
    assert _episodes(memory_db, project_id)[0]["status"] == "analyzing"


def test_create_survives_autostart_domain_error(
    memory_db: sqlite3.Connection,
    tmp_path: Path,
    sample_video: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """自动分析失败是增益动作失败：建项目必须成功，且留一条可读日志（2.3）。"""
    media = tmp_path / "media"
    media.mkdir()
    picked = media / "ep1.mp4"
    shutil.copy(sample_video, picked)
    sent: list[dict[str, Any]] = []

    def _fail(_context: Any, _params: dict[str, Any]) -> dict[str, Any]:
        raise RpcDomainError(-32202, "没有待分析的集")

    monkeypatch.setattr(analysis_api, "start", _fail)
    router = _router(
        memory_db,
        tmp_path / "data",
        settings={"analysis.full_threshold": 15},
        notifier=Notifier(sent.append),
        executor=_CapturingExecutor(),
        job_store=jobs.JobStore(memory_db),
        cancel_events={},
    )

    result = _create(router, [picked]).result

    project_id = result["project"]["id"]
    assert _count(memory_db, "projects") == 1, "建项目不因自动分析失败而回滚"
    assert _count(memory_db, "jobs") == 0, "失败路径不得留下半截分析任务"
    logs = [
        item["params"]["message"]
        for item in sent
        if item["method"] == "log.append" and item["params"]["level"] == "warn"
    ]
    assert any("自动分析未启动" in message and "没有待分析的集" in message for message in logs)
    detail = _call(router, "project.get", {"project_id": project_id}).result
    assert len(detail["episodes"]) == 1
