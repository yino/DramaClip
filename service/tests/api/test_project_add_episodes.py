"""api.project.add_episodes：向既有项目追加素材（不替换、不重编号、不自动分析）。"""

from __future__ import annotations

import shutil
import sqlite3
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from dramaclip.api import project as project_api
from dramaclip.infra import jobs
from dramaclip.transport.rpc import Router, RpcRequest


def _router(conn: sqlite3.Connection, data_dir: Path, **extra: Any) -> Router:
    context = SimpleNamespace(
        conn=conn, data_dir=data_dir, work_dir=data_dir / "cache", **extra
    )
    router = Router()
    project_api.register(router, context)  # type: ignore[arg-type]
    return router


def _call(router: Router, method: str, params: dict[str, Any]) -> Any:
    return router.dispatch(RpcRequest(id=1, method=method, params=params))


def _create_folder_project(router: Router, media: Path, name: str = "目录剧") -> dict[str, Any]:
    return _call(
        router, "project.create", {"name": name, "source_path": str(media)}
    ).result


def _seed_episodes(
    conn: sqlite3.Connection, project_id: str, media: Path, names: list[str]
) -> None:
    """直接落集，模拟一次目录扫集的结果（不跑 ffmpeg 封面，测试聚焦追加语义）。"""
    from dramaclip.infra.storage.repos import episodes as episodes_repo

    episodes_repo.append_many(
        conn,
        project_id,
        [
            {
                "source_path": str(media / f"{name}.mp4"),
                "name": name,
                "duration": 3.0,
                "has_audio": True,
            }
            for name in names
        ],
    )


def _add(router: Router, project_id: str, files: list[Path]) -> Any:
    return _call(
        router,
        "project.add_episodes",
        {"project_id": project_id, "files": [str(path) for path in files]},
    )


def _detail(router: Router, project_id: str) -> dict[str, Any]:
    return _call(router, "project.get", {"project_id": project_id}).result


class _ExplodingExecutor:
    """追加不得自动分析：一旦有人 submit，测试立刻炸。"""

    def submit(self, _fn: Any) -> None:
        raise AssertionError("追加素材不得自动创建分析任务")


def test_add_appends_after_max_episode_number(
    memory_db: sqlite3.Connection, tmp_path: Path, sample_video: Path
) -> None:
    media = tmp_path / "media"
    media.mkdir()
    for name in ("ep1.mp4", "ep2.mp4"):
        shutil.copy(sample_video, media / name)
    extra = tmp_path / "extra"
    extra.mkdir()
    for name in ("ep3.mp4", "ep4.mp4"):
        shutil.copy(sample_video, extra / name)
    router = _router(memory_db, tmp_path / "data")
    project = _create_folder_project(router, media)
    _seed_episodes(memory_db, project["id"], media, ["ep1", "ep2"])
    before = _detail(router, project["id"])["episodes"]

    result = _add(router, project["id"], [extra / "ep3.mp4", extra / "ep4.mp4"]).result

    assert result["added"] == 2
    assert result["skipped"] == []
    assert [ep["episode_number"] for ep in result["episodes"]] == [3, 4], "编号从 max+1 起"
    assert [ep["name"] for ep in result["episodes"]] == ["ep3", "ep4"]
    after = _detail(router, project["id"])["episodes"]
    assert [(ep["id"], ep["episode_number"], ep["name"]) for ep in after[:2]] == [
        (ep["id"], ep["episode_number"], ep["name"]) for ep in before
    ], "既有集不重编号、不丢"


def test_add_deduplicates_selected_and_existing_paths(
    memory_db: sqlite3.Connection, tmp_path: Path, sample_video: Path
) -> None:
    media = tmp_path / "media"
    media.mkdir()
    shutil.copy(sample_video, media / "ep1.mp4")
    extra = tmp_path / "extra"
    extra.mkdir()
    fresh = extra / "ep2.mp4"
    shutil.copy(sample_video, fresh)
    router = _router(memory_db, tmp_path / "data")
    project = _create_folder_project(router, media)
    _seed_episodes(memory_db, project["id"], media, ["ep1"])

    result = _add(router, project["id"], [fresh, fresh, media / "ep1.mp4"]).result

    assert result["added"] == 1
    assert result["skipped"] == [
        {"path": str(fresh), "reason": "duplicate"},
        {"path": str(media / "ep1.mp4"), "reason": "duplicate"},
    ], "选重了和已导入过都计 duplicate"
    assert len(_detail(router, project["id"])["episodes"]) == 2


def test_add_all_invalid_keeps_episodes(
    memory_db: sqlite3.Connection, tmp_path: Path, sample_video: Path
) -> None:
    media = tmp_path / "media"
    media.mkdir()
    shutil.copy(sample_video, media / "ep1.mp4")
    text = tmp_path / "readme.txt"
    text.write_text("not video", encoding="utf-8")
    router = _router(memory_db, tmp_path / "data")
    project = _create_folder_project(router, media)
    _seed_episodes(memory_db, project["id"], media, ["ep1"])
    before = _detail(router, project["id"])["episodes"]

    response = _add(router, project["id"], [text, tmp_path / "gone.mp4"])

    assert response.error is not None and response.error.code == -32103
    assert _detail(router, project["id"])["episodes"] == before, "全无效不得改动已有素材"


@pytest.mark.parametrize("job_type", ["analysis", "prescreen"])
def test_add_rejects_while_ingest_running(
    memory_db: sqlite3.Connection, tmp_path: Path, sample_video: Path, job_type: str
) -> None:
    media = tmp_path / "media"
    media.mkdir()
    shutil.copy(sample_video, media / "ep1.mp4")
    fresh = tmp_path / "extra" / "ep2.mp4"
    fresh.parent.mkdir()
    shutil.copy(sample_video, fresh)
    job_store = jobs.JobStore(memory_db)
    router = _router(memory_db, tmp_path / "data", job_store=job_store)
    project = _create_folder_project(router, media)
    _seed_episodes(memory_db, project["id"], media, ["ep1"])
    job_store.create(job_type, ref_id=project["id"])
    before = _detail(router, project["id"])["episodes"]

    response = _add(router, project["id"], [fresh])

    assert response.error is not None and response.error.code == -32105
    assert "正在" in response.error.message, "错误信息要说明为什么现在不能加"
    assert _detail(router, project["id"])["episodes"] == before, "拒绝即无部分写入"


def test_add_turns_folder_project_into_mixed(
    memory_db: sqlite3.Connection, tmp_path: Path, sample_video: Path
) -> None:
    media = tmp_path / "media"
    media.mkdir()
    shutil.copy(sample_video, media / "ep1.mp4")
    fresh = tmp_path / "extra" / "ep2.mp4"
    fresh.parent.mkdir()
    shutil.copy(sample_video, fresh)
    router = _router(memory_db, tmp_path / "data")
    project = _create_folder_project(router, media)
    _seed_episodes(memory_db, project["id"], media, ["ep1"])
    assert project["source_kind"] == "folder"

    added = _add(router, project["id"], [fresh]).result

    assert added["added"] == 1
    after = _detail(router, project["id"])["project"]
    assert after["source_kind"] == "mixed"
    assert after["source_root"] == str(media), "追加外部文件不得覆盖原目录来源"


def test_add_keeps_files_project_kind(
    memory_db: sqlite3.Connection, tmp_path: Path, sample_video: Path
) -> None:
    media = tmp_path / "media"
    media.mkdir()
    first = media / "ep1.mp4"
    second = media / "ep2.mp4"
    shutil.copy(sample_video, first)
    shutil.copy(sample_video, second)
    router = _router(memory_db, tmp_path / "data")
    project = _call(
        router,
        "project.create_from_files",
        {"name": "文件剧", "files": [str(first)]},
    ).result["project"]

    result = _add(router, project["id"], [second]).result

    assert result["added"] == 1
    after = _detail(router, project["id"])["project"]
    assert after["source_kind"] == "files", "文件项目追加同目录文件仍是 files"
    assert after["source_root"] == str(media.resolve())


def test_add_does_not_autostart_analysis(
    memory_db: sqlite3.Connection, tmp_path: Path, sample_video: Path
) -> None:
    media = tmp_path / "media"
    media.mkdir()
    shutil.copy(sample_video, media / "ep1.mp4")
    fresh = tmp_path / "extra" / "ep2.mp4"
    fresh.parent.mkdir()
    shutil.copy(sample_video, fresh)
    job_store = jobs.JobStore(memory_db)
    router = _router(
        memory_db,
        tmp_path / "data",
        settings={"analysis.full_threshold": 15},
        notifier=SimpleNamespace(log=lambda *_a, **_k: None),
        executor=_ExplodingExecutor(),
        job_store=job_store,
        cancel_events={},
    )
    project = _create_folder_project(router, media)
    _seed_episodes(memory_db, project["id"], media, ["ep1"])

    added = _add(router, project["id"], [fresh]).result

    assert added["added"] == 1
    assert (
        memory_db.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0
    ), "追加后由用户手动触发分析，不自动起任务"


def test_reorder_after_add_renumbers_one_to_n(
    memory_db: sqlite3.Connection, tmp_path: Path, sample_video: Path
) -> None:
    media = tmp_path / "media"
    media.mkdir()
    for name in ("ep1.mp4", "ep2.mp4"):
        shutil.copy(sample_video, media / name)
    extra = tmp_path / "extra"
    extra.mkdir()
    for name in ("ep3.mp4", "ep4.mp4"):
        shutil.copy(sample_video, extra / name)
    router = _router(memory_db, tmp_path / "data")
    project = _create_folder_project(router, media)
    _seed_episodes(memory_db, project["id"], media, ["ep1", "ep2"])
    added = _add(router, project["id"], [extra / "ep3.mp4", extra / "ep4.mp4"]).result
    assert added["added"] == 2
    episodes = _detail(router, project["id"])["episodes"]

    response = _call(
        router,
        "project.reorder_episodes",
        {"project_id": project["id"], "episode_ids": [ep["id"] for ep in reversed(episodes)]},
    )

    assert response.error is None
    reordered = _detail(router, project["id"])["episodes"]
    assert [ep["episode_number"] for ep in reordered] == [1, 2, 3, 4]
    assert [ep["name"] for ep in reordered] == ["ep4", "ep3", "ep2", "ep1"], "新增集参与重排且不丢"


def test_add_fills_project_cover_only(
    memory_db: sqlite3.Connection, tmp_path: Path, sample_video: Path
) -> None:
    """逐集封面交给 ensure_covers 预算涓流，追加接口只补项目封面。"""
    media = tmp_path / "media"
    media.mkdir()
    first = media / "ep1.mp4"
    second = media / "ep2.mp4"
    shutil.copy(sample_video, first)
    shutil.copy(sample_video, second)
    data_dir = tmp_path / "data"
    router = _router(memory_db, data_dir)
    project = _create_folder_project(router, media)

    added = _add(router, project["id"], [first, second]).result

    assert added["added"] == 2
    after = _detail(router, project["id"])["project"]
    cover = Path(str(after["cover_path"]))
    assert cover.is_file(), "追加后项目应有封面"
    covers = data_dir / "covers"
    assert not list(covers.glob("ep_*.jpg")), "逐集封面由 ensure_covers 涓流补，不在追加里拍"


def test_add_unknown_project(memory_db: sqlite3.Connection, tmp_path: Path) -> None:
    response = _add(_router(memory_db, tmp_path / "data"), "missing", [tmp_path / "ep1.mp4"])
    assert response.error is not None and response.error.code == -32101
