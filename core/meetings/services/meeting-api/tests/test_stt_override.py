"""Per-request STT backend override (AIM-1507/AIM-1377 open-body fields).

Asserts:
  * the override URL/token/model land in the spawned invocation (VEXA_BOT_CONFIG);
  * WHOLESALE replacement — an override URL with no token never inherits the
    deployment's env token (the "never mix" rule);
  * no override → the env backend resolves exactly as before (regression guard).

OFFLINE — the shipped `request_bot` over the in-memory fakes (no DB, no kernel).
"""
from __future__ import annotations

import json
import os
from unittest.mock import patch

from meeting_api.bot_spawn import request_bot
from meeting_api.bot_spawn.fakes import FakeRuntimeClient, InMemoryMeetingRepo

SECRET = "test-admin-token"
KW = dict(redis_url="r", token_secret=SECRET, meeting_api_url="http://meeting-api:8080")
ENV = {
    "TRANSCRIPTION_SERVICE_URL": "http://env-whisper:8083",
    "TRANSCRIPTION_SERVICE_TOKEN": "env-token",
}


def _invocation(runtime: FakeRuntimeClient) -> dict:
    env = runtime.specs[-1]["env"]
    return json.loads(env["VEXA_BOT_CONFIG"])


async def _spawn(repo, runtime, **overrides):
    return await request_bot(
        repo, runtime, user_id=7, platform="teams", native_meeting_id="stt-ovr-1",
        **overrides, **KW,
    )


async def test_override_lands_in_invocation():
    repo, runtime = InMemoryMeetingRepo(), FakeRuntimeClient()
    with patch.dict(os.environ, ENV):
        await _spawn(
            repo, runtime,
            transcription_service_url_override="ws://voxtral:8085/v1/realtime",
            transcription_service_token_override="space-token",
            transcription_model_override="voxtral-mini",
        )
    inv = _invocation(runtime)
    assert inv["transcriptionServiceUrl"] == "ws://voxtral:8085/v1/realtime"
    assert inv["transcriptionServiceToken"] == "space-token"
    assert inv["transcriptionModel"] == "voxtral-mini"


async def test_override_never_inherits_env_token():
    repo, runtime = InMemoryMeetingRepo(), FakeRuntimeClient()
    with patch.dict(os.environ, ENV):
        await _spawn(
            repo, runtime,
            transcription_service_url_override="wss://api.reson8.dev/v1/speech-to-text/realtime",
        )
    inv = _invocation(runtime)
    assert inv["transcriptionServiceUrl"] == "wss://api.reson8.dev/v1/speech-to-text/realtime"
    assert inv.get("transcriptionServiceToken") in (None, ""), "env token must not leak to an override endpoint"


async def test_no_override_keeps_env_resolution():
    repo, runtime = InMemoryMeetingRepo(), FakeRuntimeClient()
    with patch.dict(os.environ, ENV):
        await _spawn(repo, runtime)
    inv = _invocation(runtime)
    assert inv["transcriptionServiceUrl"] == "http://env-whisper:8083"
    assert inv["transcriptionServiceToken"] == "env-token"
