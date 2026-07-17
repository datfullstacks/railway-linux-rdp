#!/usr/bin/env bash
# railway-mimic-wrapper
set -Eeuo pipefail

WRAPPER_PATH="$(readlink -f -- "$0")"
REAL_BROWSER="${WRAPPER_PATH}.rdp-real"

if [[ ! -x "$REAL_BROWSER" ]]; then
  echo "Mimic browser binary is missing: $REAL_BROWSER" >&2
  exit 1
fi

exec "$REAL_BROWSER" \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  "$@"
