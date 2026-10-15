#!/bin/sh
# Container entrypoint: hand the environment to the Worker as vars, then serve on workerd with state in /data.
set -eu
if [ -z "${PUBLIC_API:-}" ]; then
  echo "PUBLIC_API is not set: agents.md and watch links use the proxy's X-Forwarded-Host." >&2
fi
printf 'GAME_URL=%s\nPUBLIC_API=%s\nIP_HEADER=%s\n' \
  "${GAME_URL:-https://pages.subir.dev/inkfist/}" "${PUBLIC_API:-}" "${IP_HEADER:-x-real-ip}" > .dev.vars
exec node_modules/.bin/wrangler dev \
  --ip 0.0.0.0 --port "${PORT:-8787}" \
  --persist-to "${DATA_DIR:-/data}" \
  --show-interactive-dev-session=false \
  --log-level "${LOG_LEVEL:-info}"
