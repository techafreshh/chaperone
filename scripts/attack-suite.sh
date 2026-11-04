#!/usr/bin/env bash
# Attack suite one-command replay: provisions fixtures, fires 3 blocked
# attacks plus 1 clean transit, prints per-gate pass/fail.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is required on PATH" >&2
  exit 2
fi

exec node "$SCRIPT_DIR/attack-suite.mjs" "$@"
