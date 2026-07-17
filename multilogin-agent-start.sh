#!/usr/bin/env bash
set -Eeuo pipefail

if [[ -z "${MULTILOGIN_AGENT_TOKEN:-}" ]]; then
  echo "[multilogin-agent] disabled: set MULTILOGIN_AGENT_TOKEN to enable the private API"
  exec sleep infinity
fi

RUNTIME_USER="${RDP_USER:-railway}"
if ! id "${RUNTIME_USER}" >/dev/null 2>&1; then
  echo "[multilogin-agent] runtime user does not exist: ${RUNTIME_USER}" >&2
  exit 1
fi

HOME_DIR="$(getent passwd "${RUNTIME_USER}" | cut -d: -f6)"
exec /usr/sbin/runuser -u "${RUNTIME_USER}" -m -- \
  /usr/bin/env HOME="${HOME_DIR}" \
  /usr/local/bin/node /opt/multilogin-agent/src/index.js
