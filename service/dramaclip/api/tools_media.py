"""工具箱单文件源预检：坏片先说人话，无音轨的正常视频保留 OCR 通道。"""

from __future__ import annotations

import subprocess
from pathlib import Path

from dramaclip.engines.analysis.models import AsrSegment, OcrSegment
from dramaclip.infra.ffmpeg import probe


def inspect_video_source(path: Path) -> bool:
    """返回视频是否有音轨；元信息或首帧不可读时抛可操作的源片错误。"""
    try:
        media = probe.probe(path)
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        raise ValueError(
            f"无法读取视频（文件可能损坏或不完整）：{path.name}；请重新下载或更换文件"
        ) from exc
    if not probe.decodes_first_frame(path):
        raise ValueError(
            f"视频画面无法解码（文件可能损坏或下载不完整）：{path.name}；"
            "请重新下载或更换文件"
        )
    return media.has_audio


def ocr_only_lines(bars: list[OcrSegment]) -> list[AsrSegment]:
    """无音轨时直接把硬字幕驻留窗当文案行，时间与文本均取 OCR。"""
    return [
        AsrSegment(start=bar.start, end=bar.end, text=bar.text, source="ocr")
        for bar in bars
        if bar.text.strip()
    ]
