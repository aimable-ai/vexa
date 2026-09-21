"""default_avatar_url on POST /bots reaches the bot as invocation.v1 defaultAvatarUrl (AIM-2050).

OFFLINE — the shipped `request_bot` over the in-memory fakes, plus the router's validator.
"""
from __future__ import annotations

import json
import os
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from meeting_api.bot_spawn import request_bot
from meeting_api.bot_spawn.fakes import FakeRuntimeClient, InMemoryMeetingRepo
from meeting_api.bot_spawn.router import _validated_avatar_url

KW = dict(redis_url="r", token_secret="test-admin-token", meeting_api_url="http://meeting-api:8080")
ENV = {"TRANSCRIPTION_SERVICE_URL": "http://env-whisper:8083", "TRANSCRIPTION_SERVICE_TOKEN": "env-token"}
LOGO = "https://aimable.ai/assets/aimable-logo.svg"


def _invocation(runtime: FakeRuntimeClient) -> dict:
    return json.loads(runtime.specs[-1]["env"]["VEXA_BOT_CONFIG"])


async def _spawn(**overrides) -> dict:
    repo, runtime = InMemoryMeetingRepo(), FakeRuntimeClient()
    with patch.dict(os.environ, ENV):
        await request_bot(
            repo, runtime, user_id=7, platform="google_meet", native_meeting_id="abc-defg-hij",
            **overrides, **KW,
        )
    return _invocation(runtime)


async def test_avatar_lands_in_invocation():
    assert (await _spawn(default_avatar_url=LOGO))["defaultAvatarUrl"] == LOGO


async def test_no_avatar_omitted_from_invocation():
    assert "defaultAvatarUrl" not in await _spawn()


def test_validator_accepts_http_urls_and_blank():
    assert _validated_avatar_url(LOGO) == LOGO
    assert _validated_avatar_url(None) is None
    assert _validated_avatar_url("") is None


@pytest.mark.parametrize("bad", ["javascript:alert(1)", "file:///etc/passwd", "data:image/png;base64,AA", "https://x/" + "a" * 2100])
def test_validator_rejects_non_http_or_too_long(bad):
    with pytest.raises(HTTPException) as e:
        _validated_avatar_url(bad)
    assert e.value.status_code == 422
