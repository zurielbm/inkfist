#!/usr/bin/env bash
# Run a Blender script headless: ./blender/run.sh build_chars.py -- mujin --export
BLENDER="${BLENDER:-/c/Program Files/Blender Foundation/Blender 5.2/blender.exe}"
DIR="$(cd "$(dirname "$0")" && pwd)"
script="$1"; shift
"$BLENDER" -b --factory-startup -P "$DIR/$script" "$@" 2>&1 | grep -E "BUILD|PREVIEW|EXPORT|INFO|BASE|PORTRAIT|^OG|ICON|PALM|SKIP|WARN|Error|error|Traceback|File \"|line [0-9]+" | grep -v "Fra:"
