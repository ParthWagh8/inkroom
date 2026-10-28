"""
BrandGuard API.

    uvicorn app.main:app --port 8000

Routes live under /api. If a built frontend exists in STATIC_DIR it is served from / (single-container deploy).
Run with ONE worker: open runs are held in memory (see manager.py).
"""
from __future__ import annotations

import hmac
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import config, llm, manager, tracker

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

OPEN_PATHS = {"/api/health", "/api/config"}


@asynccontextmanager
async def lifespan(_: FastAPI):
    tracker.load_all()
    yield


app = FastAPI(title="BrandGuard API", version="1.0.0", lifespan=lifespan)

if config.CORS_ORIGINS:
    app.add_middleware(CORSMiddleware, allow_origins=config.CORS_ORIGINS, allow_methods=["*"],
                       allow_headers=["*"])


@app.middleware("http")
async def access_gate(request: Request, call_next):
    path = request.url.path
    if config.ACCESS_CODE and path.startswith("/api/") and path not in OPEN_PATHS and request.method != "OPTIONS":
        given = request.headers.get("x-access-code", "")
        if not hmac.compare_digest(given.encode(), config.ACCESS_CODE.encode()):
            return JSONResponse({"detail": "Access code required."}, status_code=401)
    return await call_next(request)


@app.exception_handler(manager.RunError)
async def run_error(_: Request, err: manager.RunError):
    return JSONResponse({"detail": str(err)}, status_code=err.status)


api = APIRouter(prefix="/api")


# --------------------------------------------------------------------------- #
# Meta
# --------------------------------------------------------------------------- #


@api.get("/health")
def health():
    return {"status": "ok"}


@api.get("/config")
def get_config():
    return {
        "demo": config.DEMO_MODE,
        "access_required": bool(config.ACCESS_CODE),
        "missing_keys": llm.missing_keys(),
        "nodes": tracker.public_specs(),
        "limits": {"max_file_mb": config.MAX_FILE_MB, "max_files": config.MAX_FILES_PER_SIDE},
        "extensions": {"content": sorted(config.CONTENT_EXT), "reference": sorted(config.REFERENCE_EXT)},
        "retention_days": config.RETENTION_DAYS,
    }


@api.get("/samples")
def samples():
    """Small example files so a new user can try the workflow in one click."""
    out: dict[str, list] = {"content": [], "reference": []}
    for side in out:
        folder = config.SAMPLE_DIR / side
        if folder.is_dir():
            out[side] = [{"name": p.name, "text": p.read_text(encoding="utf-8")} for p in sorted(folder.iterdir()) if p.is_file()]
    return out


# --------------------------------------------------------------------------- #
# Runs
# --------------------------------------------------------------------------- #


async def _read_uploads(files: list[UploadFile], allowed: set[str], label: str) -> list[tuple[str, bytes]]:
    if len(files) > config.MAX_FILES_PER_SIDE:
        raise HTTPException(413, f"Too many {label} files (limit {config.MAX_FILES_PER_SIDE}).")
    limit = config.MAX_FILE_MB * 1024 * 1024
    out: list[tuple[str, bytes]] = []
    taken: set[str] = set()
    for f in files:
        name = Path(f.filename or "file").name or "file"
        ext = Path(name).suffix.lower()
        if ext not in allowed:
            raise HTTPException(415, f"{name}: {ext or 'a file without an extension'} is not supported for {label} files.")
        data = await f.read(limit + 1)
        if len(data) > limit:
            raise HTTPException(413, f"{name} is larger than {config.MAX_FILE_MB} MB.")
        if not data:
            raise HTTPException(422, f"{name} is empty.")
        base, i = name, 1
        while name in taken:
            name, i = f"{Path(base).stem}_{i}{Path(base).suffix}", i + 1
        taken.add(name)
        out.append((name, data))
    return out


@api.post("/runs", status_code=201)
async def create_run(
    title: str = Form(""),
    owner: str = Form("Anonymous"),
    pause_source: bool = Form(True),
    pause_reference: bool = Form(True),
    consent: bool = Form(False),
    content_files: list[UploadFile] = File(default=[]),
    reference_files: list[UploadFile] = File(default=[]),
):
    if not config.DEMO_MODE and not consent:
        raise HTTPException(422, "Confirm the files are cleared to be sent to external AI services.")
    content = await _read_uploads(content_files, config.CONTENT_EXT, "content")
    refs = await _read_uploads(reference_files, config.REFERENCE_EXT, "reference")
    run = manager.start_run(owner.strip()[:60] or "Anonymous", title.strip()[:120] or "Untitled review",
                            content, refs, pause_source, pause_reference)
    return run.snapshot()


@api.get("/runs")
def list_runs():
    return tracker.list_runs()


def _run(run_id: str) -> tracker.Run:
    run = tracker.get(run_id)
    if not run:
        raise HTTPException(404, "Run not found.")
    return run


@api.get("/runs/{run_id}")
def get_run(run_id: str):
    return _run(run_id).snapshot()


class DecisionIn(BaseModel):
    index: int
    decision: Literal["accepted", "edited", "kept_original", "removed"]
    text: str = Field("", max_length=4000)
    note: str = Field("", max_length=2000)


class ResumeIn(BaseModel):
    stage: Literal["source", "reference", "review"]
    edited: dict | None = None
    decisions: list[DecisionIn] | None = None
    reviewer: str | None = Field(None, max_length=60)


@api.post("/runs/{run_id}/resume")
def resume(run_id: str, body: ResumeIn):
    run = manager.resume_run(run_id, body.stage, body.edited,
                             [d.model_dump() for d in body.decisions] if body.decisions is not None else None,
                             body.reviewer)
    return run.snapshot()


@api.post("/runs/{run_id}/retry")
def retry(run_id: str):
    return manager.retry_run(run_id).snapshot()


@api.delete("/runs/{run_id}", status_code=204)
def cancel(run_id: str):
    manager.cancel_run(run_id)
    return Response(status_code=204)


@api.get("/runs/{run_id}/files/{name}")
def get_file(run_id: str, name: str, download: bool = False):
    run = _run(run_id)
    try:
        text = run.read_file(name)  # only names the run itself produced are readable
    except FileNotFoundError:
        raise HTTPException(404, "File not found.") from None
    headers = {"Content-Disposition": f'attachment; filename="{name}"'} if download else {}
    return Response(text, media_type="application/json", headers=headers)


app.include_router(api)


# --------------------------------------------------------------------------- #
# Frontend (built files), served only when present
# --------------------------------------------------------------------------- #

_index = config.STATIC_DIR / "index.html"
if _index.exists():
    if (config.STATIC_DIR / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=config.STATIC_DIR / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(404)
        candidate = (config.STATIC_DIR / full_path).resolve()
        if full_path and candidate.is_file() and config.STATIC_DIR in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(_index)
