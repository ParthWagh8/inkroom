import os
import sys
import tempfile
from pathlib import Path

# Must be set before the app is imported: config reads the environment at import time.
os.environ["DEMO_MODE"] = "true"
os.environ["DATA_DIR"] = tempfile.mkdtemp(prefix="brandguard-test-")
os.environ["LLM_RETRY_DELAY"] = "0"
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import tracker  # noqa: E402
from app.main import app  # noqa: E402

SAMPLES = Path(__file__).resolve().parent.parent / "sample_data"


@pytest.fixture()
def client():
    tracker.RUNS.clear()
    with TestClient(app) as c:
        yield c


def sample_files(side: str):
    return [("content_files" if side == "content" else "reference_files", (p.name, p.read_bytes()))
            for p in sorted((SAMPLES / side).iterdir())]


def start(client, content=None, refs=None, **form):
    files = (content if content is not None else sample_files("content")) + \
            (refs if refs is not None else sample_files("reference"))
    data = {"title": "t", "owner": "Tester", "pause_source": "true", "pause_reference": "true", "consent": "true"}
    data.update({k: str(v).lower() if isinstance(v, bool) else v for k, v in form.items()})
    return client.post("/api/runs", data=data, files=files)


def wait_for(client, run_id, statuses=("paused", "done", "error"), timeout=15):
    import time
    end = time.time() + timeout
    while time.time() < end:
        snap = client.get(f"/api/runs/{run_id}").json()
        if snap["status"] in statuses:
            return snap
        time.sleep(0.05)
    raise AssertionError(f"timed out waiting for {statuses}; last status {snap['status']}")
