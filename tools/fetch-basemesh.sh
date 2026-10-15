#!/usr/bin/env bash
# Download the CC0 Blender Studio "Human Base Meshes" bundle (only needed to re-run blender/base/extract_base.py;
# the extracted blender/base/hbm_base.npz is committed).
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)/blender/base/.cache"
URL="https://mirror.blender.org/demo/asset-bundles/human-base-meshes/human-base-meshes-bundle-v1.4.1.zip"
mkdir -p "$DIR"
curl -fSL -o "$DIR/hbm.zip" "$URL"
unzip -o -q "$DIR/hbm.zip" -d "$DIR"
rm "$DIR/hbm.zip"
echo "extracted to $DIR"
