import os
import sys
from pathlib import Path

# Set before importing the app: config reads the environment at import time.
os.environ.setdefault("DEMO_MODE", "false")
os.environ.setdefault("OPENROUTER_API_KEY", "test-openrouter-key")
os.environ.setdefault("GROQ_API_KEY", "test-groq-key")
os.environ.setdefault("EXTRACTION_MODEL", "test/extraction-model")
os.environ.setdefault("REASONING_MODEL", "test/reasoning-model")
os.environ.setdefault("RATE_LIMIT_PER_MINUTE", "1000")
os.environ.setdefault("RATE_LIMIT_PER_HOUR", "5000")
os.environ.setdefault("RATE_LIMIT_PER_DAY", "10000")
os.environ.setdefault("UPSTREAM_RETRY_DELAY", "0")
os.environ.setdefault("UPSTREAM_RETRIES", "0")
# Tests exercise the API-only app: point STATIC_DIR at a path that has no build.
os.environ["STATIC_DIR"] = str(Path(__file__).resolve().parent / "_no_static")
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from inkroom_api.main import app  # noqa: E402


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c
