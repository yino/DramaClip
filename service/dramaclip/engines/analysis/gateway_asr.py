"""云端识别（激活网关）：临时上传凭证 → 分片直传 → 网关转写。

桌面端只持设备令牌，供应商 Key 与服务端地址永不下发；音频字节不经过网关，
只把临时对象地址（``oss://``）与元数据发给网关（design D2/D11）。

每个分片三步：``POST /v1/asr/upload-policy`` 换凭证 → multipart 直传临时存储 →
``POST /v1/audio/transcriptions`` 换回句级结果。401/402 不重试，429 按服务端
``Retry-After`` 退避，5xx/网络/上传失败单片有限重试，凭证 TTL 过期重新申请。
"""

from __future__ import annotations

import contextlib
import logging
import tempfile
import time
import uuid
import wave
from collections.abc import Callable
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any

import requests

from dramaclip.engines.analysis import pause_split
from dramaclip.engines.analysis.models import AsrSegment, WordSpan
from dramaclip.engines.analysis.transcriber import _speaker_label

_LOGGER = logging.getLogger(__name__)

# 网关契约：单文件 ≤ 8 MiB、单次声明时长 ≤ 180s（server-cloud-asr-proxy spec）
_MAX_UPLOAD_BYTES = 8 * 1024 * 1024
# 4xx 里可以退避重试的“网络类”状态；429 单独处理（读 Retry-After）
_RETRY_STATUS = frozenset({408, 425})


class GatewayAsrError(RuntimeError):
    """网关识别失败：带 HTTP 状态与网关错误码，供上层拼可读提示。

    ``retryable`` / ``retry_after`` / ``refresh_policy`` 只给本模块的分片重试环用，
    不指望调用方解析——调用方看到的就是一句能转述给业主的中文。
    """

    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        code: str = "",
        retryable: bool = False,
        retry_after: float | None = None,
        refresh_policy: bool = False,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.retryable = retryable
        self.retry_after = retry_after
        self.refresh_policy = refresh_policy


class GatewayCloudAsrEngine:
    """激活网关代理的云端 ASR 引擎（与本地/dashscope 引擎同接口）。"""

    _CHUNK_S = 180.0
    _CHUNK_ATTEMPTS = 3
    # 只有 Qwen 系走供应商说话人分离；fun-asr-flash 没有这条通道，不能伪造“已分离”
    _DIARIZED_MODEL_PREFIX = "qwen-audio"

    def __init__(
        self,
        base_url: str,
        api_key: str,
        model: str = "fun-asr-flash",
        diarization: bool = False,
        *,
        session: requests.Session | None = None,
        timeout_s: float = 120.0,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._base_url = base_url.strip().rstrip("/")
        self._api_key = api_key.strip()
        self._model = model
        self._diarization = diarization
        # 构造期不炸：所有已接线引擎必须能空载构造；缺配置由 transcribe/运行时前置检查报错
        self._session: Any = session if session is not None else requests.Session()
        self._timeout_s = timeout_s
        self._sleep = sleep

    @property
    def name(self) -> str:
        return f"cloud_gateway:{self._model}"

    @classmethod
    def supports_model(cls, model: str) -> bool:
        return model.startswith(cls._DIARIZED_MODEL_PREFIX)

    @property
    def supports_diarization(self) -> bool:
        return self.supports_model(self._model)

    def transcribe(
        self, wav_path: Path, language: str = "zh", *, hotwords: str = ""
    ) -> list[AsrSegment]:
        """整集转写：按停顿切片 → 逐片上传转写 → 按片起点拼回整集时间轴。

        ``hotwords`` 网关协议没有入口：别名模型自带热词能力，人工热词只服务本地引擎。
        """
        self._require_ready()
        with wave.open(str(wav_path), "rb") as wf:
            sample_rate = wf.getframerate()
        chunks = _chunks(wav_path)
        labels: dict[int, str] = {}
        segments: list[AsrSegment] = []
        with tempfile.TemporaryDirectory(prefix="asr-gateway-") as tmp:
            work = Path(tmp)
            clips = pause_split.split_wav(wav_path, chunks, work)
            for index, (clip, clip_path) in enumerate(clips):
                for sentence in self._chunk_sentences(
                    index, clip, clip_path, sample_rate, language
                ):
                    segment = self._segment(clip.start, sentence, labels)
                    if segment.text:
                        segments.append(segment)
        segments.sort(key=lambda segment: segment.start)
        if not segments:
            _LOGGER.warning("云端识别（网关）：所有分片均无词（%s）", wav_path.name)
        return segments

    # ---- 分片重试环 -------------------------------------------------------

    def _chunk_sentences(
        self,
        index: int,
        clip: pause_split.Clip,
        clip_path: Path,
        sample_rate: int,
        language: str,
    ) -> list[dict[str, Any]]:
        """单片三步；失败按类型换策略，最多 ``_CHUNK_ATTEMPTS`` 次。"""
        policy: dict[str, Any] | None = None
        last_error: GatewayAsrError | None = None
        for attempt in range(1, self._CHUNK_ATTEMPTS + 1):
            try:
                policy = self._fresh_policy(policy, index, clip_path)
                self._upload(clip_path, policy)
                return self._request_transcription(index, clip, policy, sample_rate, language)
            except GatewayAsrError as exc:
                last_error = exc
                if not exc.retryable or attempt >= self._CHUNK_ATTEMPTS:
                    raise
                if exc.refresh_policy:
                    policy = None
                self._backoff(attempt, exc)
            except requests.RequestException as exc:
                last_error = GatewayAsrError(
                    f"云端识别网络失败（{type(exc).__name__}）：请检查网络后重试",
                    retryable=True,
                )
                if attempt >= self._CHUNK_ATTEMPTS:
                    raise last_error from exc
                self._backoff(attempt, last_error)
        raise last_error if last_error is not None else GatewayAsrError("云端识别失败")

    def _fresh_policy(
        self, policy: dict[str, Any] | None, index: int, clip_path: Path
    ) -> dict[str, Any]:
        """凭证不存在或已过 TTL → 重新申请；绝不复用过期 upload_id。"""
        if policy is not None and _policy_expired(policy):
            _LOGGER.info("云端识别：上传凭证已过期，重新申请（分片 %d）", index)
            policy = None
        if policy is None:
            policy = self._request_policy(index, clip_path)
        return policy

    def _backoff(self, attempt: int, error: GatewayAsrError) -> None:
        delay = error.retry_after if error.retry_after is not None else attempt * 0.5
        _LOGGER.warning(
            "云端识别分片请求失败（第 %d/%d 次，HTTP %s %s）：%.1fs 后重试",
            attempt,
            self._CHUNK_ATTEMPTS,
            error.status if error.status is not None else "-",
            error.code or "-",
            delay,
        )
        self._sleep(max(delay, 0.0))

    # ---- 三步 -------------------------------------------------------------

    def _request_policy(self, index: int, clip_path: Path) -> dict[str, Any]:
        size = clip_path.stat().st_size
        if size > _MAX_UPLOAD_BYTES:
            # 走到这里说明分片逻辑坏了：非重试，别拿 413 循环烧积分
            raise GatewayAsrError(
                f"分片超过 8 MiB 上限（{size} 字节）：分片逻辑错误，请上报日志",
                status=None,
            )
        file_name = f"chunk-{index:03d}.wav"
        payload = {"model": self._model, "file_name": file_name, "content_length": size}
        data = self._checked(self._post("/asr/upload-policy", payload), context="申请上传凭证")
        missing = [
            key for key in ("upload_id", "upload_host", "fields", "oss_url") if not data.get(key)
        ]
        if missing or not isinstance(data.get("fields"), dict):
            raise GatewayAsrError(
                f"网关上传凭证缺少字段：{'、'.join(missing) or 'fields'}（请升级服务端后重试）",
                status=200,
            )
        policy = dict(data)
        policy["file_name"] = file_name
        return policy

    def _upload(self, clip_path: Path, policy: dict[str, Any]) -> None:
        file_name = str(policy["file_name"])
        try:
            with clip_path.open("rb") as fh:
                response = self._session.post(
                    str(policy["upload_host"]),
                    data=policy["fields"],
                    files={"file": (file_name, fh, "audio/wav")},
                    timeout=self._timeout_s,
                )
        except requests.RequestException as exc:
            raise GatewayAsrError(
                f"云存储上传失败（{type(exc).__name__}）：网络异常，重试分片",
                retryable=True,
            ) from exc
        status = response.status_code
        if status < 400:
            return
        retryable = status >= 500 or status in _RETRY_STATUS
        action = "稍后重试分片" if retryable else "请检查分片与凭证"
        raise GatewayAsrError(
            f"云存储上传失败（HTTP {status}）：{action}",
            status=status,
            retryable=retryable,
            retry_after=_retry_after(response),
        )

    def _request_transcription(
        self,
        index: int,
        clip: pause_split.Clip,
        policy: dict[str, Any],
        sample_rate: int,
        language: str,
    ) -> list[dict[str, Any]]:
        payload = {
            "upload_id": policy["upload_id"],
            "oss_url": policy["oss_url"],
            "format": "wav",
            "sample_rate": sample_rate,
            "duration_seconds": round(clip.end - clip.start, 3),
            "model": self._model,
            "language": language,
            "diarization": self._diarization,
            "request_id": str(uuid.uuid4()),
        }
        response = self._post("/audio/transcriptions", payload)
        data = self._json(response, context="转写")
        status = response.status_code
        code, message = _error_fields(data)
        if code == "asr_empty":
            # 该片是静音/BGM：跳过而不是拖死整集（与 dashscope 引擎 no-words 同判据）
            _LOGGER.info("云端识别：分片 %d 无人声（asr_empty），跳过", index)
            return []
        if not 200 <= status < 300:
            raise self._http_error(status, code, message, data, response)
        segments = data.get("segments")
        if not isinstance(segments, list):
            raise GatewayAsrError(
                f"网关转写响应缺少 segments 列表（HTTP {status}）：请升级服务端后重试",
                status=status,
            )
        return [item for item in segments if isinstance(item, dict)]

    # ---- HTTP -------------------------------------------------------------

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._api_key}", "Accept": "application/json"}

    def _post(self, path: str, payload: dict[str, Any]) -> Any:
        return self._session.post(
            f"{self._base_url}{path}",
            json=payload,
            headers=self._headers(),
            timeout=self._timeout_s,
        )

    def _checked(self, response: Any, *, context: str) -> dict[str, Any]:
        data = self._json(response, context=context)
        status = response.status_code
        if 200 <= status < 300:
            return data
        code, message = _error_fields(data)
        raise self._http_error(status, code, message, data, response)

    def _json(self, response: Any, *, context: str) -> dict[str, Any]:
        try:
            data = response.json()
        except ValueError:
            if response.status_code >= 400:
                return {}
            raise GatewayAsrError(
                f"网关{context}返回了无法解析的响应（HTTP {response.status_code}）",
                status=response.status_code,
            ) from None
        return data if isinstance(data, dict) else {}

    def _http_error(
        self,
        status: int,
        code: str,
        message: str,
        data: dict[str, Any],
        response: Any,
    ) -> GatewayAsrError:
        detail = f" {code}" if code else ""
        if status == 401:
            return GatewayAsrError(
                f"云端识别令牌已失效（HTTP 401{detail}）：请在激活页重新激活后再试",
                status=status,
                code=code,
            )
        if status == 402:
            return GatewayAsrError(
                f"云端识别积分不足（HTTP 402{detail}）：{_credits_hint(data)}"
                "请补充积分或切换本地引擎",
                status=status,
                code=code,
            )
        if status == 404:
            return GatewayAsrError(
                f"网关不支持云端识别接口（HTTP 404{detail}）：请升级服务端或切换本地引擎",
                status=status,
                code=code,
            )
        if status == 429:
            retry_after = _retry_after(response)
            wait = f"{retry_after:.0f}s 后自动重试" if retry_after is not None else "稍后自动重试"
            return GatewayAsrError(
                f"云端识别请求过于频繁（HTTP 429{detail}）：{wait}",
                status=status,
                code=code,
                retryable=True,
                retry_after=retry_after,
            )
        if code == "asr_upload_expired":
            return GatewayAsrError(
                "上传凭证已过期（HTTP 400 asr_upload_expired）：重新申请后重试",
                status=status,
                code=code,
                retryable=True,
                refresh_policy=True,
            )
        if status >= 500 or status in _RETRY_STATUS:
            # 5xx/超时类：单片退避重试，别把整集判死
            return GatewayAsrError(
                f"云端识别网关暂时不可用（HTTP {status}{detail}）：稍后自动重试",
                status=status,
                code=code,
                retryable=True,
                retry_after=_retry_after(response),
            )
        reason = f"：{message}" if message else ""
        return GatewayAsrError(
            f"云端识别请求被拒绝（HTTP {status}{detail}）{reason}",
            status=status,
            code=code,
        )

    # ---- 解析 -------------------------------------------------------------

    def _segment(
        self, offset_s: float, sentence: dict[str, Any], labels: dict[int, str]
    ) -> AsrSegment:
        """网关句 → 现有字幕结构：时间秒 → 整集时间轴，文本补一个整句词级跨度。"""
        text = str(sentence.get("text") or "").strip()
        start = round(_as_float(sentence.get("start")) + offset_s, 3)
        end = round(max(_as_float(sentence.get("end")) + offset_s, start), 3)
        words = [WordSpan(start=start, end=end, word=text)] if text else []
        return AsrSegment(
            start=start,
            end=end,
            text=text,
            speaker=_speaker_value(sentence.get("speaker"), labels),
            words=words,
        )

    def _require_ready(self) -> None:
        if not self._base_url:
            raise ValueError(
                "云端识别缺少 asr.base_url：请在激活页重新激活，或切换到本地引擎"
            )
        if not self._api_key:
            raise ValueError(
                "云端识别缺少 asr.api_key（设备令牌）：请在激活页重新激活，或切换到本地引擎"
            )


def _chunks(wav_path: Path) -> list[pause_split.Clip]:
    """按停顿切片，并保证单片 ≤180s 且 ≤8 MiB；切不动的大片按等分兜底。"""
    from dramaclip.engines.analysis import cloud_split

    return cloud_split.split_wav_for_cloud(
        wav_path,
        GatewayCloudAsrEngine._CHUNK_S,
        max_bytes=_MAX_UPLOAD_BYTES,
    )


def _speaker_value(value: Any, labels: dict[int, str]) -> str | None:
    """网关 speaker 原样保留；数字聚类 id 仍映射成角色A/角色B…（与既有字幕一致）。"""
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        if value not in labels:
            labels[value] = _speaker_label(len(labels))
        return labels[value]
    text = str(value).strip()
    if not text:
        return None
    if text.isdigit():
        cluster = int(text)
        if cluster not in labels:
            labels[cluster] = _speaker_label(len(labels))
        return labels[cluster]
    return text


def _error_fields(data: dict[str, Any]) -> tuple[str, str]:
    error = data.get("error")
    if isinstance(error, dict):
        return str(error.get("code") or ""), str(error.get("message") or "")
    return str(data.get("code") or ""), str(data.get("message") or "")


def _credits_hint(data: dict[str, Any]) -> str:
    """402 的积分细节（limit/used/remaining/required）可能挂在 error 里或顶层。"""
    sources = [data.get("error"), data]

    def pick(key: str) -> Any:
        for source in sources:
            if isinstance(source, dict) and source.get(key) is not None:
                return source[key]
        return None

    parts: list[str] = []
    used, limit = pick("used"), pick("limit")
    if used is not None and limit is not None:
        parts.append(f"已用 {used}/{limit} 积分")
    else:
        remaining = pick("remaining")
        if remaining is not None:
            parts.append(f"剩余 {remaining} 积分")
    required = pick("required")
    if required is not None:
        parts.append(f"本次需要 {required} 积分")
    return "，".join(parts) + "；" if parts else ""


def _retry_after(response: Any) -> float | None:
    """读 Retry-After：秒数或 HTTP-date；缺失/格式坏 → None（由退避公式兜底）。"""
    headers = getattr(response, "headers", None)
    value = headers.get("Retry-After") if hasattr(headers, "get") else None
    if value is None:
        return None
    text = str(value).strip()
    with contextlib.suppress(ValueError):
        return max(float(text), 0.0)
    try:
        parsed = parsedate_to_datetime(text)
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return max(parsed.timestamp() - time.time(), 0.0)


def _expiry_epoch(value: Any) -> float | None:
    """expires_at 兼容 epoch 秒与 ISO 字符串（服务端契约未钉死编码）。"""
    if value is None or value == "" or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    with contextlib.suppress(ValueError):
        return float(text)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.timestamp()


def _policy_expired(policy: dict[str, Any]) -> bool:
    expires_at = _expiry_epoch(policy.get("expires_at"))
    return expires_at is not None and expires_at <= time.time()


def _as_float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0
