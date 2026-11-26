"""End-to-end contract smoke for the *frozen* Windows Python backend.

This test runs a packaged VISHUBackend.exe with a disposable database and a
local OpenAI-compatible test server. It exercises the actual executable, HTTP
API, streaming, vision transport, authorization and SQLite storage. It does
NOT claim physical microphone, screen capture, or Electron GUI acceptance.
"""

from __future__ import annotations

import base64
import contextlib
import io
import json
import os
import secrets
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXECUTABLE = ROOT / "release" / "phase2-backend-final" / "VISHUBackend" / "VISHUBackend.exe"
VOSK_MODEL = ROOT / "release" / "phase2-vosk-model"
TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WJACPYAAAAASUVORK5CYII="


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


class FakeModel(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/v1/chat/completions":
            self.send_error(404)
            return
        size = int(self.headers.get("Content-Length", "0"))
        request = json.loads(self.rfile.read(size))
        messages = request["messages"]
        latest = messages[-1]["content"]
        if isinstance(latest, str) and latest == "fail-now":
            self.send_error(503)
            return
        if request.get("stream"):
            text = "".join(
                "data: " + json.dumps({"choices": [{"delta": {"content": chunk}}]}) + "\n\n"
                for chunk in ("The ", "model responds.")
            ) + "data: [DONE]\n\n"
            body = text.encode()
            content_type = "text/event-stream"
        else:
            response_text = "Vision request accepted." if isinstance(latest, list) else "Real HTTP round-trip."
            body = json.dumps(
                {"choices": [{"message": {"role": "assistant", "content": response_text}}]}
            ).encode()
            content_type = "application/json"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


def http_request(port: int, token: str | None, route: str, payload=None, method="GET"):
    headers = {}
    if token:
        headers["Authorization"] = "Bearer " + token
    if payload is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(
        "http://127.0.0.1:" + str(port) + route,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, response.read().decode()
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode()


def assert_status(port, token, route, payload=None, method="GET", expected=200):
    status, body = http_request(port, token, route, payload, method)
    assert status == expected, f"{route}: HTTP {status}, expected {expected}, body={body[:500]}"
    return json.loads(body) if body and not body.startswith("data:") else body


def make_silence() -> str:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as recording:
        recording.setnchannels(1)
        recording.setsampwidth(2)
        recording.setframerate(16000)
        recording.writeframes(b"\x00\x00" * 16000)
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def main():
    assert os.name == "nt", "This smoke requires Windows."
    assert EXECUTABLE.is_file(), f"Missing frozen backend: {EXECUTABLE}"
    assert VOSK_MODEL.is_dir(), f"Missing bundled Vosk model: {VOSK_MODEL}"

    with tempfile.TemporaryDirectory(prefix="vishu-packaged-smoke-") as temp:
        root = Path(temp)
        db = root / "smoke.sqlite3"
        log_file = root / "backend.log"
        token = secrets.token_hex(32)
        model = ThreadingHTTPServer(("127.0.0.1", 0), FakeModel)
        model_thread = threading.Thread(target=model.serve_forever, daemon=True)
        model_thread.start()
        port = free_port()
        env = os.environ.copy()
        env.update({
            "VISHU_API_TOKEN": token,
            "VISHU_DB_PATH": str(db),
            "VISHU_VOSK_MODEL_PATH": str(VOSK_MODEL),
            "VISHU_LLM_BASE_URL": "http://127.0.0.1:" + str(model.server_port) + "/v1",
            "VISHU_MODEL": "smoke-model",
            "VISHU_VISION_MODEL": "smoke-vision"
        })
        try:
            with open(log_file, "wb") as log:
                backend = subprocess.Popen(
                    [str(EXECUTABLE), "--port", str(port)],
                    cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT
                )
                try:
                    deadline = time.monotonic() + 90
                    while time.monotonic() < deadline:
                        if backend.poll() is not None:
                            raise AssertionError("Frozen backend exited: " + log_file.read_text(errors="replace")[-3000:])
                        try:
                            result = assert_status(port, None, "/api/health")
                            if result["status"] == "ok":
                                break
                        except (ConnectionError, TimeoutError, urllib.error.URLError, AssertionError):
                            time.sleep(.3)
                    else:
                        raise AssertionError("Frozen backend did not start: " + log_file.read_text(errors="replace")[-3000:])

                    assert_status(port, None, "/api/conversations", expected=401)
                    response = assert_status(
                        port, token, "/api/chat", {"text": "First turn"},
                        method="POST"
                    )
                    assert response["assistant"] == "Real HTTP round-trip."
                    conversation_id = response["conversation_id"]

                    events = assert_status(
                        port, token, "/api/chat/stream",
                        {"text": "Second turn", "conversation_id": conversation_id},
                        method="POST"
                    )
                    frames = [
                        json.loads(line[6:])
                        for line in events.splitlines()
                        if line.startswith("data: ")
                    ]
                    assert frames[-1]["type"] == "done", frames
                    assert "".join(e.get("text", "") for e in frames if e["type"] == "delta") == "The model responds."
                    assert frames[-1]["conversation_id"] == conversation_id

                    vision = assert_status(
                        port, token, "/api/screen",
                        {"question": "Describe this selected image", "image_data_url": TINY_PNG},
                        method="POST"
                    )
                    assert vision["answer"] == "Vision request accepted."

                    assert_status(port, token, "/api/chat",
                                  {"text": "fail-now", "conversation_id": conversation_id},
                                  method="POST", expected=503)
                    transcript = assert_status(port, token, "/api/transcribe",
                                               {"audio_wav_base64": make_silence()},
                                               method="POST", expected=422)
                    assert "No speech was recognized" in transcript.get("detail", "")

                    rows = assert_status(
                        port, token, "/api/conversations/" + conversation_id + "/messages"
                    )
                    assert len(rows) == 4, rows
                    assert [entry["role"] for entry in rows] == [
                        "user", "assistant", "user", "assistant"
                    ]
                finally:
                    # Kill the frozen executable and any children on Windows.
                    # The onedir distribution avoids the separate onefile bootloader.
                    subprocess.run(
                        ["taskkill", "/PID", str(backend.pid), "/T", "/F"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                        timeout=15, check=False,
                    )
                    try:
                        backend.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        backend.kill()
                        backend.wait(timeout=5)
                    time.sleep(0.3)
            with sqlite3.connect(db) as connection:
                count = connection.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
                assert count == 4, f"Unexpected persisted count: {count}"
                all_text = " ".join(row[0] for row in connection.execute("SELECT content FROM messages"))
                assert "data:image" not in all_text, "Screen data must not be stored as messages."
            print("PASS: frozen backend HTTP, auth, real SSE transport, vision, silent Vosk, SQLite (4 messages)")
        except Exception:
            if log_file.exists():
                print("Backend log tail:\n" + log_file.read_text(errors="replace")[-3000:])
            raise
        finally:
            model.shutdown()
            model.server_close()
            model_thread.join(timeout=3)


if __name__ == "__main__":
    main()
