#!/usr/bin/env bash
# Build the game and publish it to Subir at a stable, shareable slug.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SLUG="${1:-inkfist}"
cd "$ROOT/game"
npm run test --silent
npm run build
if subir info "$SLUG" >/dev/null 2>&1; then
  subir upload ./dist --slug "$SLUG" --replace --no-copy
else
  subir upload ./dist --slug "$SLUG" --no-copy
fi
