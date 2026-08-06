#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

version="$(node -p "JSON.parse(require('fs').readFileSync('package.json','utf8')).version")"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
name="golden-bridge-${version}-${stamp}"
out="dist/${name}.tar.gz"

mkdir -p dist
npm test
node scripts/preflight.js auto

tar \
  --exclude './node_modules' \
  --exclude './logs' \
  --exclude './runtime' \
  --exclude './dist' \
  --exclude './.git' \
  -czf "$out" .

shasum -a 256 "$out" > "${out}.sha256"
echo "$out"
cat "${out}.sha256"
