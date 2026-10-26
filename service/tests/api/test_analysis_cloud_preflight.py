"""云端识别前置检查：只拦配置缺失/积分明确耗尽，不拿网络抖动挡分析。"""

from types import SimpleNamespace

import pytest

from dramaclip.api import asr as asr_api
from dramaclip.api import analysis
from dramaclip.transport.rpc import RpcDomainError


def _ctx(settings: dict) -> SimpleNamespace:
    return SimpleNamespace(settings=settings)


def _cloud_settings(**overrides: str) -> dict:
    settings = {
        "asr.engine": "cloud_gateway",
        "asr.base_url": "https://gateway.test/v1",
        "asr.api_key": "device-token",
    }
    settings.update(overrides)
    return settings


def test_local_engine_skips_credit_check(monkeypatch: pytest.MonkeyPatch) -> None:
    called = []
    monkeypatch.setattr(asr_api, "credits", lambda _ctx: called.append(1) or {})
    analysis._require_cloud_asr_ready(_ctx({"asr.engine": "faster_whisper"}))
    assert called == []


@pytest.mark.parametrize("missing", ["asr.base_url", "asr.api_key"])
def test_cloud_missing_config_rejected(missing: str) -> None:
    settings = _cloud_settings()
    settings[missing] = ""
    with pytest.raises(RpcDomainError) as exc:
        analysis._require_cloud_asr_ready(_ctx(settings))
    assert exc.value.code == -32205
    assert "云端识别未就绪" in exc.value.message


def test_cloud_zero_remaining_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        asr_api,
        "credits",
        lambda _ctx: {"available": True, "remaining": 0.0, "limit": 10.0, "used": 10.0},
    )
    with pytest.raises(RpcDomainError) as exc:
        analysis._require_cloud_asr_ready(_ctx(_cloud_settings()))
    assert exc.value.code == -32205
    assert "积分不足" in exc.value.message


def test_cloud_positive_remaining_allowed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        asr_api,
        "credits",
        lambda _ctx: {"available": True, "remaining": 1.0, "limit": 10.0, "used": 9.0},
    )
    analysis._require_cloud_asr_ready(_ctx(_cloud_settings()))


def test_credit_query_failure_does_not_block(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(_ctx):
        raise RuntimeError("network down")

    monkeypatch.setattr(asr_api, "credits", boom)
    analysis._require_cloud_asr_ready(_ctx(_cloud_settings()))


def test_unavailable_payload_does_not_block(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        asr_api,
        "credits",
        lambda _ctx: {"available": False, "remaining": 0.0, "reason": "401"},
    )
    analysis._require_cloud_asr_ready(_ctx(_cloud_settings()))
