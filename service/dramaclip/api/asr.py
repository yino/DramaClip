"""asr 命名空间：云端识别积分查询（asr.credits）。

渲染层要的是「能不能用、还剩多少」，不是底层异常：未配置、令牌失效、网关抖动
一律降级为 available=false + 可读原因，RPC 不炸页面。设备令牌与网关地址不进任何
出参，也不写日志——余额是账号态，令牌是设备态，两者不混。
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any

from dramaclip.api.context import AppContext
from dramaclip.transport.rpc import Router

_TIMEOUT_S = 10.0
_UNIT = "minute"
_UNCONFIGURED = "云端识别未配置：请先在激活页完成激活，或切换到本地引擎"
_MISSING_TOKEN = "云端识别缺少设备令牌：请先在激活页完成激活，或切换到本地引擎"
_INVALID_TOKEN = "云端识别令牌已失效（HTTP 401）：请在激活页重新激活后再试"
_FORBIDDEN = "云端识别未授权（HTTP 403）：请确认设备激活状态"
_NOT_FOUND = "网关不支持云端识别积分查询（HTTP 404）：请升级服务端或切换本地引擎"
_RATE_LIMITED = "云端识别积分查询过于频繁（HTTP 429）：请稍后重试"
_UNAVAILABLE = "云端识别网关暂时不可用（HTTP {status}）：请稍后重试"
_BAD_JSON = "云端识别网关返回了无法解析的响应"
_BAD_PAYLOAD = "云端识别网关返回了无法解析的积分数据"
_NETWORK = "无法连接云端识别网关：请检查网络或稍后重试"


def register(router: Router, context: AppContext) -> None:
    router.register("asr.credits", lambda _params: credits(context))


def credits(context: AppContext) -> dict[str, Any]:
    """只读余额：成功才算 available；任何失败都带 reason 返回，不抛异常。"""
    settings = context.settings
    base_url = str(settings.get("asr.base_url", "")).strip().rstrip("/")
    token = str(settings.get("asr.api_key", "")).strip()
    if base_url == "":
        return _unavailable(_UNCONFIGURED)
    if token == "":
        return _unavailable(_MISSING_TOKEN)
    request = urllib.request.Request(
        f"{base_url}/asr/credits",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=_TIMEOUT_S) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        return _unavailable(_http_reason(exc.code))
    except (urllib.error.URLError, TimeoutError, OSError):
        return _unavailable(_NETWORK)
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return _unavailable(_BAD_JSON)
    return _payload(payload)


def _payload(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return _unavailable(_BAD_PAYLOAD)
    try:
        limit = float(payload["limit"])
        used = float(payload["used"])
        remaining = float(payload["remaining"])
    except (KeyError, TypeError, ValueError):
        return _unavailable(_BAD_PAYLOAD)
    return {
        "available": True,
        "limit": limit,
        "used": used,
        "remaining": remaining,
        "unit": str(payload.get("unit") or _UNIT),
        "updated_at": str(payload.get("updated_at") or ""),
    }


def _http_reason(status: int) -> str:
    if status == 401:
        return _INVALID_TOKEN
    if status == 403:
        return _FORBIDDEN
    if status == 404:
        return _NOT_FOUND
    if status == 429:
        return _RATE_LIMITED
    if status >= 500:
        return _UNAVAILABLE.format(status=status)
    return f"云端识别积分查询被拒绝（HTTP {status}）：请稍后重试"


def _unavailable(reason: str) -> dict[str, Any]:
    return {
        "available": False,
        "limit": 0.0,
        "used": 0.0,
        "remaining": 0.0,
        "unit": _UNIT,
        "updated_at": "",
        "reason": reason,
    }
