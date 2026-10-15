# INKFIST server (agent arena + online relay) for your own VPS (docker-compose.yml, or Dokploy).
# Build from the repo root (the server imports the game's sim from ../game/src):
#   docker build -f server/Dockerfile .
# It runs on workerd, the open-source Workers runtime, through `wrangler dev` (no Cloudflare account involved).
# Durable Object state (SQLite) lives in /data, so mount a volume there.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    WRANGLER_SEND_METRICS=false \
    PORT=8787

WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund --include=dev && npm cache clean --force

COPY game/src /app/game/src
COPY server/ ./
RUN sed -i 's/\r$//' docker-start.sh && chmod +x docker-start.sh \
 && mkdir -p /data && chown -R node:node /data /app/server

USER node
EXPOSE 8787
VOLUME /data
CMD ["./docker-start.sh"]
