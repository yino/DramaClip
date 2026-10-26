"""episodes repo：状态清扫（崩溃残留 analyzing 回退）。"""

from __future__ import annotations

import sqlite3

from dramaclip.infra.storage.repos import episodes as episodes_repo


def _make_episode(conn: sqlite3.Connection, project_id: str = "p1", episode_id: str = "e1") -> str:
    conn.execute(
        "INSERT INTO projects (id, name, source_path, status, created_at, updated_at)"
        " VALUES (?, 'n', ?, 'created', 1, 1)",
        (project_id, f"/tmp/{project_id}"),
    )
    conn.execute(
        "INSERT INTO episodes (id, project_id, episode_number, source_path, duration,"
        " status, created_at) VALUES (?, ?, 1, '/tmp/a.mp4', 1.0, 'pending', 1)",
        (episode_id, project_id),
    )
    conn.commit()
    return episode_id


def test_reset_stale_analyzing_resets_only_analyzing(memory_db: sqlite3.Connection) -> None:
    keep = _make_episode(memory_db, "p1", "e-done")
    stale = _make_episode(memory_db, "p2", "e-stale")
    memory_db.execute("UPDATE episodes SET status = 'done' WHERE id = ?", (keep,))
    memory_db.execute("UPDATE episodes SET status = 'analyzing' WHERE id = ?", (stale,))
    memory_db.commit()

    reset = episodes_repo.reset_stale_analyzing(memory_db)

    assert reset == 1
    statuses = dict(
        memory_db.execute("SELECT id, status FROM episodes").fetchall()
    )
    assert statuses == {keep: "done", stale: "prescreened"}


def test_reset_stale_analyzing_noop_when_none(memory_db: sqlite3.Connection) -> None:
    _make_episode(memory_db, "p1", "e1")
    assert episodes_repo.reset_stale_analyzing(memory_db) == 0


# ---- append_many：导入追加素材（不删旧集、不覆盖自定义名） ----


def test_append_many_keeps_existing_rows_and_numbering(memory_db: sqlite3.Connection) -> None:
    _make_episode(memory_db, "p1", "e1")
    memory_db.execute(
        "UPDATE episodes SET name = '自定义第1集', status = 'done', episode_number = 7"
        " WHERE id = 'e1'"
    )
    memory_db.commit()

    added = episodes_repo.append_many(
        memory_db,
        "p1",
        [
            {"episode_number": 1, "source_path": "/tmp/b.mp4", "duration": 2.0, "name": "b"},
            {
                "episode_number": 2,
                "source_path": "/tmp/c.mp4",
                "duration": 3.0,
                "name": "c",
                "has_audio": False,
            },
        ],
    )

    assert added == 2
    old, new_b, new_c = episodes_repo.list_by_project(memory_db, "p1")
    assert (old["id"], old["name"], old["status"], old["episode_number"]) == (
        "e1",
        "自定义第1集",
        "done",
        7,
    )
    assert [new_b["episode_number"], new_c["episode_number"]] == [8, 9]
    assert [new_b["status"], new_c["status"]] == ["pending", "pending"]
    assert [new_b["name"], new_c["name"]] == ["b", "c"]
    assert [new_b["has_audio"], new_c["has_audio"]] == [None, 0]


def test_append_many_numbers_after_previous_batches(memory_db: sqlite3.Connection) -> None:
    _make_episode(memory_db, "p1", "e1")
    episodes_repo.append_many(
        memory_db,
        "p1",
        [
            {"source_path": "/tmp/b.mp4", "duration": 2.0},
            {"source_path": "/tmp/c.mp4", "duration": 3.0},
        ],
    )
    episodes_repo.append_many(
        memory_db, "p1", [{"source_path": "/tmp/d.mp4", "duration": 4.0}]
    )

    numbers = [e["episode_number"] for e in episodes_repo.list_by_project(memory_db, "p1")]
    assert numbers == [1, 2, 3, 4]


def test_append_many_commit_false_rolls_back_whole_batch(memory_db: sqlite3.Connection) -> None:
    _make_episode(memory_db, "p1", "e1")

    added = episodes_repo.append_many(
        memory_db,
        "p1",
        [{"source_path": "/tmp/b.mp4", "duration": 2.0}],
        commit=False,
    )
    assert added == 1
    memory_db.rollback()

    assert [e["id"] for e in episodes_repo.list_by_project(memory_db, "p1")] == ["e1"]


def test_append_many_empty_is_noop(memory_db: sqlite3.Connection) -> None:
    _make_episode(memory_db, "p1", "e1")
    assert episodes_repo.append_many(memory_db, "p1", []) == 0
    assert [e["id"] for e in episodes_repo.list_by_project(memory_db, "p1")] == ["e1"]
