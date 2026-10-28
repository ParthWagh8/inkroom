"""Inkroom production API and static host.

Run one worker: rate limits and concurrency guards are per process. Open runs are
not stored on the server; the browser keeps the workflow and downloads the files.
"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import config, gateway
from .limits import SlidingWindowLimiter

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("inkroom.api")


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.http = httpx.AsyncClient(
        timeout=httpx.Timeout(config.UPSTREAM_TIMEOUT, connect=10.0),
        limits=httpx.Limits(max_connections=32, max_keepalive_connections=16),
        follow_redirects=False,
    )
    app.state.semaphore = asyncio.Semaphore(config.MAX_CONCURRENT_CALLS)
    app.state.limiter = SlidingWindowLimiter(
        config.RATE_LIMIT_PER_MINUTE,
        config.RATE_LIMIT_PER_HOUR,
        config.RATE_LIMIT_PER_DAY,
    )
    missing = config.missing_configuration()
    if missing:
        logger.error("Review service is not ready. Missing: %s", ", ".join(missing))
    elif config.DEMO_MODE:
        logger.info("Running in demo mode: no provider calls will be made.")
    else:
        logger.info("Review service ready: extraction=%s reasoning=%s",
                    config.EXTRACTION_MODEL, config.REASONING_MODEL)
    yield
    await app.state.http.aclose()


app = FastAPI(
    title="Inkroom API",
    version="2.0.0",
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)

if config.CORS_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=config.CORS_ORIGINS,
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type"],
        expose_headers=["Retry-After", "X-Request-ID"],
        max_age=600,
    )
if config.TRUSTED_HOSTS:
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=config.TRUSTED_HOSTS)
app.add_middleware(GZipMiddleware, minimum_size=1024)


SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "X-Frame-Options": "DENY",
    "Strict-Transport-Security": "max-age=31536000",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": (
        "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; "
        "font-src 'self' data:; script-src 'self'; connect-src 'self'; worker-src 'self' blob:; "
        "frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    ),
}


def _request_id(request: Request) -> str:
    given = (request.headers.get("x-request-id") or "").strip()
    if given and len(given) <= 64 and all(ch.isalnum() or ch in "-_." for ch in given):
        return given
    return uuid.uuid4().hex[:12]


@app.middleware("http")
async def request_context(request: Request, call_next):
    request_id = _request_id(request)
    request.state.request_id = request_id
    started = time.perf_counter()

    if request.url.path == "/api/ai/chat":
        length = request.headers.get("content-length")
        if length:
            try:
                too_large = int(length) > config.MAX_REQUEST_BYTES
            except ValueError:
                too_large = True
            if too_large:
                response = JSONResponse(
                    {"detail": f"Request is too large (limit {config.MAX_REQUEST_BYTES // (1024 * 1024)} MB)."},
                    status_code=413,
                )
                response.headers.update(SECURITY_HEADERS)
                response.headers["X-Request-ID"] = request_id
                response.headers["Cache-Control"] = "no-store"
                response.headers["Retry-After"] = "1"
                return response

    response = await call_next(request)
    response.headers.update(SECURITY_HEADERS)
    response.headers["X-Request-ID"] = request_id

    path = request.url.path
    if path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    elif response.status_code == 200 and path.startswith("/assets/"):
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    elif response.status_code == 200:
        response.headers["Cache-Control"] = "no-cache"

    logger.info("%s %s %s %s %.0fms", request_id, request.method, path,
                response.status_code, (time.perf_counter() - started) * 1000)
    return response


@app.exception_handler(gateway.GatewayError)
async def gateway_error(request: Request, err: gateway.GatewayError):
    headers = {"X-Request-ID": getattr(request.state, "request_id", "-")}
    if err.retry_after:
        headers["Retry-After"] = str(err.retry_after)
    return JSONResponse(
        {"detail": err.detail, "request_id": headers["X-Request-ID"]},
        status_code=err.status,
        headers=headers,
    )


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, _: RequestValidationError):
    return JSONResponse(
        {"detail": "Invalid request."},
        status_code=422,
        headers={"X-Request-ID": getattr(request.state, "request_id", "-")},
    )


@app.exception_handler(Exception)
async def unexpected_error(request: Request, err: Exception):
    request_id = getattr(request.state, "request_id", "-")
    logger.exception("Unhandled error request=%s", request_id, exc_info=err)
    return JSONResponse(
        {"detail": "The review service hit an unexpected error.", "request_id": request_id},
        status_code=500,
        headers={"X-Request-ID": request_id},
    )


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/ready")
def readiness():
    return {"ready": config.ready(), "demo": config.DEMO_MODE}


app.include_router(gateway.router)


# --------------------------------------------------------------------------- #
# Built frontend, served only when present
# --------------------------------------------------------------------------- #

_index = config.STATIC_DIR / "index.html"
if _index.exists():
    assets = config.STATIC_DIR / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str):
        if full_path.startswith("api/"):
            return JSONResponse({"detail": "Not found."}, status_code=404)
        candidate = (config.STATIC_DIR / full_path).resolve()
        if full_path and candidate.is_file() and candidate.is_relative_to(config.STATIC_DIR):
            return FileResponse(candidate)
        # Missing build assets and other file-like paths are real 404s, not SPA routes.
        if full_path.startswith("assets/") or Path(full_path).suffix:
            return JSONResponse({"detail": "Not found."}, status_code=404)
        return FileResponse(_index)
else:
    @app.get("/", include_in_schema=False)
    def root():
        return JSONResponse({
            "name": "Inkroom API",
            "message": "The frontend is not built. Run the Vite dev server or build frontend/dist into STATIC_DIR.",
        })
