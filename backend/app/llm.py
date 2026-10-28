"""
Model setup and retry policy.

  extraction agents              -> OpenRouter, thinkingmachines/inkling:free  (OPENROUTER_API_KEY, EXTRACTION_MODEL)
  validation + suggestion agents -> Groq, openai/gpt-oss-120b                  (GROQ_API_KEY, REASONING_MODEL)

Free tiers time out and rate-limit, so every call goes through RetryingLLM: on a timeout, rate limit
(HTTP 429), connection error or 5xx it waits LLM_RETRY_DELAY seconds (default 3) and tries again, up to
LLM_MAX_RETRIES times (default 7). If it still fails it raises LLMUnavailable and the agent decides what
to do (the validation agent marks the pair "unverified" for a human).

With DEMO_MODE=true no network call is made: a small offline heuristic engine answers instead.
"""
from __future__ import annotations

import os
import time
from typing import Callable

from . import config

OPENROUTER_URL = "https://openrouter.ai/api/v1"
DEFAULT_EXTRACTION_MODEL = "thinkingmachines/inkling:free"
DEFAULT_REASONING_MODEL = "openai/gpt-oss-120b"


class ConfigError(RuntimeError):
    """A missing API key or similar setup problem."""


class LLMUnavailable(RuntimeError):
    """The model kept timing out or rate-limiting after every retry."""


def extraction_model() -> str:
    return os.environ.get("EXTRACTION_MODEL", DEFAULT_EXTRACTION_MODEL)


def reasoning_model() -> str:
    return os.environ.get("REASONING_MODEL", DEFAULT_REASONING_MODEL)


def retry_delay() -> float:
    return float(os.environ.get("LLM_RETRY_DELAY", "3"))


def max_retries() -> int:
    return int(os.environ.get("LLM_MAX_RETRIES", "7"))


def concurrency() -> int:
    return max(1, int(os.environ.get("GROQ_CONCURRENCY", "3")))


def missing_keys() -> list[str]:
    if config.DEMO_MODE:
        return []
    return [k for k in ("OPENROUTER_API_KEY", "GROQ_API_KEY") if not os.environ.get(k)]


def is_retryable(err: BaseException) -> bool:
    """Timeouts, rate limits, dropped connections and provider-side errors are worth waiting for."""
    status = getattr(err, "status_code", None)
    if status is None:
        status = getattr(getattr(err, "response", None), "status_code", None)
    if isinstance(status, int) and (status in (408, 429) or status >= 500):
        return True
    if isinstance(err, (TimeoutError, ConnectionError)):
        return True
    name = type(err).__name__.lower()
    return any(word in name for word in ("timeout", "ratelimit", "connection"))


class RetryingLLM:
    """Wraps a chat model: same .invoke(), plus the fixed-delay retry policy."""

    def __init__(self, llm, name: str, delay: float | None = None, retries: int | None = None,
                 sleep: Callable[[float], None] = time.sleep, log: Callable[[str], None] = print):
        self.llm, self.name, self.sleep, self.log = llm, name, sleep, log
        self.delay = retry_delay() if delay is None else delay
        self.retries = max_retries() if retries is None else retries

    def invoke(self, messages):
        for attempt in range(self.retries + 1):
            try:
                return self.llm.invoke(messages)
            except Exception as err:  # noqa: BLE001 - decide below whether it is worth retrying
                if not is_retryable(err):
                    raise
                if attempt == self.retries:
                    raise LLMUnavailable(
                        f"{self.name} is still failing after {self.retries} retries "
                        f"({type(err).__name__}: {str(err)[:200]})") from err
                self.log(f"[{self.name}] {type(err).__name__}; retry {attempt + 1}/{self.retries} in {self.delay:g}s")
                self.sleep(self.delay)
        raise AssertionError("unreachable")


def make_extraction_llm(log: Callable[[str], None] = print):
    if config.DEMO_MODE:
        from .demo_llm import DemoLLM
        return DemoLLM()
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        raise ConfigError("Set OPENROUTER_API_KEY first (https://openrouter.ai/keys).")
    from langchain_openai import ChatOpenAI
    model = extraction_model()
    chat = ChatOpenAI(model=model, api_key=key, base_url=OPENROUTER_URL, temperature=0,
                      timeout=300, max_retries=0)  # our wrapper does the retrying
    return RetryingLLM(chat, f"OpenRouter {model}", log=log)


def make_reasoning_llm(log: Callable[[str], None] = print):
    if config.DEMO_MODE:
        from .demo_llm import DemoLLM
        return DemoLLM()
    key = os.environ.get("GROQ_API_KEY")
    if not key:
        raise ConfigError("Set GROQ_API_KEY first (https://console.groq.com/keys).")
    from langchain_groq import ChatGroq
    model = reasoning_model()
    chat = ChatGroq(model=model, api_key=key, temperature=0, request_timeout=90, max_retries=0)
    return RetryingLLM(chat, f"Groq {model}", log=log)
