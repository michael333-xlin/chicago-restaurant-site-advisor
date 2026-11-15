# OpeningTable: React frontend + Python data/model pipeline + FastAPI server in one image.
# Data and models live on a persistent volume (DATA_DIR / OUTPUT_DIR); the first start builds them.

# ---- 1. build the frontend
FROM node:22-slim AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---- 2. runtime
FROM python:3.13-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 \
    DATA_DIR=/var/plategap/data OUTPUT_DIR=/var/plategap/output
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY advantage/ advantage/
COPY finance/ finance/
COPY server/ server/
COPY data/seed/ data/seed/
COPY web/src/data/ web/src/data/
COPY --from=web /app/web/dist web/dist
RUN mkdir -p /var/plategap/data /var/plategap/output
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD curl -fs http://localhost:${PORT:-8000}/api/health || exit 1
CMD ["sh", "-c", "uvicorn server.app:app --host 0.0.0.0 --port ${PORT:-8000}"]
