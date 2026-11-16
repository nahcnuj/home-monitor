#!/usr/bin/env bash
# Migrate legacy/past-deployment DNS data into the cache-based data store.
#
# The data store is populated by GitHub Actions caches in normal operation.
# When the cache is empty or partial (fresh repo / lost or stale cache), this
# script augments data-store/data/dns-latency.tsv from, in order:
#   1. a legacy committed TSV (docs/data/dns-latency.tsv), if present;
#   2. the past deployment's GitHub Pages artifact;
#   3. the currently deployed Pages data URL.
#
# Existing rows are preserved and merged (deduplicated), so newer cached data is
# never lost. It never requires a TSV to be committed: the past deployment is
# fetched at runtime. Exits 0 whether or not data was migrated.
set -euo pipefail

DATA_STORE_DIR="${DATA_STORE_DIR:-data-store}"
TARGET="$DATA_STORE_DIR/data/dns-latency.tsv"

mkdir -p "$DATA_STORE_DIR/data"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

CANDIDATES=()

# 1. Legacy committed data (kept for backwards compat; may be absent).
for candidate in \
  "docs/data/dns-latency.tsv" \
  "source/docs/data/dns-latency.tsv"; do
  if [[ -f "$candidate" ]]; then
    CANDIDATES+=("$candidate")
  fi
done

# 2. Past deployment artifact (GitHub Pages artifact from a previous run).
RUN_ID="${PAST_DEPLOYMENT_RUN_ID:-43801539483}"
ARTIFACT_DIR="$WORK/artifact"
mkdir -p "$ARTIFACT_DIR"
if gh run download "$RUN_ID" -n github-pages -D "$ARTIFACT_DIR" >/dev/null 2>&1; then
  if [[ -f "$ARTIFACT_DIR/artifact.tar" ]]; then
    tar -xf "$ARTIFACT_DIR/artifact.tar" -C "$ARTIFACT_DIR" >/dev/null 2>&1 || true
  fi
  if [[ -f "$ARTIFACT_DIR/data/dns-latency.tsv" ]]; then
    CANDIDATES+=("$ARTIFACT_DIR/data/dns-latency.tsv")
  fi
fi

# 3. Currently deployed Pages data (last resort).
URL="${PAST_DEPLOYMENT_DATA_URL:-https://www.nahcnuj.work/home-monitor/data/dns-latency.tsv}"
PAGES_TSV="$WORK/pages.tsv"
if curl -fsSL "$URL" -o "$PAGES_TSV" 2>/dev/null && [[ -s "$PAGES_TSV" ]]; then
  CANDIDATES+=("$PAGES_TSV")
fi

if [[ ${#CANDIDATES[@]} -eq 0 ]]; then
  if [[ ! -f "$TARGET" ]]; then
    echo "No legacy/past-deployment data available to migrate."
  fi
  exit 0
fi

python3 - "$TARGET" "${CANDIDATES[@]}" << 'PYEOF'
import os
import re
import sys

target = sys.argv[1]
sources = sys.argv[2:]

IPV4 = re.compile(r"^(?:\d{1,3}\.){3}\d{1,3}$")
IPV6 = re.compile(r"^[0-9a-fA-F:]+$")


def is_dns_server_key(key):
    if key == "unknown":
        return True
    return bool(IPV4.match(key) or IPV6.match(key))


def row_key(cols):
    domain = ""
    if len(cols) >= 4 and cols[2] and not cols[2].isdigit():
        domain = cols[2]
    return (cols[0], cols[1], domain)


existing_lines = []
if os.path.exists(target):
    with open(target, encoding="utf-8") as f:
        existing_lines = [ln for ln in f.read().splitlines() if ln.strip()]

seen = set()
merged = []
for line in existing_lines:
    cols = line.split("\t")
    if len(cols) < 2 or not is_dns_server_key(cols[1]):
        continue
    key = row_key(cols)
    if key in seen:
        continue
    seen.add(key)
    merged.append(line)

added = 0
for src in sources:
    with open(src, encoding="utf-8") as f:
        for raw in f:
            line = raw.rstrip("\n").rstrip("\r")
            if not line.strip():
                continue
            cols = line.split("\t")
            if len(cols) < 2 or not is_dns_server_key(cols[1]):
                continue
            key = row_key(cols)
            if key in seen:
                continue
            seen.add(key)
            merged.append(line)
            added += 1

merged.sort(key=lambda ln: int(ln.split("\t")[0]))

os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
with open(target, "w", encoding="utf-8") as f:
    if merged:
        f.write("\n".join(merged) + "\n")

print(f"Migrated legacy/past-deployment data into {target} ({added} new rows, {len(merged)} total).")
PYEOF
