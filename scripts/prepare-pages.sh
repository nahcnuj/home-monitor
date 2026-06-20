#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dashboard/dist"
DATA_DIR="${PAGES_DATA_DIR:-$ROOT/docs}"

cd "$ROOT"
npm ci
npm run build

if [[ ! -d "$DATA_DIR/data" || ! -d "$DATA_DIR/config" ]]; then
  echo "Pages data not found under $DATA_DIR (expected data/ and config/)" >&2
  exit 1
fi

rm -rf "$DIST/data" "$DIST/config"
cp -R "$DATA_DIR/data" "$DIST/data"
cp -R "$DATA_DIR/config" "$DIST/config"

echo "Pages artifact ready at dashboard/dist"