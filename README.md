# Inkroom

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/ParthWagh8/inkroom)

Inkroom checks content against approved facts and brand guidelines **before it is published**, with a person in
control at every important step. React + Vite on the front, FastAPI on the back, and **the operator owns the AI
provider keys**. Users only upload files.

```
01 Input ─▶ 02 Source extraction ─▶ 03 Claim checkpoint ─▶ 04 Reference matching ─▶ 05 Evidence checkpoint
                                                                                              │
10 Output ◀─ 09 Final approval ◀─ 08 Final synthesis ◀─ 07 Set the direction ◀─ 06 Validate + suggest
```

Boxes 03, 05, 07 and 09 are human checkpoints. The direction step and the final sign-off always happen; a person
must decide every finding and approve the package. Outputs are in-memory JSON files, downloadable as a single
package.

## Deploy

The production path is the root `Dockerfile`: one container serves the API and the built React app on one origin.

- **Render (recommended).** Push the repository, create a Blueprint from `render.yaml`, and enter the two provider
  keys as secrets. Render provides TLS, the health check, and the public URL. See
  [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#option-a--render-blueprint-recommended).
- **Docker Compose on a VPS.** Copy `.env.example` to `.env`, add the keys, then run `docker compose up -d --build`.
  The app binds to `127.0.0.1:8000` by default; put Caddy or Nginx in front for HTTPS. See
  [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#option-b--docker-compose-on-a-vps).
- **Another container platform.** Build the root `Dockerfile`, set the same environment variables, expose the port
  from `PORT`, and run one instance. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#option-c--another-container-platform).

Before opening the app to visitors, read the [deployment checklist](docs/DEPLOYMENT.md#before-you-deploy) and
[SECURITY.md](SECURITY.md). The server owns the provider keys, so every visitor can spend your provider quota.

## Local development

Create the environment file once. The backend reads it automatically; real environment variables take precedence.

```powershell
Copy-Item .env.example .env
# edit .env: OPENROUTER_API_KEY, GROQ_API_KEY, DEMO_MODE=false
```

Two terminals. The Vite dev server proxies `/api` to `http://127.0.0.1:8000`.

```powershell
# terminal 1: API
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements-api-dev.txt
uvicorn inkroom_api.main:app --reload --port 8000
```

```powershell
# terminal 2: frontend
cd frontend
npm ci
npm run dev
```

You can also skip Vite and open `http://127.0.0.1:8000` directly: when `frontend/dist` exists, the API serves the
built app from the same origin.

Offline demo (no provider calls, clearly labelled in the UI):

```powershell
$env:DEMO_MODE="true"
uvicorn inkroom_api.main:app --reload --port 8000
```

Demo mode is selected explicitly by the operator. The app never falls back to demo mode silently: if keys are
missing and `DEMO_MODE` is false, `/api/config` reports `ready: false` and runs cannot start.

## Production

Build the frontend and serve it from the API in one container:

```powershell
Copy-Item .env.example .env
# edit .env: OPENROUTER_API_KEY, GROQ_API_KEY, DEMO_MODE=false
docker compose up -d --build
```

Open `http://localhost:8000`. The health check is `GET /api/health`; readiness and public configuration are
`GET /api/ready` and `GET /api/config`.

- **One worker only.** Rate limits and concurrency guards are per process. If you need multiple instances, move
  the limiter to a shared edge/store first.
- **No database or disk.** Runs live in the browser tab. The container needs no persistent volume.
- **Reverse proxies.** The image runs uvicorn with `--proxy-headers`. Per-IP limits use `X-Forwarded-For` only
  when the proxy address is trusted through `FORWARDED_ALLOW_IPS`. Set it to your proxy IPs, or `*` only when the
  app is reachable exclusively through that proxy (the Render blueprint does this). Set `TRUSTED_HOSTS` and
  `CORS_ORIGINS` only when your deployment needs them.
- **Render.** `render.yaml` defines the same container. Add the two keys as secret environment variables.
- **TLS.** Terminate HTTPS at your proxy or platform; do not serve uploaded content over plain HTTP.
- **Public access.** Server-owned keys mean visitors can spend your provider quota. The rate limits and output
  caps bound that, but put the app behind your platform's access control or VPN if it is not meant to be public.
- **Provider capacity.** A full review makes several model calls. Free provider tiers are rate-limited, so large
  reviews can take minutes or wait on `429` backoff. Use paid provider tiers for predictable production latency.

## Architecture

| Part | Role |
|---|---|
| `frontend/` | React workflow, file parsing, human checkpoints, JSON output. Calls `/api/ai/chat` only. |
| `backend/inkroom_api/` | Production API: provider gateway, limits, static hosting, security headers. Owns all keys. |
| `backend/app/` | Legacy LangGraph/FastAPI prototype, kept for reference. Not used by the production image. |
| `docs/DEPLOYMENT.md` | Render, Docker/VPS, and operations guide. |
| `sample-files/` | Source and reference files that exercise a complete review. |

The browser sends only `agent: "extraction" | "reasoning"`, messages, a token cap and a temperature. The server maps
that role to its own provider URL, model and key. The browser never sees a key, a provider URL, an `Authorization`
header, or a model selector.

> **Never put a provider key in `frontend/`, `VITE_*` variables, browser storage, output files or logs.**

## API contract

`GET /api/config`

```json
{
  "ready": true,
  "demo": false,
  "models": { "extraction": "...", "reasoning": "..." },
  "limits": { "max_output_tokens": 8192, "rate_limit_per_minute": 60 }
}
```

`POST /api/ai/chat`

```json
{
  "agent": "reasoning",
  "messages": [{ "role": "user", "content": "Return JSON." }],
  "max_tokens": 2400,
  "temperature": 0
}
```

Response: `{ "text": "...", "provider": "...", "model": "...", "usage": {...} }`. Errors are sanitized:
`{ "detail": "...", "request_id": "..." }`. Provider keys, provider URLs and raw upstream errors are never returned.

## Production safeguards

- Keys live in environment variables on the server; they are never sent to the browser or written to disk.
- Request body, prompt, message count, image count and output-token caps.
- Per-IP sliding-window rate limits and a concurrency semaphore.
- Provider retries for transient failures, with `Retry-After` on rate limits.
- Strict validation of message roles, content parts and in-memory image data URLs.
- CSP, `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy` and no-store API responses.
- Request IDs in logs and error responses; no request bodies, file contents or keys are logged.

Report a vulnerability privately using [SECURITY.md](SECURITY.md). Do not open a public issue with a key or customer
content.

## Sample files

`sample-files/` contains a source set with deliberate claim conflicts and a reference set with approved facts and
brand rules. Open `sample-files/README.md` for the expected findings and loading order. The flyer exercises vision
extraction; skip it for a faster text-only review.

## Tests and CI

```powershell
cd backend
python -m pytest inkroom_api/tests -q
```

```powershell
cd frontend
npm test
npm run build
```

The backend tests mock the providers, so they need no real keys or network access. The GitHub Actions workflow runs
the frontend tests and build, the production API tests, and a container build plus demo-mode smoke test. The legacy
`backend/app/` prototype and `backend/tests/` are not part of CI.

## Repository layout

```
frontend/              React app, workflow engine, tests
backend/inkroom_api/   production FastAPI gateway
backend/app/           legacy prototype (not deployed)
docs/DEPLOYMENT.md     deployment and operations guide
Dockerfile             production multi-stage image
render.yaml            Render Blueprint
docker-compose.yml     self-hosted container deployment
sample-files/          sample review material
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Keep provider keys on the server, keep the human checkpoints, and run the
checks above before opening a pull request.
