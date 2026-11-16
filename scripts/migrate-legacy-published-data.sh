#!/usr/bin/env bash
# Migrate legacy/past-deployment DNS data into the cache-based data store.
#
# The data store is populated by GitHub Actions caches in normal operation.
# When the cache is empty (fresh repo / lost cache), this script seeds
# data-store/data/dns-latency.tsv from, in order:
#   1. a legacy committed TSV (docs/data/dns-latency.tsv), if present;
#   2. the past deployment's GitHub Pages artifact;
#   3. the currently deployed Pages data URL.
#
# It never requires a TSV to be committed: the past deployment is fetched at
# runtime. Exits 0 whether or not data was migrated.
set -euo pipefail

DATA_STORE_DIR="${DATA_STORE_DIR:-data-store}"
TARGET="$DATA_STORE_DIR/data/dns-latency.tsv"

mkdir -p "$DATA_STORE_DIR/data"

if [[ -f "$TARGET" ]]; then
  echo "Data store already has dns-latency.tsv; skipping migration."
  exit 0
fi

# 1. Legacy committed data (kept for backwards compat; may be absent).
for candidate in \
  "docs/data/dns-latency.tsv" \
  "source/docs/data/dns-latency.tsv"; do
  if [[ -f "$candidate" ]]; then
    cp "$candidate" "$TARGET"
    echo "Migrated legacy committed data from $candidate."
    exit 0
  fi
done

# 2. Past deployment artifact (GitHub Pages artifact from a previous run).
RUN_ID="${PAST_DEPLOYMENT_RUN_ID:-43801539483}"
ARTIFACT_DIR="$(mktemp -d)"
trap 'rm -rf "$ARTIFACT_DIR"' EXIT
if gh run download "$RUN_ID" -n github-pages -D "$ARTIFACT_DIR" >/dev/null 2>&1; then
  if [[ -f "$ARTIFACT_DIR/artifact.tar" ]]; then
    tar -xf "$ARTIFACT_DIR/artifact.tar" -C "$ARTIFACT_DIR" >/dev/null 2>&1 || true
  fi
  if [[ -f "$ARTIFACT_DIR/data/dns-latency.tsv" ]]; then
    cp "$ARTIFACT_DIR/data/dns-latency.tsv" "$TARGET"
    echo "Migrated past deployment data from run $RUN_ID."
    exit 0
  fi
fi

# 3. Currently deployed Pages data (last resort).
URL="${PAST_DEPLOYMENT_DATA_URL:-https://www.nahcnuj.work/home-monitor/data/dns-latency.tsv}"
if curl -fsSL "$URL" -o "$TARGET" 2>/dev/null && [[ -s "$TARGET" ]]; then
  echo "Migrated past deployment data from $URL."
  exit 0
fi

rm -f "$TARGET"
echo "No legacy/past-deployment data available to migrate."
exit 0