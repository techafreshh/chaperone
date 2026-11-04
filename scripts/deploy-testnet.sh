#!/usr/bin/env bash
# Testnet deploy: builds the guard WASM, deploys it, seeds books and
# provisions the fleet — or prints that exact sequence without touching
# anything. See scripts/README.md and scripts/deploy-testnet.mjs.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is required on PATH" >&2
  exit 2
fi

exec node "$SCRIPT_DIR/deploy-testnet.mjs" "$@"
