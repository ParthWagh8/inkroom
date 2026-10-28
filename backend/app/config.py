"""Settings, all read from environment variables (see .env.example)."""
from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent


def _flag(name: str, default: bool = False) -> bool:
    return os.environ.get(name, str(default)).strip().lower() in ("1", "true", "yes", "on")


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


# Offline heuristic engine instead of real AI models. For demos and tests only; the UI says so loudly.
DEMO_MODE = _flag("DEMO_MODE")

# Extracted claims, facts, findings and decisions are stored here. Uploaded originals are never stored.
DATA_DIR = Path(os.environ.get("DATA_DIR", BASE_DIR / "data")).resolve()
RETENTION_DAYS = _int("RETENTION_DAYS", 30)  # 0 = keep forever

# Optional shared access code. When set, every /api call (except health and config) must send it.
ACCESS_CODE = os.environ.get("APP_ACCESS_CODE", "")

MAX_FILE_MB = _int("MAX_FILE_MB", 15)
MAX_FILES_PER_SIDE = _int("MAX_FILES_PER_SIDE", 20)
MAX_ACTIVE_RUNS = _int("MAX_ACTIVE_RUNS", 3)

CORS_ORIGINS = [o.strip() for o in os.environ.get("CORS_ORIGINS", "").split(",") if o.strip()]

STATIC_DIR = Path(os.environ.get("STATIC_DIR", BASE_DIR / "static")).resolve()
SAMPLE_DIR = Path(os.environ.get("SAMPLE_DIR", BASE_DIR / "sample_data")).resolve()

CONTENT_EXT = {".txt", ".md", ".csv", ".json", ".html", ".htm", ".eml", ".pdf", ".png", ".jpg", ".jpeg", ".webp"}
REFERENCE_EXT = {".txt", ".md", ".csv", ".json", ".html", ".htm", ".pdf", ".png", ".jpg", ".jpeg", ".webp"}
