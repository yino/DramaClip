"""infra.ffmpeg.runner：真实 ffmpeg 执行（进度/超时/取消）。"""

from __future__ import annotations

import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from dramaclip.infra.ffmpeg import runner


def test_parse_out_time_variants() -> None:
    assert runner._parse_out_time("out_time_us=1500000\n") == pytest.approx(1.5)
    # ffmpeg 的 out_time_ms 实际是微秒（上游历史怪癖）
    assert runner._parse_out_time("out_time_ms=1500000\n") == pytest.approx(1.5)
    assert runner._parse_out_time("out_time=00:00:12.500\n") == pytest.approx(12.5)
    assert runner._parse_out_time("frame=42\n") is None
    assert runner._parse_out_time("out_time_us=N/A\n") is None


def test_extract_audio_produces_wav(sample_video: Path, tmp_path: Path) -> None:
    wav = tmp_path / "out.wav"
    runner.run(runner.extract_audio_args(str(sample_video), str(wav)))
    assert wav.is_file() and wav.stat().st_size > 1000


def test_progress_callback_receives_fraction(sample_video: Path, tmp_path: Path) -> None:
    wav = tmp_path / "progress.wav"
    seen: list[float] = []
    runner.run(
        runner.extract_audio_args(str(sample_video), str(wav)),
        total_duration_s=3.0,
        on_progress=seen.append,
    )
    assert seen and 0.0 <= seen[-1] <= 1.0


def test_nonzero_exit_raises(tmp_path: Path) -> None:
    with pytest.raises(runner.FfmpegError):
        runner.run(["-i", str(tmp_path / "missing.mp4"), "-f", "null", "-"])


def test_fast_exit_waits_for_the_stderr_drainer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """stderr 是旁路线程在读：进程刚退出就 join 不及，错误原文会整段丢掉。

    真机表现（2026-10-20 出片失败）：``ffmpeg 退出码 234：`` 后面空着，错误被分进
    ``unknown``，还白做一次编码回退。这里把排空线程故意拖慢，没 join 的实现必红。
    """
    real_drain = runner._drain_stderr

    def slow_drain(process: subprocess.Popen[str], sink: list[str]) -> None:
        time.sleep(0.2)
        real_drain(process, sink)

    monkeypatch.setattr(runner, "_drain_stderr", slow_drain)
    monkeypatch.setattr(runner, "resolve_ffmpeg", lambda: sys.executable)

    with pytest.raises(runner.FfmpegError) as excinfo:
        runner.run(
            ["-c", "import sys; sys.stderr.write('No such filter: ass\\n'); sys.exit(234)"]
        )

    assert "No such filter: ass" in str(excinfo.value)
    assert excinfo.value.returncode == 234


def test_cancel_kills_process(sample_video: Path, tmp_path: Path) -> None:
    cancel = threading.Event()
    threading.Timer(0.05, cancel.set).start()
    with pytest.raises(runner.FfmpegError) as excinfo:
        runner.run(
            [
                "-y",
                "-i",
                str(sample_video),
                "-vf",
                "scale=1920:1080",
                "-c:v",
                "libx264",
                "-preset",
                "veryslow",
                "-f",
                "null",
                "-",
            ],
            cancel=cancel,
        )
    assert excinfo.value.cancelled
