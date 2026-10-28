# Inkroom backend

Production API for the Inkroom review workflow. The server owns the AI provider keys; the browser only calls two
public routes. The React app is served from the same container when `STATIC_DIR` contains a build.

```
inkroom_api/
  main.py       FastAPI app, middleware, static hosting, health/readiness
  gateway.py    /api/config and /api/ai/chat, provider calls, validation
  config.py     environment settings and readiness
  limits.py     in-process per-IP sliding-window limiter
  tests/        mocked-provider tests (no keys or network needed)
```

`app/` is the original LangGraph/FastAPI prototype. It is kept for reference and is not imported by the
production app. The legacy `app/`, `tests/`, `sample_data/`, `requirements.txt`, `requirements-dev.txt`, and the
deployment files in this folder (`Dockerfile`, `render.yaml`, `docker-compose.yml`) are not used by the production
image and are not covered by CI. The repository root is the authoritative production path.

## Run locally

Create the environment file at the repository root (or in `backend/`). The app loads it automatically, and real
environment variables take precedence.

```powershell
Copy-Item ..\.env.example ..\.env
# edit ..\.env
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements-api-dev.txt
uvicorn inkroom_api.main:app --reload --port 8000
```

For an offline demo, set `DEMO_MODE=true` in `.env` (or in the shell) and restart.

When `frontend/dist` exists, a direct uvicorn run serves the built app at `http://127.0.0.1:8000`. The Vite dev
server also proxies `/api` here.

## Configuration

All settings come from environment variables. See the root `.env.example` for the full list.

| Variable | Default | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | empty | Extraction and image-agent key. Required unless demo. |
| `GROQ_API_KEY` | empty | Reasoning-agent key. Required unless demo. |
| `EXTRACTION_MODEL` | `nvidia/nemotron-3.5-super-vl:free` | Server-side extraction model. |
| `REASONING_MODEL` | `qwen/qwen3.8-27b` | Server-side reasoning model. |
| `DEMO_MODE` | `false` | Explicit offline demo; no provider calls. |
| `STATIC_DIR` | `backend/static`, or `frontend/dist` when present | Built SPA directory. |
| `MAX_REQUEST_BYTES` | 20 MB | Largest accepted chat request body. |
| `MAX_PROMPT_CHARS` | 200000 | Total text characters in messages. |
| `MAX_OUTPUT_TOKENS` | 8192 | Largest allowed `max_tokens` value. |
| `MAX_CONCURRENT_CALLS` | 8 | Provider calls in flight per process. |
| `RATE_LIMIT_PER_MINUTE/HOUR/DAY` | 60 / 600 / 2000 | Per-IP request limits. |
| `UPSTREAM_TIMEOUT` | 180 | Provider timeout in seconds. |
| `UPSTREAM_RETRIES` | 1 | Retries for transient provider failures. |
| `CORS_ORIGINS` | empty | Only for a split frontend/API origin. |
| `TRUSTED_HOSTS` | empty | Optional comma-separated host allow-list. |

Keys are read from the environment and are never returned by an endpoint, written to disk, logged, or included in
run files. A key rotation takes effect on restart.

Free provider tiers are rate-limited. A full review makes several model calls, so large reviews can take minutes or
hit `429` backoff. Use paid provider tiers, or a model with more headroom, for predictable production latency. The
gateway retries transient failures and returns `Retry-After` when a client should wait.

## Routes

- `GET /api/health` - liveness.
- `GET /api/ready` - `{ ready, demo }`.
- `GET /api/config` - public readiness, demo flag, model names and limits.
- `POST /api/ai/chat` - one model turn. Body:
  `{ agent: "extraction" | "reasoning", messages, max_tokens, temperature }`.
  Response: `{ text, provider, model, usage }`.

Unknown fields and unknown agents are rejected. The browser cannot choose a provider, model, URL or key.

## Tests

```powershell
python -m pytest inkroom_api/tests -q
```

Tests replace `app.state.http` with an `httpx.MockTransport`, so provider keys and network access are not needed.

## Deployment notes

- Run **one worker**. Rate limits and the concurrency semaphore are in memory.
- The production image serves the SPA and API together; see the root `Dockerfile`.
- The app writes nothing to disk. There is no data volume to back up.
- Terminate HTTPS at the proxy/platform and keep provider keys in the platform's secret store.
- Set `FORWARDED_ALLOW_IPS` to the proxy addresses that may set `X-Forwarded-For`. Leaving it at the default
  prevents clients from spoofing their IP to bypass per-IP limits.
