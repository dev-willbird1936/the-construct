# The Construct — production image (Railway Dockerfile builder).
# node:24-bookworm-slim + ffmpeg (ingest probing/scaling) + python3 venv for
# the Basic depth/plate pipeline when its requirements exist.
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates libgomp1 libglib2.0-0 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /srv/app

COPY backend/package*.json backend/
RUN cd backend && npm ci --omit=dev

COPY . .

# Depth Anything V2 Small (Apache-2.0) is fetched at build time: the upload to
# Railway is capped near 100 MB, so the 95 MB ONNX file is not in the context.
# The venv is only built when the basic agent's requirements file is present.
RUN node backend/pipeline/basic/fetch-models.mjs
RUN if [ -f backend/pipeline/basic/requirements.txt ]; then \
      python3 -m venv /opt/basic-venv \
      && /opt/basic-venv/bin/pip install --no-cache-dir -r backend/pipeline/basic/requirements.txt; \
    fi

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    BASIC_PYTHON=/opt/basic-venv/bin/python

# No VOLUME instruction: Railway rejects it; the /data volume is attached by Railway.
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "backend/app/index.js"]
