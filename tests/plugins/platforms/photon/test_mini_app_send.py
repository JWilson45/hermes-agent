"""Mini-app card send tests for PhotonAdapter.send_mini_app.

The sidecar owns the mini-app safety model (env gate, config-file allowlist,
https-prefix URL policy, rate limit — covered by the sidecar's node tests).
The adapter's job is thin wiring: POST /send-mini-app with {spaceId, url} and
surface the outcome as a SendResult, carrying the sidecar's retryability so
_send_with_retry treats policy/send failures as permanent.
"""
from __future__ import annotations

from typing import Any

import pytest

from gateway.config import PlatformConfig
from plugins.platforms.photon import adapter as photon_adapter
from plugins.platforms.photon.adapter import PhotonAdapter

# Synthetic fixture ids, built by concatenation (never a real recipient).
_PHONE = "+1555" + "1234567"
_SPACE = "any;-;" + _PHONE
_URL = "https://mini-app.example.ts.net:18443/app"


def _make_adapter(monkeypatch: pytest.MonkeyPatch) -> PhotonAdapter:
    monkeypatch.setenv("PHOTON_PROJECT_ID", "test-project-id")
    monkeypatch.setenv("PHOTON_PROJECT_SECRET", "test-project-secret")
    cfg = PlatformConfig(enabled=True, token="", extra={})
    return PhotonAdapter(cfg)


def _capture_sidecar(adapter: PhotonAdapter) -> list[tuple[str, dict[str, Any]]]:
    calls: list[tuple[str, dict[str, Any]]] = []

    async def _fake_call(path: str, body: dict[str, Any]) -> dict[str, Any]:
        calls.append((path, body))
        return {"ok": True, "messageId": "msg-mini-1"}

    adapter._sidecar_call = _fake_call  # type: ignore[assignment]
    return calls


@pytest.mark.asyncio
async def test_send_mini_app_posts_space_and_url(monkeypatch: pytest.MonkeyPatch) -> None:
    adapter = _make_adapter(monkeypatch)
    calls = _capture_sidecar(adapter)

    result = await adapter.send_mini_app(_SPACE, _URL)

    assert result.success is True
    assert result.message_id == "msg-mini-1"
    assert calls == [("/send-mini-app", {"spaceId": _SPACE, "url": _URL})]


@pytest.mark.asyncio
async def test_send_mini_app_policy_failure_is_permanent(monkeypatch: pytest.MonkeyPatch) -> None:
    adapter = _make_adapter(monkeypatch)

    async def _deny(path: str, body: dict[str, Any]) -> dict[str, Any]:
        raise photon_adapter.PhotonSidecarError(
            path=path, status_code=400, error="unapproved mini-app target", retryable=False
        )

    adapter._sidecar_call = _deny  # type: ignore[assignment]

    result = await adapter.send_mini_app(_SPACE, _URL)

    assert result.success is False
    assert result.retryable is False
    assert "unapproved mini-app target" in (result.error or "")


@pytest.mark.asyncio
async def test_send_mini_app_disabled_gate_surfaces_error(monkeypatch: pytest.MonkeyPatch) -> None:
    adapter = _make_adapter(monkeypatch)

    async def _disabled(path: str, body: dict[str, Any]) -> dict[str, Any]:
        raise photon_adapter.PhotonSidecarError(
            path=path, status_code=400, error="mini-app cards are disabled", retryable=False
        )

    adapter._sidecar_call = _disabled  # type: ignore[assignment]

    result = await adapter.send_mini_app(_SPACE, _URL)

    assert result.success is False
    assert "disabled" in (result.error or "")