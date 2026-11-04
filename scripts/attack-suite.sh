#!/usr/bin/env bash
# Attack suite: builds/starts the real app and asserts the live HTTP gates
# (health, fleet, requests, queue, receipts, CSV export) plus cargo tests on
# every run; chain gates (3 blocked attacks + 1 clean transit) run only when
# testnet credentials are present, otherwise they print SKIP and exit 0.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is required on PATH" >&2
  exit 2
fi

exec node "$SCRIPT_DIR/attack-suite.mjs" "$@"
