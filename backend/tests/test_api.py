from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import create_app
from llm import ModelUnavailable


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
