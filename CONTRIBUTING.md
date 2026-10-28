# Contributing

Thanks for helping improve Inkroom. The project is a React workflow plus a small FastAPI gateway. Keep the review
human-controlled and keep provider credentials on the server.

## Set up

Prerequisites: Node 20 or newer, Python 3.12, and Git. Docker is only needed to test the production image.

```powershell
Copy-Item .env.example .env
# Add your own OPENROUTER_API_KEY and GROQ_API_KEY. Never commit .env.
```

API:

```powershell
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements-api-dev.txt
uvicorn inkroom_api.main:app --reload --port 8000
```

Frontend, in a second terminal:

```powershell
cd frontend
npm ci
npm run dev
```

For an offline UI review, set `DEMO_MODE=true` in `.env` and restart the API. Demo mode is explicit and is labelled
in the UI; it is never a silent fallback.

## Checks before a pull request

```powershell
cd frontend
npm test
npm run build

cd ..\backend
python -m pytest inkroom_api/tests -q
```

The CI workflow also builds the production container and smoke-tests it in demo mode. If Docker is available:

```powershell
docker build -t inkroom:local .
docker run --rm -e DEMO_MODE=true -p 8000:8000 inkroom:local
```

`backend/app/`, `backend/tests/`, and the matching legacy requirements and deployment files are the original
prototype. They are not used by the production image and are not part of CI.

## Ground rules

- **No secrets in the browser.** The frontend may send `agent: "extraction" | "reasoning"`, messages, a token cap,
  and a temperature. It must never choose or receive a provider, URL, key, or model.
- **No secrets in Git.** Do not commit `.env`, tokens, customer files, or real review output. Use `.env.example` for
  new configuration names.
- **Keep the human checkpoints.** Claim review, evidence review, direction, and final approval are part of the
  product. Do not replace them with automatic approval.
- **Plain language in the UI.** Prefer "Claim", "Approved fact", "Your decision", and "Final package" over internal
  model or graph terminology. Keep raw JSON in the developer section.
- **One worker assumption.** Rate limits and the concurrency guard are in process memory. Do not document or enable
  multi-worker deployment without moving that state to a shared store.
- **Match the visual language.** The UI is intentionally neo-brutalist: heavy borders, flat colour blocks, rotated
  stamps, mono labels, and generous spacing. Reuse the existing tokens in `frontend/src/styles.css`.

## Pull requests

Keep changes focused. Describe the user-visible effect, list the checks you ran, and update `README.md`,
`docs/DEPLOYMENT.md`, or `.env.example` when behaviour or configuration changes. The pull request template contains
the short checklist.
