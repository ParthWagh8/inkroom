# Security policy

## Supported versions

Security fixes are applied to the `main` branch. Deploy from a reviewed commit and keep the container image and
dependencies up to date.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private vulnerability reporting:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Include the affected commit, reproduction steps, impact, and any sanitized logs.

Do not include provider keys, `.env` contents, uploaded customer files, or other sensitive data. If a key may have
been exposed, revoke and rotate it with the provider before sending the report.

We aim to acknowledge reports within three business days. This project does not run a paid bug-bounty programme.

## Secret handling

- `OPENROUTER_API_KEY` and `GROQ_API_KEY` belong in the server environment or the platform's secret store.
- Never put a key in `frontend/`, a `VITE_*` variable, browser storage, a URL, a log line, an output file, or a
  GitHub issue.
- `.env` is ignored by Git and excluded from the Docker build context. `.env.example` contains names only.
- If a key was committed, rotate it first, then remove it from history with `git filter-repo` before force-pushing.
  Deleting the file in a later commit is not enough.
- Keys are read at process start. Rotate by updating the secret and restarting or redeploying the service.

## Deployment hardening

- Serve the app over HTTPS. Terminate TLS at the platform or a reverse proxy.
- Keep `DEMO_MODE=false` on a real deployment.
- Set `FORWARDED_ALLOW_IPS` only to proxy addresses that are allowed to set `X-Forwarded-For`.
- Set `TRUSTED_HOSTS` to the public hostname when the platform does not do that for you.
- The server owns the provider keys, so every visitor can spend your provider quota. Put the app behind your
  platform's access control, SSO, or a VPN if it is not meant to be public.
- Leave `CORS_ORIGINS` empty for the normal same-origin deployment.
- Run **one worker**. Rate limits and the concurrency guard are held in process memory.
- Review the request limits in `.env.example` before opening the app to a large audience.

## Known design limits

- Rate limiting is per process and per client IP. It is a cost guard, not a substitute for authentication.
- Model output is untrusted. A person must resolve every finding, set the direction, and approve the final package.
- Prompt injection is possible in any model-backed review. Do not publish output without the human checkpoints.
- Reviews live in the browser tab. The server does not store uploaded files or finished packages, and there is no
  server-side backup to restore after a lost tab.

## Scope

In scope: key exposure, authentication or rate-limit bypass, request-smuggling or header trust issues, path
traversal in static file serving, denial of service caused by the review endpoint, and unsafe output handling.

Out of scope: provider outages, free-tier throttling, the quality of a particular model's review, and issues that
require access to an already-compromised operator account.
