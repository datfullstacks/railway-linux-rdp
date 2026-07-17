#!/usr/bin/env bash
set -Eeuo pipefail

RDP_USER="${RDP_USER:-railway}"

if [[ ! "$RDP_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]]; then
  echo "RDP_USER must be a valid lowercase Linux username (maximum 32 characters)." >&2
  exit 1
fi

if [[ -z "${RDP_PASSWORD:-}" ]]; then
  echo "RDP_PASSWORD is required. Add it as a Railway variable." >&2
  exit 1
fi

if (( ${#RDP_PASSWORD} < 10 )); then
  echo "RDP_PASSWORD must contain at least 10 characters." >&2
  exit 1
fi

if [[ "$RDP_PASSWORD" == *:* || "$RDP_PASSWORD" == *$'\n'* ]]; then
  echo "RDP_PASSWORD cannot contain a colon or newline." >&2
  exit 1
fi

if ! id "$RDP_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$RDP_USER"
fi

printf '%s:%s\n' "$RDP_USER" "$RDP_PASSWORD" | chpasswd
usermod -aG sudo "$RDP_USER"
printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$RDP_USER" > "/etc/sudoers.d/$RDP_USER"
chmod 0440 "/etc/sudoers.d/$RDP_USER"

HOME_DIR="$(getent passwd "$RDP_USER" | cut -d: -f6)"
mkdir -p "$HOME_DIR" /run/xrdp /var/log/xrdp
printf '%s\n' 'startxfce4' > "$HOME_DIR/.xsession"
chown -R "$RDP_USER:$RDP_USER" "$HOME_DIR"
chmod 0700 "$HOME_DIR"

exec /usr/bin/supervisord -n -c /etc/supervisor/supervisord.conf

