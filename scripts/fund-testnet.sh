#!/usr/bin/env bash
# Testnet funding: tops up fleet agents below threshold via faucet, falling
# back to a signer transfer. No-op SKIP without credentials.
# See scripts/README.md and scripts/fund-testnet.mjs.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is required on PATH" >&2
  exit 2
fi

exec node "$SCRIPT_DIR/fund-testnet.mjs" "$@"
