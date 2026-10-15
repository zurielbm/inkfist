#!/usr/bin/env bash
# Deploy the INKFIST server (agent arena + relay), point the game at it, and republish the game.
#   tools/deploy-server.sh               deploy to Cloudflare (one-time: `cd server && npx wrangler login`)
#   tools/deploy-server.sh <server-url>  server already running elsewhere (Docker/Dokploy): just point the game at it
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
URL="${1:-}"
if [ -z "$URL" ]; then
  cd "$ROOT/server"
  npx tsc --noEmit
  OUT="$(npx wrangler deploy 2>&1 | tee /dev/stderr)"
  URL="$(printf '%s\n' "$OUT" | grep -oE 'https://[a-zA-Z0-9.-]+\.workers\.dev' | head -1)"
  if [ -z "$URL" ]; then
    echo "Could not find the deployed workers.dev URL in the wrangler output." >&2
    exit 1
  fi
  echo "Server live at $URL"
  # watch links from this server don't need ?arena=…
  sed -i.bak -E "s#\"PUBLIC_API\": \"[^\"]*\"#\"PUBLIC_API\": \"$URL\"#" wrangler.jsonc && rm -f wrangler.jsonc.bak
  npx wrangler deploy >/dev/null
fi
URL="${URL%/}"
curl -fsS "$URL/api/fighters" >/dev/null || { echo "No arena server answering at $URL" >&2; exit 1; }
# the game: Arena menu, ranked results and agents.md all use ARENA_URL
sed -i.bak -E "s#^export const ARENA_URL = '[^']*';#export const ARENA_URL = '$URL';#" "$ROOT/game/src/config.ts" && rm -f "$ROOT/game/src/config.ts.bak"
grep -n "ARENA_URL = " "$ROOT/game/src/config.ts"
"$ROOT/tools/deploy.sh"
curl -fsS "$URL/api/leaderboard?board=agent_house" >/dev/null && echo "Arena API OK: $URL"
