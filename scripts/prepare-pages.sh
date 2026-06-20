#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dashboard/dist"
DATA_DIR="${PAGES_DATA_DIR:-$ROOT/docs}"

cd "$ROOT"
npm ci
npm run build

if [[ ! -d "$DATA_DIR/data" ]]; then
  echo "Pages data not found under $DATA_DIR/data" >&2
  exit 1
fi

rm -rf "$DIST/data"
cp -R "$DATA_DIR/data" "$DIST/data"

echo "Pages artifact ready at dashboard/dist"