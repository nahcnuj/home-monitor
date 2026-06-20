#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dashboard/dist"

cd "$ROOT"
npm ci
npm run build

rm -rf "$DIST/data" "$DIST/config"
cp -R "$ROOT/docs/data" "$DIST/data"
cp -R "$ROOT/docs/config" "$DIST/config"

echo "Pages artifact ready at dashboard/dist"