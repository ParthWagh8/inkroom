# syntax=docker/dockerfile:1

# Stage 1: build the React app
FROM node:22-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# Stage 2: FastAPI serves the AI gateway and the built frontend from one container
FROM python:3.12-slim AS runtime
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1 \
    STATIC_DIR=/app/static PORT=8000
WORKDIR /app
COPY backend/requirements-api.txt ./
RUN pip install --no-compile -r requirements-api.txt
COPY backend/inkroom_api ./inkroom_api
COPY --from=web /web/dist ./static
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin appuser
USER appuser
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=4s --start-period=15s \
  CMD python -c "import os,urllib.request;urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','8000')+'/api/health',timeout=3)"
# One worker on purpose: rate limits and concurrency guards are held in memory.
# Only trust forwarded client addresses when a known proxy sets them (FORWARDED_ALLOW_IPS).
CMD ["sh", "-c", "exec uvicorn inkroom_api.main:app --host 0.0.0.0 --port \"${PORT:-8000}\" --workers 1 --no-server-header --timeout-graceful-shutdown 30 --proxy-headers --forwarded-allow-ips=\"${FORWARDED_ALLOW_IPS:-127.0.0.1}\""]
