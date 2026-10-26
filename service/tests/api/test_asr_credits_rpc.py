"""api.asr：云端识别积分查询（asr.credits）的降级口径。

余额来自激活网关的账号态；设备令牌只用于请求头，绝不进 RPC 出参。
失败一律 available=false + 可读原因——页面拿到的是“能不能用”，不是异常堆栈。
"""

from __future__ import annotations

import json
import socket
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, HTTPServer
from types import SimpleNamespace
from typing import Any

from dramaclip.api import asr as asr_api
from dramaclip.transport.rpc import Router, RpcRequest

_BALANCE = {
    "limit": 600,
    "used": 30,
    "remaining": 570,
    "unit": "minute",
    "updated_at": "2026-10-22T12:00:00Z",
}


class Harness:
    def __init__(self, settings: dict[str, str]) -> None:
        self.context = SimpleNamespace(settings=settings)
        self.router = Router()
        asr_api.register(self.router, self.context)  # type: ignore[arg-type]

    def credits(self) -> Any:
        response = self.router.dispatch(
            RpcRequest(id="asr.credits", method="asr.credits", params={})
        )
        assert response.error is None, response.error
        return response.result


@contextmanager
def _gateway(
    status: int = 200, body: Any = None, raw: bytes | None = None
) -> Iterator[tuple[str, list[tuple[str, str, str]]]]:
    """本地假网关：记录 path / Authorization，测试不碰真实网络。"""
    seen: list[tuple[str, str, str]] = []
    payload = raw if raw is not None else json.dumps(body if body is not None else {}).encode()

    class _Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 - http.server 命名约定
            seen.append(
                (
                    self.path,
                    self.headers.get("Authorization", ""),
                    self.headers.get("Accept", ""),
                )
            )
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_args: Any) -> None:
            return

    httpd = HTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_port}/v1", seen
    finally:
        httpd.shutdown()
        httpd.server_close()


def _closed_port_url() -> str:
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    return f"http://127.0.0.1:{port}/v1"


def test_credits_reads_gateway_balance_with_device_token() -> None:
    with _gateway(body=_BALANCE) as (base_url, seen):
        result = Harness({"asr.base_url": base_url, "asr.api_key": "device-token"}).credits()
    assert result == {
        "available": True,
        "limit": 600.0,
        "used": 30.0,
        "remaining": 570.0,
        "unit": "minute",
        "updated_at": "2026-10-22T12:00:00Z",
    }
    assert seen == [("/v1/asr/credits", "Bearer device-token", "application/json")]


def test_missing_config_reports_readable_reason_without_network() -> None:
    missing_url = Harness({"asr.api_key": "device-token"}).credits()
    assert missing_url["available"] is False
    assert "未配置" in missing_url["reason"]
    missing_token = Harness({"asr.base_url": "http://127.0.0.1:9/v1"}).credits()
    assert missing_token["available"] is False
    assert "设备令牌" in missing_token["reason"]
    for result in (missing_url, missing_token):
        assert result["limit"] == 0.0
        assert result["remaining"] == 0.0


def test_invalid_token_is_a_readable_state_not_an_rpc_error() -> None:
    with _gateway(status=401) as (base_url, _seen):
        result = Harness({"asr.base_url": base_url, "asr.api_key": "stale"}).credits()
    assert result["available"] is False
    assert "重新激活" in result["reason"]
    assert "stale" not in json.dumps(result, ensure_ascii=False)
    assert base_url not in json.dumps(result, ensure_ascii=False)


def test_forbidden_and_server_errors_stay_readable() -> None:
    with _gateway(status=403) as (base_url, _seen):
        forbidden = Harness({"asr.base_url": base_url, "asr.api_key": "t"}).credits()
    with _gateway(status=502) as (base_url, _seen):
        broken = Harness({"asr.base_url": base_url, "asr.api_key": "t"}).credits()
    assert forbidden["available"] is False
    assert "未授权" in forbidden["reason"]
    assert broken["available"] is False
    assert "HTTP 502" in broken["reason"]


def test_malformed_payload_degrades_to_unavailable() -> None:
    with _gateway(raw=b"not-json") as (base_url, _seen):
        invalid_json = Harness({"asr.base_url": base_url, "asr.api_key": "t"}).credits()
    with _gateway(body={"limit": 1}) as (base_url, _seen):
        missing_fields = Harness({"asr.base_url": base_url, "asr.api_key": "t"}).credits()
    assert invalid_json["available"] is False
    assert "无法解析" in invalid_json["reason"]
    assert missing_fields["available"] is False
    assert "无法解析" in missing_fields["reason"]


def test_unreachable_gateway_degrades_to_network_reason() -> None:
    result = Harness({"asr.base_url": _closed_port_url(), "asr.api_key": "t"}).credits()
    assert result["available"] is False
    assert "网络" in result["reason"]


def test_method_is_registered_once_under_the_protocol_name() -> None:
    harness = Harness({})
    assert harness.router.method_names == ("asr.credits",)
