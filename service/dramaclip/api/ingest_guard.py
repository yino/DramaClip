"""分析中互斥判据：项目有未终态的 analysis/prescreen 任务时，导入必须让路。

判据必须唯一：analysis.autostart 用它在扫集后决定是否再起作业，导入接口用它
决定是否允许追加素材；两处各写一套「什么算正在分析」就会一边放行一边拦截。
"""

from __future__ import annotations

import sqlite3
from typing import Any

from dramaclip.infra import jobs

_INGEST_TYPES = ("analysis", "prescreen")

_COLUMNS = (
    "id",
    "type",
    "ref_id",
    "status",
    "progress",
    "label",
    "error",
    "created_at",
    "updated_at",
)


def active_ingest_job(conn: sqlite3.Connection, project_id: str) -> dict[str, Any] | None:
    """返回该项目未终态的 analysis/prescreen 任务；没有则 None。

    直接查 jobs 表、不依赖 AppContext，RPC 与后台调度共用同一判据。同一项目并发
    分析会互相覆盖产物；追加素材会让运行中的作业读到移动中的集列表。
    """
    rows = conn.execute(
        f"SELECT {', '.join(_COLUMNS)} FROM jobs"
        " WHERE ref_id = ? AND type IN (?, ?)"
        " ORDER BY updated_at DESC, created_at DESC, id",
        (project_id, *_INGEST_TYPES),
    ).fetchall()
    for row in rows:
        job = dict(zip(_COLUMNS, row, strict=True))
        if not jobs.is_terminal(str(job["status"])):
            return job
    return None
