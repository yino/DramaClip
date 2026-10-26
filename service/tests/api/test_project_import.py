"""api.project_import：多选导入规划器（纯函数，不落库）。"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

import pytest

from dramaclip.api import project_import as import_api


def _plan(
    files: list[str],
    *,
    mode: str = import_api.PLAN_CREATE,
    existing: list[str] | None = None,
) -> import_api.ImportPlan:
    return import_api.plan_import(files, mode=mode, existing=existing or [])


def test_plan_accepts_videos_and_keeps_probe_metadata(
    tmp_path: Path, sample_video: Path
) -> None:
    picked = tmp_path / "ep1.mp4"
    shutil.copy(sample_video, picked)
    plan = _plan([str(picked)])
    assert [item.name for item in plan.accepted] == ["ep1"]
    episode = plan.accepted[0]
    assert episode.source_path == str(picked.resolve())
    assert episode.size_bytes == picked.stat().st_size
    assert episode.duration > 2 and episode.has_audio is True
    assert plan.skipped == []
    assert plan.mode == import_api.PLAN_CREATE
    assert episode.as_episode() == {
        "source_path": str(picked.resolve()),
        "name": "ep1",
        "duration": episode.duration,
        "has_audio": True,
    }


def test_plan_same_directory_default_name(tmp_path: Path, sample_video: Path) -> None:
    media = tmp_path / "剧集"
    media.mkdir()
    for name in ("ep1.mp4", "ep2.mp4"):
        shutil.copy(sample_video, media / name)
    plan = _plan([str(media / "ep1.mp4"), str(media / "ep2.mp4")])
    assert plan.common_parent == str(media.resolve())
    assert plan.default_name == "剧集"


def test_plan_cross_directory_uses_first_selected_parent(
    tmp_path: Path, sample_video: Path
) -> None:
    first, second = tmp_path / "第一处", tmp_path / "第二处"
    first.mkdir()
    second.mkdir()
    # 选择顺序：先选第二处，再选第一处 → 默认名取“第一个所选文件”的父目录名
    later = second / "ep1.mp4"
    earlier = first / "ep2.mp4"
    shutil.copy(sample_video, later)
    shutil.copy(sample_video, earlier)

    plan = _plan([str(later), str(earlier)])

    assert plan.common_parent == "", "跨目录没有公共父目录"
    assert plan.default_name == "第二处"
    assert [Path(item.source_path).parent.name for item in plan.accepted] == ["第一处", "第二处"]


def test_plan_natural_sort_ep2_before_ep10(tmp_path: Path, sample_video: Path) -> None:
    for name in ("ep10.mp4", "ep2.mp4", "ep1.mp4"):
        shutil.copy(sample_video, tmp_path / name)
    plan = _plan([str(tmp_path / name) for name in ("ep10.mp4", "ep2.mp4", "ep1.mp4")])
    assert [item.name for item in plan.accepted] == ["ep1", "ep2", "ep10"]
    assert [Path(item.source_path).name for item in plan.accepted] == [
        "ep1.mp4",
        "ep2.mp4",
        "ep10.mp4",
    ]


def test_plan_dedupes_same_file_selected_twice(
    tmp_path: Path, sample_video: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    picked = tmp_path / "ep1.mp4"
    shutil.copy(sample_video, picked)
    monkeypatch.chdir(tmp_path)

    plan = _plan([str(picked), "ep1.mp4", str(picked)])

    assert len(plan.accepted) == 1, "同一文件选两次只算一集"
    assert [item.reason for item in plan.skipped] == [
        import_api.SKIP_DUPLICATE,
        import_api.SKIP_DUPLICATE,
    ]
    assert plan.skipped[0].path == "ep1.mp4", "跳过报告回显用户选的那条（相对路径写法）"
    assert plan.skipped[1].path == str(picked), "绝对路径写法同样回显原样"


def test_plan_skips_text_file(tmp_path: Path) -> None:
    text = tmp_path / "readme.txt"
    text.write_text("not a video", encoding="utf-8")
    plan = _plan([str(text)])
    assert plan.accepted == []
    assert [(item.path, item.reason) for item in plan.skipped] == [
        (str(text), import_api.SKIP_UNSUPPORTED)
    ]
    assert plan.default_name == ""


def test_plan_skips_missing_path(tmp_path: Path) -> None:
    plan = _plan([str(tmp_path / "nope.mp4"), ""])
    assert [item.reason for item in plan.skipped] == [
        import_api.SKIP_MISSING,
        import_api.SKIP_MISSING,
    ]


def test_plan_skips_unreadable_file(tmp_path: Path, sample_video: Path) -> None:
    if os.geteuid() == 0:
        pytest.skip("root 无视文件权限位")
    picked = tmp_path / "ep1.mp4"
    shutil.copy(sample_video, picked)
    picked.chmod(0o000)
    try:
        plan = _plan([str(picked)])
        assert [item.reason for item in plan.skipped] == [import_api.SKIP_UNREADABLE]
    finally:
        picked.chmod(0o644)


def test_plan_skips_probe_failed(tmp_path: Path) -> None:
    broken = tmp_path / "broken.mp4"
    broken.write_bytes(b"definitely not a container")
    plan = _plan([str(broken)])
    assert plan.accepted == []
    assert [item.reason for item in plan.skipped] == [import_api.SKIP_PROBE_FAILED]


def test_plan_dedupes_against_existing_episodes(tmp_path: Path, sample_video: Path) -> None:
    old = tmp_path / "ep1.mp4"
    new = tmp_path / "ep2.mp4"
    shutil.copy(sample_video, old)
    shutil.copy(sample_video, new)

    plan = _plan([str(old), str(new)], mode=import_api.PLAN_APPEND, existing=[str(old)])

    assert plan.mode == import_api.PLAN_APPEND
    assert [item.name for item in plan.accepted] == ["ep2"]
    assert [(item.path, item.reason) for item in plan.skipped] == [
        (str(old), import_api.SKIP_DUPLICATE)
    ]


def test_plan_rejects_unknown_mode() -> None:
    with pytest.raises(ValueError):
        import_api.plan_import([], mode="steal")


def test_plan_all_invalid_has_no_default_name(tmp_path: Path) -> None:
    text = tmp_path / "a.txt"
    text.write_text("x", encoding="utf-8")
    plan = _plan([str(text), str(tmp_path / "gone.mp4")])
    assert plan.accepted == []
    assert plan.common_parent == ""
    assert plan.default_name == ""
    assert len(plan.skipped) == 2
