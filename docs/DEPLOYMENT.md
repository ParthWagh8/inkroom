# Deploying Inkroom

Inkroom ships as **one container**: FastAPI serves the API and the built React app from the same origin. There is no
database and no server-side review storage; a review lives in the browser tab and the finished package is
downloaded by the user.

The supported paths are:

1. **Render Blueprint** — the shortest route; managed TLS and health checks, no server maintenance.
2. **Docker Compose on a VPS** — full control; you provide a domain and a reverse proxy.

Any container platform works if it can run the root `Dockerfile`, expose one HTTP port, set environment variables,
and reach `openrouter.ai` and `api.groq.com`.

---

## Before you deploy

- [ ] You have an OpenRouter key and a Groq key. Paid tiers are strongly recommended: a full review makes several
      model calls and free tiers are rate-limited.
- [ ] You ran a review locally or in the container with the files in `sample-files/`.
- [ ] `DEMO_MODE=false`. Demo mode is an explicit offline mode, not a fallback for a real deployment.
- [ ] You decided who can use the app. The server owns the keys, so every visitor can spend your provider quota.
- [ ] You have a domain and HTTPS, or you are using a platform such as Render that provides both.
- [ ] The app runs as **one instance/worker**. Rate limits and the concurrency guard are in process memory.
- [ ] `.env` is not in Git. The repository ignores it and the Docker build context excludes it.

---

## Environment variables

The full template is `.env.example`. Only the first three rows normally need attention.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `OPENROUTER_API_KEY` | Yes, unless demo | empty | Server-only secret. Extraction and image agents. |
| `GROQ_API_KEY` | Yes, unless demo | empty | Server-only secret. Validation, suggestions, synthesis. |
| `DEMO_MODE` | No | `false` | Keep `false` in production. `true` makes no provider calls. |
| `EXTRACTION_MODEL` | No | the vision model in `.env.example` | Server-side model override. Never sent to the browser. |
| `REASONING_MODEL` | No | the reasoning model in `.env.example` | Server-side model override. |
| `PORT` | No | `8000` | The container listens on this port. Render sets it automatically. |
| `STATIC_DIR` | No | `/app/static` in the image | Built frontend directory. Do not change in the container. |
| `MAX_REQUEST_BYTES` | No | 20 MB | Largest accepted chat request body. |
| `MAX_PROMPT_CHARS` | No | 200,000 | Total text characters across messages. |
| `MAX_MESSAGES` | No | 24 | Message count per model call. |
| `MAX_IMAGES` | No | 6 | Images per model call. |
| `MAX_OUTPUT_TOKENS` | No | 8192 | Upper bound for a model reply. |
| `MAX_CONCURRENT_CALLS` | No | 8 | Provider calls in flight per process. Lower it if your provider tier throttles. |
| `RATE_LIMIT_PER_MINUTE` | No | 60 | Per-IP request limit. |
| `RATE_LIMIT_PER_HOUR` | No | 600 | Per-IP request limit. |
| `RATE_LIMIT_PER_DAY` | No | 2000 | Per-IP request limit. |
| `UPSTREAM_TIMEOUT` | No | 180 | Provider timeout in seconds. |
| `UPSTREAM_RETRIES` | No | 1 | Server-side retries for transient provider failures. |
| `CORS_ORIGINS` | No | empty | Only for a split frontend/API origin. Leave empty normally. |
| `TRUSTED_HOSTS` | No | empty | Comma-separated public hostnames accepted by the API. Recommended when known. |
| `PUBLIC_APP_URL` | No | empty | Sent to OpenRouter as the referring site. Set it after the first deploy. |
| `FORWARDED_ALLOW_IPS` | No | `127.0.0.1` | Proxy addresses trusted to set `X-Forwarded-For`. |
| `BIND_ADDRESS` | Compose only | `127.0.0.1` | Host address that publishes port 8000. |
| `APP_PORT` | Compose only | `8000` | Host port that publishes port 8000. |

Never create a `VITE_*` variable for a provider key. Vite embeds those values in the JavaScript bundle.

---

## Option A — Render Blueprint (recommended)

### 1. Push the repository to GitHub

Create an **empty** GitHub repository (no README, no `.gitignore`), then from this folder:

```bash
git init -b main
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR-ACCOUNT/inkroom.git
git push -u origin main
```

Before pushing, confirm that the environment file is not tracked:

```bash
git ls-files | grep -E '(^|/)\.env$'    # must print nothing
```

### 2. Create the Blueprint

1. Sign in to [Render](https://dashboard.render.com/).
2. Choose **New +** → **Blueprint**.
3. Connect the GitHub repository.
4. Render reads `render.yaml` and shows the `inkroom` web service.
5. Enter the values for `OPENROUTER_API_KEY` and `GROQ_API_KEY` when prompted. They are stored as Render secrets,
   not in the repository.
6. Apply the Blueprint.

The blueprint uses the `free` plan, so the service sleeps when idle and can take time to wake before a review.
If you want an always-on service without cold starts, change `plan: free` to `plan: starter` in `render.yaml` (or
choose it in the dashboard).

### 3. Verify

Render builds the root `Dockerfile`, starts the container, and checks `GET /api/health`. After the deploy is live:

```bash
curl https://YOUR-SERVICE.onrender.com/api/health
curl https://YOUR-SERVICE.onrender.com/api/config
```

Expected: health returns `{"status":"ok"}`, and configuration reports `"ready": true` with `"demo": false`. Open the
site and run the sample files. Provider errors appear in **Logs**; keys and request bodies are not logged.

### 4. Finish the setup

- Add `PUBLIC_APP_URL=https://YOUR-SERVICE.onrender.com` (or your custom domain) in **Environment** and redeploy.
- Add a custom domain under **Settings** → **Custom Domains**. Render provisions TLS.
- Optionally set `TRUSTED_HOSTS` to your public hostname.
- Keep `FORWARDED_ALLOW_IPS=*` only because Render is the only route to the service and terminates TLS in front of
  it. Do not copy that value to a deployment where clients can reach uvicorn directly.

### Render notes

- **No disk is needed.** Reviews are held in the browser. Do not add a persistent disk.
- **One instance.** Do not scale the service horizontally without moving rate limiting to a shared store.
- **Free plan.** The service sleeps when idle and has limited resources. Starter is a better fit for model-backed
  reviews.
- **Provider quota.** Render's health checks do not call providers. A review consumes your own API quota.

---

## Option B — Docker Compose on a VPS

This example uses Ubuntu, Docker Engine, and Caddy as the TLS reverse proxy.

### 1. Install Docker

Follow Docker's official instructions for your distribution, then check:

```bash
docker --version
docker compose version
```

### 2. Get the code and configure it

```bash
sudo mkdir -p /opt/inkroom
sudo chown "$USER":"$USER" /opt/inkroom
git clone https://github.com/YOUR-ACCOUNT/inkroom.git /opt/inkroom
cd /opt/inkroom
cp .env.example .env
nano .env
```

Set at least:

```dotenv
OPENROUTER_API_KEY=your-real-key
GROQ_API_KEY=your-real-key
DEMO_MODE=false

# The container is published on 127.0.0.1 only. Caddy is the public entrance.
FORWARDED_ALLOW_IPS=*
PUBLIC_APP_URL=https://inkroom.example.com

# Optional: accept requests only for this hostname.
TRUSTED_HOSTS=inkroom.example.com
```

`FORWARDED_ALLOW_IPS=*` is appropriate here because `docker-compose.yml` publishes the app on loopback only. If you
change `BIND_ADDRESS` to `0.0.0.0`, put a real proxy address there instead of `*`.

### 3. Start the app

```bash
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:8000/api/health
curl -fsS http://127.0.0.1:8000/api/config
```

The second check must report `"ready": true` and `"demo": false`. If it does not, inspect:

```bash
docker compose logs --tail=200
```

### 4. Put Caddy in front

Point an `A`/`AAAA` DNS record at the VPS, then install Caddy and create `/etc/caddy/Caddyfile`:

```caddyfile
inkroom.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8000
}
```

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo systemctl status caddy --no-pager
```

Caddy obtains and renews TLS certificates. Make sure TCP 80 and 443 are reachable and port 8000 is **not** open to
the internet.

If you use Nginx instead, proxy to `http://127.0.0.1:8000` and set:

```nginx
proxy_set_header Host $host;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
```

### 5. Firewall

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

### 6. Update and restart

```bash
cd /opt/inkroom
git pull --ff-only
docker compose up -d --build
docker image prune -f
```

Key rotation:

```bash
cd /opt/inkroom
nano .env               # replace the key
docker compose up -d --force-recreate
curl -fsS http://127.0.0.1:8000/api/ready
```

There is no database or data volume to migrate. The only server-side state is the running process.

---

## Option C — another container platform

Use the root `Dockerfile`; do not use `backend/Dockerfile` (legacy prototype).

Set `OPENROUTER_API_KEY`, `GROQ_API_KEY`, and `DEMO_MODE=false` as platform secrets. Expose the port from `PORT`
(the image defaults to 8000), use `/api/health` as the health check, and run one instance. Allow outbound HTTPS to
`openrouter.ai` and `api.groq.com`. If the platform terminates TLS, configure its forwarded-IP header and set
`FORWARDED_ALLOW_IPS` to the platform proxy addresses. Reviews can take minutes, so set the request timeout higher
than a typical web request if the platform has one.

---

## Operations

### Health and readiness

| Endpoint | Meaning |
|---|---|
| `GET /api/health` | Process is alive. Use for liveness and container health checks. |
| `GET /api/ready` | Provider keys are configured and demo mode is known. |
| `GET /api/config` | Public readiness, demo flag, server-selected model names, and limits. |

### Logs

The API logs one line per request with a request ID, status, and duration. It never logs request bodies, uploaded
content, or keys. Use the request ID from an error response to find the matching log line.

### Scaling

Run one instance. The sliding-window limiter and the provider semaphore live in process memory. If you need more
than one instance, first move rate limiting to Redis or the edge, then set explicit `TRUSTED_HOSTS` and
`FORWARDED_ALLOW_IPS` for every proxy in the chain. Provider concurrency budgets multiply with instance count.

### Provider capacity

A full review makes several sequential and parallel model calls. If you see repeated `429` responses:

- lower `MAX_CONCURRENT_CALLS` (for example to 4);
- wait for the provider's window to reset;
- use a paid provider tier or a model with more output-token headroom.

The frontend also backs off and retries transient failures. A large review on a free tier can take several minutes.

### Backups

None are required for review content: the server does not store it. Back up `.env` or the platform's secret values
in a password manager, not in the repository. If the service is redeployed, open tabs must restart their review.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `/api/config` shows `"ready": false` | A provider key is missing or empty | Set both keys in the platform secret store and restart. |
| `503 The review service is not configured correctly` | Provider rejected the key (401/402/403) | Check the key, account credit, and model access; rotate if needed. |
| `503 The review service is busy` | Per-IP limit or provider `429` | Wait for `Retry-After`; lower concurrency; use a paid tier. |
| `502` or `504` | Provider outage, invalid JSON, or timeout | Retry; check provider status; increase `UPSTREAM_TIMEOUT` only if needed. |
| `413 Request is too large` | Uploaded material exceeds `MAX_REQUEST_BYTES` or prompt caps | Reduce files/page count or raise the limit deliberately. |
| `The frontend is not built` | Running uvicorn without a built `frontend/dist` | Use the Docker image; it copies the build into `STATIC_DIR`. |
| Blank page after deploy | Static build missing or wrong `STATIC_DIR` | Check the container build log and `/api/config`; do not override `STATIC_DIR`. |
| Caddy returns `502` | App container is down or on another port | `docker compose ps`, `docker compose logs`, `curl 127.0.0.1:8000/api/health`. |
| `env file .env not found` | Compose was started before configuration | `cp .env.example .env`, fill it in, start again. |
| Port 8000 is already in use | Another local service owns the port | Set `APP_PORT=8001` in `.env` and update the proxy target. |
| Render service sleeps before a review finishes | Free plan cold start / idle policy | Use the starter plan or keep the service warm. |
| Model returns malformed JSON | Model/provider behaviour or an output cap that is too low | Retry; use the recommended model; inspect the developer JSON section. |

For a security issue, follow [SECURITY.md](../SECURITY.md) instead of opening a public issue.
