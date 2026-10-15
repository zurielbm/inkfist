#!/usr/bin/env bash
# Point the game at a running INKFIST server (your VPS, see docker-compose.yml) and republish the game.
#   tools/deploy-server.sh https://inkfist.example.com           Arena menu, ranked results, agents.md
#   tools/deploy-server.sh https://inkfist.example.com --relay   also route online play through the server's relay
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
URL="${1:-}"
if [ -z "$URL" ]; then
  echo "usage: tools/deploy-server.sh <server-url> [--relay]   (start the server on your VPS first, see server/README.md)" >&2
  exit 1
fi
URL="${URL%/}"
curl -fsS "$URL/api/fighters" >/dev/null || { echo "No INKFIST server answering at $URL" >&2; exit 1; }
# the game: Arena menu, ranked results and agents.md all use ARENA_URL
sed -i.bak -E "s#^export const ARENA_URL = '[^']*';#export const ARENA_URL = '$URL';#" "$ROOT/game/src/config.ts"
if [ "${2:-}" = "--relay" ]; then
  sed -i.bak -E "s#^export const RELAY_URL = '[^']*';#export const RELAY_URL = '$URL';#" "$ROOT/game/src/config.ts"
fi
rm -f "$ROOT/game/src/config.ts.bak"
grep -nE "(ARENA|RELAY)_URL = " "$ROOT/game/src/config.ts"
"$ROOT/tools/deploy.sh"
curl -fsS "$URL/api/leaderboard?board=agent_house" >/dev/null && echo "Arena API OK: $URL"
