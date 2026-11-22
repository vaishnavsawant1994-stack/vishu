"""Contract tests for real HTTP model transport without external network access."""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from llm import ModelUnavailable, complete_chat, complete_vision


def test_openai_compatible_transport(monkeypatch):
    observed = {}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            observed["path"] = self.path
            size = int(self.headers["Content-Length"])
            observed["payload"] = json.loads(self.rfile.read(size))
            observed["authorization"] = self.headers.get("Authorization")
            body = json.dumps(
                {"choices": [{"message": {"content": "Hello from local model."}}]}
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        monkeypatch.setenv(
            "VISHU_LLM_BASE_URL", "http://127.0.0.1:" + str(server.server_port) + "/v1"
        )
        monkeypatch.setenv("VISHU_LLM_API_KEY", "provider-test-secret")
        result = complete_chat([{"role": "user", "content": "hello"}], "model-test")
        assert result == "Hello from local model."
        assert observed["path"] == "/v1/chat/completions"
        assert observed["payload"]["model"] == "model-test"
        assert observed["payload"]["messages"][-1] == {
            "role": "user", "content": "hello"
        }
        assert observed["authorization"] == "Bearer provider-test-secret"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)


def test_unreachable_provider_is_an_error(monkeypatch):
    monkeypatch.setenv("VISHU_LLM_BASE_URL", "http://127.0.0.1:1/v1")
    monkeypatch.delenv("VISHU_LLM_API_KEY", raising=False)
    with pytest.raises(ModelUnavailable, match="AI model request failed"):
        complete_chat([{"role": "user", "content": "hello"}], "model-test")


def test_vision_transport_sends_user_selected_image(monkeypatch):
    observed = {}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            observed["path"] = self.path
            observed["payload"] = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            body = json.dumps({"choices": [{"message": {"content": "A blue window."}}]}).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        monkeypatch.setenv("VISHU_LLM_BASE_URL", "http://127.0.0.1:" + str(server.server_port) + "/v1")
        image = "data:image/png;base64,iVBORw0KGgo="
        result = complete_vision("What is visible?", image, "vision-model")
        assert result == "A blue window."
        assert observed["path"] == "/v1/chat/completions"
        assert observed["payload"]["messages"][1]["content"][1]["image_url"]["url"] == image
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)
