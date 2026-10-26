"""云端识别（激活网关）引擎：三步 HTTP 的桩会话验收。

全程不发真实网络：注入一个按调用顺序回放的 ``_Session``，断言请求形状、分片
时间轴、错误分类与重试节奏。端点契约以 design D2 为准（upload-policy → 临时
存储直传 → transcriptions），不 mock 服务端实现。
"""

from __future__ import annotations

import time
import wave
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
import requests

from dramaclip.engines.analysis import gateway_asr, pause_split
from dramaclip.engines.analysis.gateway_asr import (
    GatewayAsrError,
    GatewayCloudAsrEngine,
)

_POLICY_HOST = "https://oss.example.com/upload"


class _Response:
    def __init__(
        self,
        status_code: int = 200,
        payload: Any = None,
        *,
        headers: dict[str, str] | None = None,
    ) -> None:
        self.status_code = status_code
        self._payload = payload
        self.headers = headers or {}

    def json(self) -> Any:
        if self._payload is None:
            raise ValueError("no json body")
        return self._payload


class _Session:
    """记录每次 POST 的 URL/参数，按队列（handler）返回预置响应。"""

    def __init__(self, handler: Callable[[str, dict[str, Any], int], Any]) -> None:
        self.calls: list[dict[str, Any]] = []
        self._handler = handler

    def post(self, url: str, **kwargs: Any) -> Any:
        self.calls.append({"url": url, **kwargs})
        return self._handler(url, kwargs, len(self.calls))


def _queued(*responses: Any) -> Callable[[str, dict[str, Any], int], Any]:
    def handler(_url: str, _kwargs: dict[str, Any], index: int) -> Any:
        item = responses[min(index - 1, len(responses) - 1)]
        if isinstance(item, Exception):
            raise item
        return item

    return handler


def _policy(
    *,
    upload_id: str = "upload-abc",
    expires_at: float | None = None,
) -> dict[str, Any]:
    return {
        "upload_id": upload_id,
        "upload_host": _POLICY_HOST,
        "upload_dir": "asr-tmp/act-1",
        "fields": {"key": "asr-tmp/act-1/chunk-000.wav", "policy": "cG9saWN5"},
        "oss_url": "oss://asr-tmp/act-1/chunk-000.wav",
        "expires_at": time.time() + 900 if expires_at is None else expires_at,
    }


def _transcript(
    *sentences: dict[str, Any], text: str = "你好"
) -> dict[str, Any]:
    return {
        "text": text,
        "segments": list(sentences),
        "duration_seconds": 2.0,
        "model": "fun-asr-flash",
        "credits": {"used": 2, "remaining": 98},
    }


def _write_wav(
    path: Path, *, seconds: float = 0.5, rate: int = 16000, channels: int = 1
) -> None:
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(b"\x00\x00" * int(rate * seconds) * channels)


def _stub_split(monkeypatch: pytest.MonkeyPatch, spans: list[tuple[float, float]]) -> None:
    """把停顿切分固定成给定区间；片段文件真的落盘（policy 要 stat、直传要读）。"""
    clips = [pause_split.Clip(start, end) for start, end in spans]

    def fake_speech_clips(_path: Path, **_kwargs: Any) -> list[pause_split.Clip]:
        return clips

    def fake_split_wav(
        wav_path: Path, clip_list: list[pause_split.Clip], out_dir: Path
    ) -> list[tuple[pause_split.Clip, Path]]:
        data = Path(wav_path).read_bytes()
        result: list[tuple[pause_split.Clip, Path]] = []
        for index, clip in enumerate(clip_list):
            path = Path(out_dir) / f"clip-{index}.wav"
            path.write_bytes(data)
            result.append((clip, path))
        return result

    monkeypatch.setattr(gateway_asr.pause_split, "speech_clips", fake_speech_clips)
    monkeypatch.setattr(gateway_asr.pause_split, "split_wav", fake_split_wav)


def _engine(
    session: _Session,
    *,
    model: str = "fun-asr-flash",
    diarization: bool = False,
    sleep: Callable[[float], None] | None = None,
    base_url: str = "https://gateway.example/v1/",
    api_key: str = " device-token ",
) -> GatewayCloudAsrEngine:
    return GatewayCloudAsrEngine(
        base_url,
        api_key,
        model,
        diarization,
        session=session,
        sleep=sleep or (lambda _seconds: None),
    )


def test_three_step_upload_then_transcribe(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """成功三步：policy → multipart 直传（不带令牌）→ transcriptions（带令牌）。"""
    wav = tmp_path / "episode.wav"
    _write_wav(wav)
    _stub_split(monkeypatch, [(0.0, 2.0)])
    policy = _policy()
    sentence = {"start": 0.1, "end": 1.5, "text": "陛下大事不好"}
    session = _Session(
        _queued(_Response(200, policy), _Response(204), _Response(200, _transcript(sentence)))
    )
    segments = _engine(session).transcribe(wav)

    assert len(session.calls) == 3
    policy_call, upload_call, transcribe_call = session.calls

    assert policy_call["url"] == "https://gateway.example/v1/asr/upload-policy"
    assert policy_call["headers"]["Authorization"] == "Bearer device-token"
    body = policy_call["json"]
    assert body["model"] == "fun-asr-flash"
    assert body["file_name"] == "chunk-000.wav"
    assert body["content_length"] == wav.stat().st_size

    assert upload_call["url"] == _POLICY_HOST
    assert upload_call["data"] == policy["fields"]
    assert "headers" not in upload_call, "临时存储直传不许带网关令牌"
    file_name, _handle, mime = upload_call["files"]["file"]
    assert file_name == body["file_name"]
    assert mime == "audio/wav"

    assert transcribe_call["url"] == "https://gateway.example/v1/audio/transcriptions"
    assert transcribe_call["headers"]["Authorization"] == "Bearer device-token"
    payload = transcribe_call["json"]
    assert payload["upload_id"] == policy["upload_id"]
    assert payload["oss_url"] == policy["oss_url"]
    assert payload["format"] == "wav"
    assert payload["sample_rate"] == 16000
    assert payload["duration_seconds"] == 2.0
    assert payload["model"] == "fun-asr-flash"
    assert payload["language"] == "zh"
    assert payload["diarization"] is False
    assert isinstance(payload["request_id"], str) and payload["request_id"]

    assert [(s.start, s.end, s.text) for s in segments] == [(0.1, 1.5, "陛下大事不好")]
    assert segments[0].speaker is None
    assert [(w.word, w.start, w.end) for w in segments[0].words] == [
        ("陛下大事不好", 0.1, 1.5)
    ]


def test_chunks_carry_offsets_and_speaker_labels(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """分片各自从 0 计时，拼回整集要加片起点；Qwen 才开分离并映射角色标签。"""
    wav = tmp_path / "episode.wav"
    _write_wav(wav)
    _stub_split(monkeypatch, [(0.0, 2.0), (2.0, 4.0)])
    first = _transcript({"start": 0.2, "end": 1.2, "text": "陛下", "speaker": 0})
    second = _transcript(
        {"start": 0.1, "end": 0.9, "text": "何事", "speaker": 1},
        {"start": 1.0, "end": 1.5, "text": "惊慌", "speaker": "角色C"},
    )
    session = _Session(
        _queued(
            _Response(200, _policy()),
            _Response(204),
            _Response(200, first),
            _Response(200, _policy(upload_id="upload-two")),
            _Response(204),
            _Response(200, second),
        )
    )
    segments = _engine(
        session, model="qwen-audio-3.1-asr-flash", diarization=True
    ).transcribe(wav)

    assert [(s.start, s.text, s.speaker) for s in segments] == [
        (0.2, "陛下", "角色A"),
        (2.1, "何事", "角色B"),
        (3.0, "惊慌", "角色C"),
    ]
    payloads = [call["json"] for call in session.calls if "json" in call]
    assert [p["diarization"] for p in payloads if "duration_seconds" in p] == [True, True]
    assert [p["model"] for p in payloads if "duration_seconds" in p] == [
        "qwen-audio-3.1-asr-flash",
        "qwen-audio-3.1-asr-flash",
    ]


def test_token_invalid_401_is_not_retried(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    wav = tmp_path / "episode.wav"
    _write_wav(wav)
    _stub_split(monkeypatch, [(0.0, 2.0)])
    session = _Session(
        _queued(_Response(401, {"error": {"code": "invalid_token", "message": "token invalid"}}))
    )
    with pytest.raises(GatewayAsrError) as info:
        _engine(session, sleep=lambda _s: pytest.fail("401 不许重试")).transcribe(wav)

    assert info.value.status == 401
    assert "重新激活" in str(info.value)
    assert len(session.calls) == 1


def test_credits_exhausted_402_is_not_retried_and_reports_credits(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    wav = tmp_path / "episode.wav"
    _write_wav(wav)
    _stub_split(monkeypatch, [(0.0, 2.0)])
    body = {
        "error": {
            "code": "asr_credits_exhausted",
            "message": "insufficient credits",
            "limit": 600,
            "used": 590,
            "remaining": 10,
            "required": 3,
        }
    }
    session = _Session(_queued(_Response(402, body)))
    with pytest.raises(GatewayAsrError) as info:
        _engine(session, sleep=lambda _s: pytest.fail("402 不许重试")).transcribe(wav)

    message = str(info.value)
    assert info.value.status == 402
    assert "积分不足" in message
    assert "已用 590/600 积分" in message
    assert "本次需要 3 积分" in message
    assert "本地引擎" in message
    assert len(session.calls) == 1


def test_rate_limited_429_honors_retry_after(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    wav = tmp_path / "episode.wav"
    _write_wav(wav)
    _stub_split(monkeypatch, [(0.0, 2.0)])
    sleeps: list[float] = []
    session = _Session(
        _queued(
            _Response(
                429,
                {"error": {"code": "rate_limited", "message": "slow down"}},
                headers={"Retry-After": "7"},
            ),
            _Response(200, _policy()),
            _Response(204),
            _Response(200, _transcript({"start": 0.0, "end": 1.0, "text": "好"})),
        )
    )
    segments = _engine(session, sleep=sleeps.append).transcribe(wav)

    assert sleeps == [7.0]
    assert len(segments) == 1
    assert len(session.calls) == 4


def test_gateway_5xx_is_retried_with_backoff_then_succeeds(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """转写 5xx 只退避不重换凭证：同一 upload_id 再试，别白传一遍音频。"""
    wav = tmp_path / "episode.wav"
    _write_wav(wav)
    _stub_split(monkeypatch, [(0.0, 2.0)])
    policy = _policy()
    error = _Response(503, {"error": {"code": "asr_not_configured", "message": "not ready"}})
    session = _Session(
        _queued(
            _Response(200, policy),
            _Response(204),
            error,
            _Response(204),
            _Response(200, _transcript({"start": 0.0, "end": 1.0, "text": "好"})),
        )
    )
    sleeps: list[float] = []
    segments = _engine(session, sleep=sleeps.append).transcribe(wav)

    assert sleeps == [0.5]
    assert len(segments) == 1
    transcripts = [c["json"] for c in session.calls if c["url"].endswith("/audio/transcriptions")]
    assert [p["upload_id"] for p in transcripts] == ["upload-abc", "upload-abc"]


def test_upload_failure_is_retried_before_transcription(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    wav = tmp_path / "episode.wav"
    _write_wav(wav)
    _stub_split(monkeypatch, [(0.0, 2.0)])
    session = _Session(
        _queued(
            _Response(200, _policy()),
            _Response(500),
            _Response(204),
            _Response(200, _transcript({"start": 0.0, "end": 1.0, "text": "好"})),
        )
    )
    sleeps: list[float] = []
    segments = _engine(session, sleep=sleeps.append).transcribe(wav)

    assert sleeps == [0.5]
    assert len(segments) == 1
    uploads = [c for c in session.calls if c["url"] == _POLICY_HOST]
    assert len(uploads) == 2
    assert uploads[0]["data"] == uploads[1]["data"]
    assert len(session.calls) == 4


def test_expired_upload_id_is_renewed_before_retry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """服务端判凭证过期（400 asr_upload_expired）：换新凭证重走三步，不复用旧 id。"""
    wav = tmp_path / "episode.wav"
    _write_wav(wav)
    _stub_split(monkeypatch, [(0.0, 2.0)])
    expired = _Response(
        400,
        {"error": {"code": "asr_upload_expired", "message": "expired"}},
    )
    session = _Session(
        _queued(
            _Response(200, _policy(upload_id="stale")),
            _Response(204),
            expired,
            _Response(200, _policy(upload_id="fresh")),
            _Response(204),
            _Response(200, _transcript({"start": 0.0, "end": 1.0, "text": "好"})),
        )
    )
    sleeps: list[float] = []
    segments = _engine(session, sleep=sleeps.append).transcribe(wav)

    assert sleeps == [0.5]
    assert len(segments) == 1
    policy_calls = [c for c in session.calls if c["url"].endswith("/asr/upload-policy")]
    assert len(policy_calls) == 2
    assert policy_calls[0]["json"]["file_name"] == policy_calls[1]["json"]["file_name"]
    transcripts = [c["json"] for c in session.calls if c["url"].endswith("/audio/transcriptions")]
    assert [p["upload_id"] for p in transcripts] == ["stale", "fresh"]


def test_locally_expired_policy_is_renewed_when_a_chunk_retries(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """重试时凭证已过 expires_at：本地先换凭证，不拿过期 id 再撞一次 400。"""
    wav = tmp_path / "episode.wav"
    _write_wav(wav)
    _stub_split(monkeypatch, [(0.0, 2.0)])
    session = _Session(
        _queued(
            _Response(200, _policy(upload_id="stale", expires_at=time.time() - 1)),
            _Response(204),
            _Response(500),
            _Response(200, _policy(upload_id="fresh")),
            _Response(204),
            _Response(200, _transcript({"start": 0.0, "end": 1.0, "text": "好"})),
        )
    )
    segments = _engine(session, sleep=lambda _s: None).transcribe(wav)

    assert len(segments) == 1
    policy_calls = [c for c in session.calls if c["url"].endswith("/asr/upload-policy")]
    assert len(policy_calls) == 2
    transcripts = [c["json"] for c in session.calls if c["url"].endswith("/audio/transcriptions")]
    assert [p["upload_id"] for p in transcripts] == ["stale", "fresh"]


def test_network_error_is_retried_then_succeeds(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    wav = tmp_path / "episode.wav"
    _write_wav(wav)
    _stub_split(monkeypatch, [(0.0, 2.0)])
    session = _Session(
        _queued(
            requests.ConnectionError("boom"),
            _Response(200, _policy()),
            _Response(204),
            _Response(200, _transcript({"start": 0.0, "end": 1.0, "text": "好"})),
        )
    )
    sleeps: list[float] = []
    assert len(_engine(session, sleep=sleeps.append).transcribe(wav)) == 1
    assert sleeps == [0.5]


def test_empty_chunk_is_skipped_not_failed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    wav = tmp_path / "episode.wav"
    _write_wav(wav)
    _stub_split(monkeypatch, [(0.0, 2.0)])
    session = _Session(
        _queued(
            _Response(200, _policy()),
            _Response(204),
            _Response(502, {"error": {"code": "asr_empty", "message": "no words"}}),
        )
    )
    assert _engine(session).transcribe(wav) == []


def test_client_error_400_is_not_retried(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    wav = tmp_path / "episode.wav"
    _write_wav(wav)
    _stub_split(monkeypatch, [(0.0, 2.0)])
    session = _Session(
        _queued(
            _Response(200, _policy()),
            _Response(204),
            _Response(
                400,
                {"error": {"code": "asr_upload_invalid", "message": "oss_url mismatch"}},
            ),
        )
    )
    with pytest.raises(GatewayAsrError) as info:
        _engine(session, sleep=lambda _s: pytest.fail("400 不许重试")).transcribe(wav)

    assert info.value.status == 400
    assert "asr_upload_invalid" in str(info.value)
    assert "被拒绝" in str(info.value)
    assert len(session.calls) == 3


def test_missing_config_is_reported_before_any_network_call(tmp_path: Path) -> None:
    missing_wav = tmp_path / "missing.wav"
    with pytest.raises(ValueError, match="asr.base_url"):
        GatewayCloudAsrEngine("", "device-token").transcribe(missing_wav)
    with pytest.raises(ValueError, match="asr.api_key"):
        GatewayCloudAsrEngine("https://gateway.example/v1", "  ").transcribe(missing_wav)


def test_model_alias_and_diarization_mapping() -> None:
    assert GatewayCloudAsrEngine.supports_model("qwen-audio-3.1-asr-flash") is True
    assert GatewayCloudAsrEngine.supports_model("fun-asr-flash") is False
    qwen = GatewayCloudAsrEngine("https://gw/v1", "t", "qwen-audio-3.1-asr-flash", True)
    assert qwen.name == "cloud_gateway:qwen-audio-3.1-asr-flash"
    assert qwen.supports_diarization is True
    fun = GatewayCloudAsrEngine("https://gw/v1", "t", "fun-asr-flash")
    assert fun.supports_diarization is False


def test_chunks_are_capped_at_180_seconds(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    wav = tmp_path / "long.wav"
    _write_wav(wav)
    seen: dict[str, float] = {}

    def fake_speech_clips(_path: Path, **kwargs: Any) -> list[pause_split.Clip]:
        seen.update(kwargs)
        return [pause_split.Clip(0.0, 400.0)]

    monkeypatch.setattr(gateway_asr.pause_split, "speech_clips", fake_speech_clips)
    chunks = gateway_asr._chunks(wav)

    assert seen["max_clip_s"] == 180.0
    assert len(chunks) == 3
    assert chunks[0].start == 0.0
    assert chunks[-1].end == pytest.approx(400.0)
    assert all(chunk.end - chunk.start <= 180.0 for chunk in chunks)


def test_high_rate_stereo_chunks_stay_below_8_mib(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """48k 双声道 180s ≈ 34.6 MiB：按字节上限重切，宁多一片也不让服务端 413。"""
    wav = tmp_path / "hd.wav"
    _write_wav(wav, seconds=0.1, rate=48000, channels=2)
    monkeypatch.setattr(
        gateway_asr.pause_split,
        "speech_clips",
        lambda _path, **_kwargs: [pause_split.Clip(0.0, 180.0)],
    )
    chunks = gateway_asr._chunks(wav)

    bytes_per_second = 48000 * 2 * 2
    assert len(chunks) == 5
    assert all(
        (chunk.end - chunk.start) * bytes_per_second <= gateway_asr._MAX_UPLOAD_BYTES
        for chunk in chunks
    )


def test_chunking_falls_back_when_pause_analysis_is_unavailable(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    wav = tmp_path / "broken.wav"
    _write_wav(wav)

    def unavailable(_path: Path, **_kwargs: Any) -> list[pause_split.Clip]:
        raise pause_split.PauseAnalysisUnavailable("not 16k mono")

    monkeypatch.setattr(gateway_asr.pause_split, "speech_clips", unavailable)
    chunks = gateway_asr._chunks(wav)

    assert len(chunks) == 1
    assert chunks[0].start == 0.0
    assert chunks[0].end == pytest.approx(0.5)


def test_oversize_chunk_is_rejected_without_retry(tmp_path: Path) -> None:
    big = tmp_path / "big.wav"
    big.write_bytes(b"\x00" * (gateway_asr._MAX_UPLOAD_BYTES + 1))
    engine = GatewayCloudAsrEngine(
        "https://gateway.example/v1",
        "device-token",
        session=_Session(_queued(_Response(200, _policy()))),
        sleep=lambda _s: pytest.fail("超限不许重试"),
    )
    with pytest.raises(GatewayAsrError, match="8 MiB"):
        engine._request_policy(0, big)
