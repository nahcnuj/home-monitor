#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

git config user.name "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"

git fetch origin master gh-pages

needs_reset=false
if ! git rev-parse --verify origin/gh-pages >/dev/null 2>&1; then
  needs_reset=true
elif ! git ls-tree -r --name-only origin/gh-pages | grep -q '^dashboard/'; then
  echo "gh-pages is not source-shaped; recreating from master"
  needs_reset=true
fi

if $needs_reset; then
  git checkout -B gh-pages origin/master
else
  git checkout -B gh-pages origin/gh-pages
  git merge origin/master --no-edit -m "merge master into gh-pages"
fi

if git rev-parse --verify origin/gh-pages >/dev/null 2>&1 && git diff --quiet origin/gh-pages..gh-pages; then
  echo "gh-pages already up to date"
  exit 0
fi

if $needs_reset; then
  git push origin gh-pages --force-with-lease
else
  git push origin gh-pages
fi