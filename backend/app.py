"""Local VISHU API. Requires a session token provided by the desktop host."""

from __future__ import annotations

import os
import secrets
import threading
from pathlib import Path
from typing import Callable

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from llm import ModelUnavailable, complete_chat
from store import ConversationStore


class ConversationCreate(BaseModel):
    title: str = Field(default="New conversation", min_length=1, max_length=120)


class ChatRequest(BaseModel):
    text: str = Field(min_length=1, max_length=10000)
    conversation_id: str | None = None


def create_app(
    *,
    database_path: str | Path | None = None,
    token: str | None = None,
    provider: Callable[[list[dict], str], str] | None = None,
) -> FastAPI:
    session_token = token if token is not None else os.environ.get("VISHU_API_TOKEN", "")
    if not session_token:
        raise RuntimeError("VISHU_API_TOKEN is required; refusing to start an unprotected API.")
    db = database_path or os.environ.get(
        "VISHU_DB_PATH", str(Path.home() / ".vishu" / "vishu.sqlite3")
    )
    store = ConversationStore(db)
    model_name = os.environ.get("VISHU_MODEL", "qwen2.5:3b")
    complete = provider if provider is not None else complete_chat
    chat_lock = threading.Lock()

    app = FastAPI(
        title="VISHU Local API", docs_url=None, redoc_url=None, openapi_url=None
    )

    def authorize(authorization: str | None = Header(default=None)) -> None:
        expected = "Bearer " + session_token
        if not authorization or not secrets.compare_digest(authorization, expected):
            raise HTTPException(status_code=401, detail="Unauthorized")

    @app.get("/api/health")
    def health():
        return {"status": "ok", "service": "vishu-api", "configured_model": model_name}

    @app.get("/api/conversations", dependencies=[Depends(authorize)])
    def conversations():
        return store.list_conversations()

    @app.post("/api/conversations", dependencies=[Depends(authorize)], status_code=201)
    def create_conversation(payload: ConversationCreate):
        if not payload.title.strip():
            raise HTTPException(status_code=422, detail="Title cannot be empty.")
        return store.create_conversation(payload.title.strip())

    @app.get("/api/conversations/{conversation_id}/messages", dependencies=[Depends(authorize)])
    def messages(conversation_id: str):
        if not store.get_conversation(conversation_id):
            raise HTTPException(status_code=404, detail="Conversation not found.")
        return store.list_messages(conversation_id)

    @app.delete("/api/conversations/{conversation_id}", dependencies=[Depends(authorize)])
    def delete_conversation(conversation_id: str):
        if not store.delete_conversation(conversation_id):
            raise HTTPException(status_code=404, detail="Conversation not found.")
        return {"deleted": True}

    @app.post("/api/chat", dependencies=[Depends(authorize)])
    def chat(payload: ChatRequest):
        text = payload.text.strip()
        if not text:
            raise HTTPException(status_code=422, detail="Message cannot be empty.")
        with chat_lock:
            if payload.conversation_id:
                existing = store.get_conversation(payload.conversation_id)
                if not existing:
                    raise HTTPException(status_code=404, detail="Conversation not found.")
                history = store.model_history(payload.conversation_id)
            else:
                history = []
            try:
                assistant = complete([*history, {"role": "user", "content": text}], model_name)
            except ModelUnavailable as exc:
                raise HTTPException(status_code=503, detail=str(exc)) from exc
            if not assistant or not assistant.strip():
                raise HTTPException(status_code=502, detail="Model returned no text.")
            if payload.conversation_id:
                conversation_id = payload.conversation_id
            else:
                conversation = store.create_conversation(text[:60])
                conversation_id = conversation["id"]
            store.append_exchange(conversation_id, text, assistant.strip())
            return {
                "conversation_id": conversation_id,
                "assistant": assistant.strip(),
                "model": model_name,
            }

    return app


app = create_app()
