"""Real OpenAI-compatible chat completion transport; no fake responses."""

from __future__ import annotations

import json
import os
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


SYSTEM_PROMPT = (
    "You are VISHU, a helpful personal AI assistant. Be accurate, concise "
    "and honest about your capabilities. Never claim to have completed "
    "computer operations unless tool execution evidence exists. "
    "You currently have no computer-control tools enabled."
)


class ModelUnavailable(Exception):
    """The configured model server is unreachable or returned an invalid response."""


def complete_chat(messages: list[dict], model: str) -> str:
    base_url = os.environ.get(
        "VISHU_LLM_BASE_URL", "http://127.0.0.1:11434/v1"
    ).rstrip("/")
    api_key = os.environ.get("VISHU_LLM_API_KEY", "").strip()
    payload = {
        "model": model,
        "messages": [{"role": "system", "content": SYSTEM_PROMPT}, *messages],
        "stream": False,
    }
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = "Bearer " + api_key
    request = Request(
        base_url + "/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urlopen(request, timeout=75) as response:
            data = json.load(response)
        answer = data["choices"][0]["message"]["content"]
        if not isinstance(answer, str) or not answer.strip():
            raise ModelUnavailable("Model returned an empty response.")
        return answer.strip()
    except (HTTPError, URLError, TimeoutError, OSError, ValueError, KeyError, IndexError, TypeError) as exc:
        raise ModelUnavailable(
            "AI model request failed. Verify the configured local model server "
            "is running and that the selected model is installed."
        ) from exc
