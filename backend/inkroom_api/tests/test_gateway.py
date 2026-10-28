from __future__ import annotations

import json

import httpx

from inkroom_api import config
from inkroom_api.main import app


def _mock_client(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler), timeout=5)


def _reply(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json={
        "choices": [{"message": {"content": '{"ok": true}'}, "finish_reason": "stop"}],
        "usage": {"total_tokens": 12},
    })


def test_config_never_exposes_keys(client):
    body = client.get("/api/config").json()
    assert body["ready"] is True
    assert body["demo"] is False
    assert body["models"] == {
        "extraction": config.EXTRACTION_MODEL,
        "reasoning": config.REASONING_MODEL,
    }
    text = json.dumps(body)
    assert config.OPENROUTER_API_KEY not in text
    assert config.GROQ_API_KEY not in text


def test_chat_adds_server_key_and_hides_model_choice(client):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("authorization")
        seen["body"] = json.loads(request.content)
        return _reply(request)

    client.app.state.http = _mock_client(handler)
    res = client.post("/api/ai/chat", json={
        "agent": "extraction",
        "messages": [{"role": "user", "content": "Return JSON."}],
        "max_tokens": 100,
    })
    assert res.status_code == 200, res.text
    assert res.json()["text"] == '{"ok": true}'
    assert seen["url"] == config.OPENROUTER_URL
    assert seen["auth"] == f"Bearer {config.OPENROUTER_API_KEY}"
    assert seen["body"]["model"] == config.EXTRACTION_MODEL
    assert "api_key" not in seen["body"]


def test_reasoning_agent_uses_groq(client):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("authorization")
        seen["model"] = json.loads(request.content)["model"]
        return _reply(request)

    client.app.state.http = _mock_client(handler)
    res = client.post("/api/ai/chat", json={
        "agent": "reasoning",
        "messages": [{"role": "user", "content": "Return JSON."}],
    })
    assert res.status_code == 200, res.text
    assert seen["url"] == config.GROQ_URL
    assert seen["auth"] == f"Bearer {config.GROQ_API_KEY}"
    assert seen["model"] == config.REASONING_MODEL


def test_provider_errors_are_sanitised(client):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": {"message": "upstream exploded"}})

    client.app.state.http = _mock_client(handler)
    res = client.post("/api/ai/chat", json={
        "agent": "reasoning",
        "messages": [{"role": "user", "content": "Return JSON."}],
    })
    assert res.status_code == 502
    body = res.text
    assert config.GROQ_API_KEY not in body
    assert "upstream exploded" not in body


def test_unknown_agent_is_rejected(client):
    res = client.post("/api/ai/chat", json={
        "agent": "openrouter",
        "messages": [{"role": "user", "content": "Hello"}],
    })
    assert res.status_code == 422
    assert res.json()["detail"] == "Invalid request."


def test_oversized_prompt_is_rejected(client):
    res = client.post("/api/ai/chat", json={
        "agent": "reasoning",
        "messages": [{"role": "user", "content": "x" * (config.MAX_PROMPT_CHARS + 1)}],
    })
    assert res.status_code == 413


def test_unsupported_image_source_is_rejected(client):
    res = client.post("/api/ai/chat", json={
        "agent": "extraction",
        "messages": [{
            "role": "user",
            "content": [{"type": "image_url", "image_url": {"url": "https://example.com/a.png"}}],
        }],
    })
    assert res.status_code == 422


def test_a_user_message_is_required(client):
    res = client.post("/api/ai/chat", json={
        "agent": "reasoning",
        "messages": [{"role": "system", "content": "Only a system prompt."}],
    })
    assert res.status_code == 422
    assert "user message" in res.json()["detail"].lower()


def test_health_and_readiness(client):
    assert client.get("/api/health").json() == {"status": "ok"}
    ready = client.get("/api/ready").json()
    assert ready["ready"] is True
    assert ready["demo"] is False
    assert client.get("/").json()["name"] == "Inkroom API"


def test_demo_mode_is_explicit_and_never_calls_a_provider(client, monkeypatch):
    monkeypatch.setattr(config, "DEMO_MODE", True)

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("demo mode made a provider call")

    client.app.state.http = _mock_client(handler)
    public = client.get("/api/config").json()
    assert public["ready"] is True
    assert public["demo"] is True
    assert public["models"] == {}
    res = client.post("/api/ai/chat", json={
        "agent": "reasoning",
        "messages": [{"role": "user", "content": "Return JSON."}],
    })
    assert res.status_code == 503
    assert "demo mode" in res.json()["detail"].lower()


def test_missing_key_makes_the_service_not_ready(client, monkeypatch):
    monkeypatch.setattr(config, "DEMO_MODE", False)
    monkeypatch.setattr(config, "GROQ_API_KEY", "")

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("an unconfigured service made a provider call")

    client.app.state.http = _mock_client(handler)
    assert client.get("/api/ready").json()["ready"] is False
    public = client.get("/api/config").json()
    assert public["ready"] is False
    assert public["models"] == {}
    res = client.post("/api/ai/chat", json={
        "agent": "reasoning",
        "messages": [{"role": "user", "content": "Return JSON."}],
    })
    assert res.status_code == 503
    assert config.OPENROUTER_API_KEY not in res.text


def test_rate_limit_returns_retry_after(client):
    from inkroom_api.limits import SlidingWindowLimiter

    client.app.state.http = _mock_client(_reply)
    client.app.state.limiter = SlidingWindowLimiter(1, 0, 0)
    body = {"agent": "reasoning", "messages": [{"role": "user", "content": "Return JSON."}]}
    assert client.post("/api/ai/chat", json=body).status_code == 200
    blocked = client.post("/api/ai/chat", json=body)
    assert blocked.status_code == 429
    assert int(blocked.headers["retry-after"]) >= 1
    assert config.GROQ_API_KEY not in blocked.text
