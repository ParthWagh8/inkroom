"""The only browser-facing AI endpoint.

The browser sends an agent name, messages and a token cap. This module validates
that request, rate-limits it, adds the server's provider key and calls the
provider. Provider keys, model names and provider URLs never appear in a
response.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from typing import Any, Literal

import httpx
from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict, Field

from . import config
from .limits import SlidingWindowLimiter

logger = logging.getLogger("inkroom.gateway")

router = APIRouter(prefix="/api")

ALLOWED_ROLES = {"system", "user", "assistant"}
DATA_IMAGE = re.compile(r"^data:image/(png|jpe?g|webp|gif);base64,", re.IGNORECASE)
RETRYABLE_STATUS = {408, 409, 425, 429, 500, 502, 503, 504}
RETRYABLE_NETWORK = (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError)

AGENTS: dict[str, dict[str, str]] = {
    "extraction": {
        "provider": "openrouter",
        "url": config.OPENROUTER_URL,
        "key": config.OPENROUTER_API_KEY,
        "model": config.EXTRACTION_MODEL,
    },
    "reasoning": {
        "provider": "groq",
        "url": config.GROQ_URL,
        "key": config.GROQ_API_KEY,
        "model": config.REASONING_MODEL,
    },
}


class GatewayError(Exception):
    def __init__(self, status: int, detail: str, retry_after: int | None = None) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail
        self.retry_after = retry_after


class ChatIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    agent: Literal["extraction", "reasoning"]
    messages: list[dict[str, Any]] = Field(min_length=1)
    max_tokens: int = Field(2400, ge=1, le=config.MAX_OUTPUT_TOKENS)
    temperature: float = Field(0.0, ge=0.0, le=1.0)


def _bad(detail: str, status: int = 422) -> GatewayError:
    return GatewayError(status, detail)


def validate_messages(messages: list[dict[str, Any]]) -> None:
    if len(messages) > config.MAX_MESSAGES:
        raise _bad(f"Too many messages (limit {config.MAX_MESSAGES}).", 413)

    total_chars = 0
    images = 0
    has_user = False
    for message in messages:
        if not isinstance(message, dict):
            raise _bad("Each message must be an object.")
        extra = set(message) - {"role", "content", "name"}
        if extra:
            raise _bad("A message contained an unsupported field.")
        role = message.get("role")
        if role not in ALLOWED_ROLES:
            raise _bad("A message had an unsupported role.")
        if role == "user":
            has_user = True
        name = message.get("name")
        if name is not None and (not isinstance(name, str) or len(name) > 80):
            raise _bad("A message name was invalid.")

        content = message.get("content")
        if isinstance(content, str):
            total_chars += len(content)
        elif isinstance(content, list):
            if not content:
                raise _bad("A message had empty content.")
            for part in content:
                if not isinstance(part, dict):
                    raise _bad("A message part must be an object.")
                kind = part.get("type")
                if kind == "text" and isinstance(part.get("text"), str):
                    total_chars += len(part["text"])
                elif kind == "image_url":
                    image = part.get("image_url")
                    url = image.get("url") if isinstance(image, dict) else None
                    if not isinstance(url, str) or not DATA_IMAGE.match(url):
                        raise _bad("Only in-memory PNG, JPEG, WebP or GIF images are accepted.")
                    images += 1
                    if images > config.MAX_IMAGES:
                        raise _bad(f"Too many images (limit {config.MAX_IMAGES}).", 413)
                else:
                    raise _bad("A message part had an unsupported type.")
        else:
            raise _bad("A message content value was invalid.")

        if total_chars > config.MAX_PROMPT_CHARS:
            raise _bad(f"Prompt is too large (limit {config.MAX_PROMPT_CHARS:,} characters).", 413)

    if not has_user:
        raise _bad("At least one user message is required.")


def _content_text(data: dict[str, Any]) -> str:
    options = data.get("choices")
    if not isinstance(options, list) or not options:
        return ""
    first = options[0] if isinstance(options[0], dict) else {}
    message = first.get("message") if isinstance(first.get("message"), dict) else {}
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            part.get("text", "") for part in content
            if isinstance(part, dict) and isinstance(part.get("text"), str)
        )
    return ""


def _provider_detail(response: httpx.Response) -> str:
    try:
        data = response.json()
        if isinstance(data, dict):
            error = data.get("error")
            if isinstance(error, dict) and isinstance(error.get("message"), str):
                return error["message"][:240]
            if isinstance(data.get("message"), str):
                return data["message"][:240]
    except (ValueError, json.JSONDecodeError):
        pass
    return (response.text or "")[:240]


def _redact(value: str) -> str:
    for key in (config.OPENROUTER_API_KEY, config.GROQ_API_KEY):
        if key:
            value = value.replace(key, "[redacted]")
    return value


def _retry_after(response: httpx.Response) -> int:
    try:
        return max(1, int(response.headers.get("retry-after", "0")))
    except (TypeError, ValueError):
        return 1


async def _upstream(request: Request, payload: ChatIn) -> dict[str, Any]:
    if config.DEMO_MODE:
        raise GatewayError(503, "This service is running in demo mode.")
    if not config.ready():
        raise GatewayError(503, "The review service is not configured.")

    agent = AGENTS[payload.agent]
    if not agent["key"]:
        raise GatewayError(503, "The review service is not configured.")

    body = {
        "model": agent["model"],
        "messages": payload.messages,
        "temperature": payload.temperature,
        "max_tokens": payload.max_tokens,
    }
    headers = {
        "Authorization": f"Bearer {agent['key']}",
        "Content-Type": "application/json",
    }
    if agent["provider"] == "openrouter":
        if config.PUBLIC_APP_URL:
            headers["HTTP-Referer"] = config.PUBLIC_APP_URL
        headers["X-Title"] = "Inkroom"

    request_id = getattr(request.state, "request_id", "-")
    semaphore: asyncio.Semaphore = request.app.state.semaphore
    try:
        await asyncio.wait_for(semaphore.acquire(), timeout=1.0)
    except TimeoutError:
        raise GatewayError(503, "The review service is busy. Try again shortly.", 5) from None

    try:
        client: httpx.AsyncClient = request.app.state.http
        for attempt in range(config.UPSTREAM_RETRIES + 1):
            try:
                response = await client.post(agent["url"], headers=headers, json=body)
            except httpx.TimeoutException:
                raise GatewayError(504, "The AI provider took too long. Try again.") from None
            except RETRYABLE_NETWORK as err:
                if attempt < config.UPSTREAM_RETRIES:
                    await asyncio.sleep(config.UPSTREAM_RETRY_DELAY * (attempt + 1))
                    continue
                logger.warning("upstream network error request=%s: %s", request_id, type(err).__name__)
                raise GatewayError(502, "The AI provider could not be reached. Try again.") from None

            if response.status_code < 400:
                try:
                    data = response.json()
                except ValueError:
                    raise GatewayError(502, "The AI provider returned an invalid response.") from None
                text = _content_text(data)
                if not text.strip():
                    raise GatewayError(502, "The AI provider returned an empty reply.")
                usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
                return {
                    "text": text,
                    "provider": agent["provider"],
                    "model": agent["model"],
                    "usage": usage,
                }

            detail = _redact(_provider_detail(response))
            if response.status_code in RETRYABLE_STATUS and attempt < config.UPSTREAM_RETRIES:
                wait = _retry_after(response) if response.status_code == 429 else config.UPSTREAM_RETRY_DELAY * (attempt + 1)
                logger.warning("upstream %s request=%s status=%s retrying in %ss: %s",
                               agent["provider"], request_id, response.status_code, wait, detail)
                await asyncio.sleep(wait)
                continue

            logger.warning("upstream %s request=%s status=%s: %s",
                           agent["provider"], request_id, response.status_code, detail)
            if response.status_code in (401, 402, 403):
                raise GatewayError(503, "The review service is not configured correctly.")
            if response.status_code == 429:
                raise GatewayError(503, "The review service is busy. Try again shortly.", _retry_after(response))
            raise GatewayError(502, "The AI provider could not complete this step. Try again.")
    finally:
        semaphore.release()

    raise GatewayError(502, "The AI provider could not complete this step. Try again.")


@router.post("/ai/chat")
async def chat(payload: ChatIn, request: Request):
    validate_messages(payload.messages)

    limiter: SlidingWindowLimiter = request.app.state.limiter
    client_id = request.client.host if request.client else "unknown"
    allowed, retry_after = limiter.hit(client_id)
    if not allowed:
        raise GatewayError(429, "Too many review requests. Try again shortly.", retry_after)

    result = await _upstream(request, payload)
    return result


@router.get("/config")
def public_config():
    models = {
        "extraction": config.EXTRACTION_MODEL,
        "reasoning": config.REASONING_MODEL,
    } if config.ready() and not config.DEMO_MODE else {}
    return {
        "ready": config.ready(),
        "demo": config.DEMO_MODE,
        "models": models,
        "limits": {
            "max_output_tokens": config.MAX_OUTPUT_TOKENS,
            "rate_limit_per_minute": config.RATE_LIMIT_PER_MINUTE,
        },
    }
