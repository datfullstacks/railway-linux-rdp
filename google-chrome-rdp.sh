#!/usr/bin/env bash
set -Eeuo pipefail

exec /usr/bin/google-chrome-stable \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  "$@"
