from __future__ import annotations

import pytest
import base64
import io
import json
import sys
import types
import wave
from fastapi.testclient import TestClient

from app import create_app
from llm import ModelUnavailable
import app as app_module


@pytest.fixture
def client(tmp_path):
    calls = []

    def provider(messages, model):
        calls.append((messages, model))
        return "Real provider response from injected test double."

    app = create_app(
        database_path=tmp_path / "test.sqlite3",
        token="test-token",
        provider=provider,
    )
    with TestClient(app) as instance:
        yield instance, calls


def headers():
    return {"Authorization": "Bearer test-token"}


def test_health_is_non_sensitive(client):
    api, _ = client
    response = api.get("/api/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_authentication_required(client):
    api, _ = client
    assert api.get("/api/conversations").status_code == 401
    assert api.get("/api/conversations", headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert api.post("/api/chat", json={"text": "hello"}).status_code == 401
    assert api.post("/api/chat/stream", json={"text": "hello"}).status_code == 401


def test_conversation_round_trip_and_context(client):
    api, calls = client
    first = api.post("/api/chat", json={"text": "Hello VISHU"}, headers=headers())
    assert first.status_code == 200
    conversation_id = first.json()["conversation_id"]
    assert first.json()["assistant"].startswith("Real provider response")
    rows = api.get("/api/conversations", headers=headers()).json()
    assert rows[0]["id"] == conversation_id
    messages = api.get(
        "/api/conversations/" + conversation_id + "/messages", headers=headers()
    ).json()
    assert [entry["role"] for entry in messages] == ["user", "assistant"]
    second = api.post(
        "/api/chat",
        json={"text": "What did I say?", "conversation_id": conversation_id},
        headers=headers(),
    )
    assert second.status_code == 200
    assert len(calls) == 2
    assert len(calls[1][0]) == 3
    assert calls[1][0][0]["content"] == "Hello VISHU"


def test_can_create_and_delete_conversation(client):
    api, _ = client
    response = api.post("/api/conversations", json={"title": "Ideas"}, headers=headers())
    assert response.status_code == 201
    key = response.json()["id"]
    assert api.delete("/api/conversations/" + key, headers=headers()).json() == {"deleted": True}
    assert api.get("/api/conversations/" + key + "/messages", headers=headers()).status_code == 404


def test_missing_conversation_does_not_call_model(client):
    api, calls = client
    response = api.post(
        "/api/chat",
        json={"text": "Hello", "conversation_id": "nonexistent"},
        headers=headers(),
    )
    assert response.status_code == 404
    assert calls == []


def test_empty_text_rejected(client):
    api, _ = client
    assert api.post("/api/chat", json={"text": "   "}, headers=headers()).status_code == 422


def test_model_failure_does_not_save_fabricated_response(tmp_path):
    def offline(_messages, _model):
        raise ModelUnavailable("Model offline.")

    api = TestClient(create_app(database_path=tmp_path / "failure.db", token="t", provider=offline))
    response = api.post(
        "/api/chat",
        json={"text": "Hello"},
        headers={"Authorization": "Bearer t"},
    )
    assert response.status_code == 503
    assert api.get("/api/conversations", headers={"Authorization": "Bearer t"}).json() == []


def test_empty_model_response_rejected(tmp_path):
    api = TestClient(
        create_app(database_path=tmp_path / "empty.db", token="t", provider=lambda _m, _n: "")
    )
    result = api.post("/api/chat", json={"text": "Hi"}, headers={"Authorization": "Bearer t"})
    assert result.status_code == 502


def test_streamed_chat_emits_tokens_and_persists_only_complete_turn(tmp_path):
    async def streamed(_messages, _model):
        yield "Hello "
        yield "from a live stream."

    api = TestClient(create_app(
        database_path=tmp_path / "stream.db",
        token="stream-token",
        provider=lambda _messages, _model: "Synchronous follow-up.",
        stream_provider=streamed,
    ))
    response = api.post("/api/chat/stream", json={"text": "Say hello"}, headers={
        "Authorization": "Bearer stream-token",
    })
    assert response.status_code == 200
    events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
    assert [event["text"] for event in events if event["type"] == "delta"] == ["Hello ", "from a live stream."]
    conversation_id = events[-1]["conversation_id"]
    messages = api.get(
        "/api/conversations/" + conversation_id + "/messages",
        headers={"Authorization": "Bearer stream-token"},
    ).json()
    assert [(message["role"], message["content"]) for message in messages] == [
        ("user", "Say hello"),
        ("assistant", "Hello from a live stream."),
    ]
    follow_up = api.post(
        "/api/chat",
        json={"text": "Are you ready?", "conversation_id": conversation_id},
        headers={"Authorization": "Bearer stream-token"},
    )
    assert follow_up.status_code == 200


def test_stream_failure_does_not_create_conversation_or_fabricate_reply(tmp_path):
    async def unavailable(_messages, _model):
        raise ModelUnavailable("Model offline.")
        yield "unreachable"

    api = TestClient(create_app(
        database_path=tmp_path / "stream-failure.db",
        token="stream-token",
        provider=lambda _messages, _model: "Synchronous response.",
        stream_provider=unavailable,
    ))
    response = api.post("/api/chat/stream", json={"text": "Say hello"}, headers={
        "Authorization": "Bearer stream-token",
    })
    assert response.status_code == 200
    events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
    assert events == [{"type": "error", "message": "Model offline."}]
    assert api.get("/api/conversations", headers={
        "Authorization": "Bearer stream-token",
    }).json() == []
    assert api.post("/api/chat", json={"text": "I can retry"}, headers={
        "Authorization": "Bearer stream-token",
    }).status_code == 200


def test_transcription_requires_model_configuration(client):
    api, _ = client
    response = api.post("/api/transcribe", json={"audio_wav_base64": "UklGRg=="}, headers=headers())
    assert response.status_code == 503
    assert "VISHU_VOSK_MODEL_PATH" in response.json()["detail"]


def test_transcription_validates_and_returns_recognized_text(monkeypatch, tmp_path):
    model_dir = tmp_path / "model"
    model_dir.mkdir()
    monkeypatch.setenv("VISHU_VOSK_MODEL_PATH", str(model_dir))

    class Recognizer:
        def __init__(self, *_args): pass
        def SetWords(self, _enabled): pass
        def AcceptWaveform(self, _chunk): pass
        def FinalResult(self): return '{"text":"hello vishu"}'

    monkeypatch.setitem(sys.modules, "vosk", types.SimpleNamespace(KaldiRecognizer=Recognizer, Model=lambda _path: object()))
    stream = io.BytesIO()
    with wave.open(stream, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(b"\0\0" * 160)
    audio = base64.b64encode(stream.getvalue()).decode("ascii")
    with TestClient(create_app(database_path=tmp_path / "voice.db", token="test-token")) as api:
        response = api.post("/api/transcribe", json={"audio_wav_base64": audio}, headers=headers())
        assert response.status_code == 200
        assert response.json() == {"text": "hello vishu"}
        assert api.post("/api/transcribe", json={"audio_wav_base64": "YmFk"}, headers=headers()).status_code == 422


def test_screen_capture_requires_auth(client):
    api, _ = client
    result = api.post("/api/screen", json={"image_data_url": "data:image/png;base64,AA=="})
    assert result.status_code == 401


def test_screen_capture_validates_png_and_uses_real_vision(monkeypatch, client):
    api, _ = client
    calls = []
    monkeypatch.setattr(app_module, "complete_vision", lambda question, image, model: calls.append((question, image, model)) or "A real vision result")
    png = "data:image/png;base64," + "iVBORw0KGgo="
    result = api.post("/api/screen", json={"image_data_url": png, "question": "Read the heading"}, headers=headers())
    assert result.status_code == 200
    assert result.json()["answer"] == "A real vision result"
    assert calls[0][0] == "Read the heading"
    assert api.post("/api/screen", json={"image_data_url": "data:image/png;base64,AA=="}, headers=headers()).status_code == 422


def test_screen_vision_failure_is_reported(monkeypatch, client):
    api, _ = client
    def fail(*_args):
        raise ModelUnavailable("Vision not supported.")
    monkeypatch.setattr(app_module, "complete_vision", fail)
    result = api.post("/api/screen", json={"image_data_url": "data:image/png;base64,iVBORw0KGgo="}, headers=headers())
    assert result.status_code == 503
    assert result.json()["detail"] == "Vision not supported."
