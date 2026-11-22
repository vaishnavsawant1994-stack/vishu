"""Local VISHU API. Requires a session token provided by the desktop host."""

from __future__ import annotations

import os
import secrets
import threading
import base64
import binascii
import io
import json
from functools import lru_cache
from pathlib import Path
from typing import Callable

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from llm import ModelUnavailable, complete_chat, complete_vision
from store import ConversationStore


@lru_cache(maxsize=2)
def load_vosk_model(model_path: str):
    from vosk import Model
    return Model(model_path)


class ConversationCreate(BaseModel):
    title: str = Field(default="New conversation", min_length=1, max_length=120)


class ChatRequest(BaseModel):
    text: str = Field(min_length=1, max_length=110000)
    conversation_id: str | None = None


class AudioRequest(BaseModel):
    audio_wav_base64: str = Field(min_length=1, max_length=28_000_000)


class ScreenRequest(BaseModel):
    image_data_url: str = Field(min_length=1, max_length=8_000_000)
    question: str = Field(default="Describe what is visible on my screen.", min_length=1, max_length=2000)


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
    vosk_model_path = os.environ.get("VISHU_VOSK_MODEL_PATH", "").strip()
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

    @app.post("/api/transcribe", dependencies=[Depends(authorize)])
    def transcribe(payload: AudioRequest):
        if not vosk_model_path or not Path(vosk_model_path).is_dir():
            raise HTTPException(status_code=503, detail="Offline speech recognition is unavailable. Install a Vosk model and set VISHU_VOSK_MODEL_PATH.")
        try:
            audio = base64.b64decode(payload.audio_wav_base64, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise HTTPException(status_code=422, detail="Audio payload is invalid base64.") from exc
        if len(audio) > 20_000_000 or not audio.startswith(b"RIFF") or audio[8:12] != b"WAVE":
            raise HTTPException(status_code=422, detail="Audio must be a WAV recording under 20 MB.")
        try:
            from vosk import KaldiRecognizer
            import wave
            with wave.open(io.BytesIO(audio), "rb") as wav:
                if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or wav.getframerate() not in (16000, 22050, 44100, 48000):
                    raise HTTPException(status_code=422, detail="Audio must be mono 16-bit PCM at a supported sample rate.")
                recognizer = KaldiRecognizer(load_vosk_model(vosk_model_path), wav.getframerate())
                recognizer.SetWords(False)
                while chunk := wav.readframes(4000):
                    recognizer.AcceptWaveform(chunk)
                result = json.loads(recognizer.FinalResult())
        except HTTPException:
            raise
        except ImportError as exc:
            raise HTTPException(status_code=503, detail="Vosk is not installed in this VISHU build.") from exc
        except Exception as exc:
            raise HTTPException(status_code=503, detail="Offline transcription failed. Check the Vosk model and WAV recording.") from exc
        text = result.get("text", "")
        if not isinstance(text, str) or not text.strip():
            raise HTTPException(status_code=422, detail="No speech was recognized.")
        return {"text": text.strip()}

    @app.post("/api/screen", dependencies=[Depends(authorize)])
    def understand_screen(payload: ScreenRequest):
        if not payload.question.strip():
            raise HTTPException(status_code=422, detail="Screen question cannot be empty.")
        if not payload.image_data_url.startswith("data:image/png;base64,"):
            raise HTTPException(status_code=422, detail="Screen image must be a PNG data URL.")
        try:
            image = base64.b64decode(payload.image_data_url.split(",", 1)[1], validate=True)
        except (binascii.Error, ValueError) as exc:
            raise HTTPException(status_code=422, detail="Screen image is invalid.") from exc
        if len(image) > 5_000_000 or not image.startswith(b"\x89PNG\r\n\x1a\n"):
            raise HTTPException(status_code=422, detail="Screen image must be a PNG under 5 MB.")
        try:
            answer = complete_vision(payload.question.strip(), payload.image_data_url, model_name)
        except ModelUnavailable as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        return {"answer": answer}

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
