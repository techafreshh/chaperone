#!/usr/bin/env bash
# Provision locked agent sub-accounts and register them on the guard.
# See scripts/README.md and the companion scripts/provision-agents.mjs.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is required on PATH" >&2
  exit 2
fi

exec node "$SCRIPT_DIR/provision-agents.mjs" "$@"
