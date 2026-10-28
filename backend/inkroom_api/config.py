"""Production settings, all from environment variables."""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent


def _load_env() -> None:
    """Load a local .env for direct uvicorn runs. Real environment variables win."""
    for candidate in (BASE_DIR.parent / ".env", BASE_DIR / ".env"):
        if candidate.is_file():
            load_dotenv(candidate, override=False)
            return


_load_env()


def _flag(name: str, default: bool = False) -> bool:
    return os.environ.get(name, str(default)).strip().lower() in ("1", "true", "yes", "on")


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


def _csv(name: str) -> list[str]:
    return [part.strip() for part in os.environ.get(name, "").split(",") if part.strip()]


# --- Providers: keys are ours, never sent to the browser ---------------------
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "").strip()
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "").strip()
EXTRACTION_MODEL = os.environ.get("EXTRACTION_MODEL", "nvidia/nemotron-3.5-super-vl:free").strip()
REASONING_MODEL = os.environ.get("REASONING_MODEL", "qwen/qwen3.8-27b").strip()
OPENROUTER_URL = os.environ.get("OPENROUTER_URL", "https://openrouter.ai/api/v1/chat/completions").strip()
GROQ_URL = os.environ.get("GROQ_URL", "https://api.groq.com/openai/v1/chat/completions").strip()
PUBLIC_APP_URL = os.environ.get("PUBLIC_APP_URL", "").strip()

# Offline demo engine is selected by the operator. It is never a silent fallback.
DEMO_MODE = _flag("DEMO_MODE", False)

# --- Request limits ----------------------------------------------------------
MAX_REQUEST_BYTES = _int("MAX_REQUEST_BYTES", 20 * 1024 * 1024)
MAX_PROMPT_CHARS = _int("MAX_PROMPT_CHARS", 200_000)
MAX_MESSAGES = _int("MAX_MESSAGES", 24)
MAX_IMAGES = _int("MAX_IMAGES", 6)
MAX_OUTPUT_TOKENS = _int("MAX_OUTPUT_TOKENS", 8_192)
MAX_CONCURRENT_CALLS = _int("MAX_CONCURRENT_CALLS", 8)
RATE_LIMIT_PER_MINUTE = _int("RATE_LIMIT_PER_MINUTE", 60)
RATE_LIMIT_PER_HOUR = _int("RATE_LIMIT_PER_HOUR", 600)
RATE_LIMIT_PER_DAY = _int("RATE_LIMIT_PER_DAY", 2_000)
UPSTREAM_TIMEOUT = _float("UPSTREAM_TIMEOUT", 180.0)
UPSTREAM_RETRIES = _int("UPSTREAM_RETRIES", 1)
UPSTREAM_RETRY_DELAY = _float("UPSTREAM_RETRY_DELAY", 2.0)

# --- Deployment --------------------------------------------------------------
# Docker sets STATIC_DIR=/app/static. For a direct uvicorn run, serve frontend/dist when it exists.
_DEFAULT_STATIC = BASE_DIR / "static"
if not _DEFAULT_STATIC.is_dir() and (BASE_DIR.parent / "frontend" / "dist").is_dir():
    _DEFAULT_STATIC = BASE_DIR.parent / "frontend" / "dist"
STATIC_DIR = Path(os.environ.get("STATIC_DIR") or _DEFAULT_STATIC).resolve()
CORS_ORIGINS = _csv("CORS_ORIGINS")
TRUSTED_HOSTS = _csv("TRUSTED_HOSTS")

# Readiness is checked on every request so a key rotated by a restart is reflected.
def missing_configuration() -> list[str]:
    if DEMO_MODE:
        return []
    missing = []
    if not OPENROUTER_API_KEY:
        missing.append("OPENROUTER_API_KEY")
    if not GROQ_API_KEY:
        missing.append("GROQ_API_KEY")
    return missing


def ready() -> bool:
    return not missing_configuration()
