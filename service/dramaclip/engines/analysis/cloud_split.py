"""云端识别的分片边界：停顿优先、时长/字节双上限兜底。

Dashscope 直连与激活网关两条链路共用同一套切分语义，避免两种引擎在 5 分钟
与 8 MiB 限制上各切各的。这里只做纯切分，不发请求、不改音频内容。
"""

from __future__ import annotations

import wave
from pathlib import Path

from dramaclip.engines.analysis import pause_split

_LOGGER = __import__("logging").getLogger(__name__)


def split_wav_for_cloud(
    wav_path: Path,
    max_clip_s: float,
    *,
    max_bytes: int | None = None,
) -> list[pause_split.Clip]:
    """按停顿切 ≤max_clip_s 的片；可选地再按 WAV 字节上限收紧单片时长。"""
    with wave.open(str(wav_path), "rb") as wf:
        frame_rate = wf.getframerate() or 1
        duration = wf.getnframes() / frame_rate
        bytes_per_second = frame_rate * wf.getnchannels() * wf.getsampwidth()
    try:
        clips = pause_split.speech_clips(wav_path, max_clip_s=max_clip_s)
    except (OSError, pause_split.PauseAnalysisUnavailable) as exc:
        _LOGGER.warning(
            "云端识别：停顿切分不可用（%s: %s），整条按 %.0fs 切片",
            type(exc).__name__,
            exc,
            max_clip_s,
        )
        clips = [pause_split.Clip(0.0, duration)]
    limit_s = max_clip_s
    if max_bytes is not None and bytes_per_second > 0:
        limit_s = min(limit_s, max(max_bytes - 1024, 1) / bytes_per_second)
    chunks: list[pause_split.Clip] = []
    for clip in clips:
        chunks.extend(_split_span(clip, limit_s))
    return chunks


def _split_span(clip: pause_split.Clip, limit_s: float) -> list[pause_split.Clip]:
    """把超过 ``limit_s`` 的区间等分；边界不落在停顿上，但这是硬上限兜底。"""
    span = clip.end - clip.start
    if span <= limit_s or limit_s <= 0:
        return [clip]
    parts = int(span / limit_s) + (1 if span % limit_s else 0)
    step = span / parts
    return [
        pause_split.Clip(clip.start + step * index, clip.start + step * (index + 1))
        for index in range(parts)
    ]
