#!/usr/bin/env bash
set -Eeuo pipefail

RDP_USER="${RDP_USER:-railway}"
WRAPPER_TEMPLATE=/usr/local/libexec/mimic-chrome-wrapper
POLL_SECONDS="${MIMIC_WRAPPER_POLL_SECONDS:-1}"

if ! [[ "$POLL_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "MIMIC_WRAPPER_POLL_SECONDS must be a positive integer." >&2
  exit 1
fi

HOME_DIR="$(getent passwd "$RDP_USER" | cut -d: -f6)"

if [[ -z "$HOME_DIR" ]]; then
  echo "Cannot find home directory for RDP user: $RDP_USER" >&2
  exit 1
fi

install -d -m 0755 -o "$RDP_USER" -g "$RDP_USER" \
  "$HOME_DIR/mlx" \
  "$HOME_DIR/mlx/custom_extensions" \
  "$HOME_DIR/mlx/custom_extensions/mimic"

declare -A OBSERVED_SIZES=()

while true; do
  shopt -s nullglob

  for browser in "$HOME_DIR"/mlx/deps/mimic_*/chrome; do
    [[ -f "$browser" && -x "$browser" ]] || continue

    real_browser="${browser}.rdp-real"

    if cmp -s -- "$browser" "$WRAPPER_TEMPLATE"; then
      unset "OBSERVED_SIZES[$browser]"
      continue
    fi

    if [[ -x "$real_browser" ]] \
      && grep -q '^# railway-mimic-wrapper$' "$browser" 2>/dev/null; then
      wrapper_tmp="${browser}.rdp-wrapper.$$"
      owner="$(stat -c %u:%g -- "$browser")"
      install -m 0755 -- "$WRAPPER_TEMPLATE" "$wrapper_tmp"
      chown "$owner" "$wrapper_tmp"
      mv -f -- "$wrapper_tmp" "$browser"
      unset "OBSERVED_SIZES[$browser]"
      echo "Updated Multilogin Mimic wrapper: $browser"
      continue
    fi

    magic="$(od -An -tx1 -N4 -- "$browser" 2>/dev/null | tr -d '[:space:]')"
    [[ "$magic" == "7f454c46" ]] || continue

    size="$(stat -c %s -- "$browser")"
    if [[ "${OBSERVED_SIZES[$browser]:-}" != "$size" ]]; then
      OBSERVED_SIZES["$browser"]="$size"
      continue
    fi

    wrapper_tmp="${browser}.rdp-wrapper.$$"
    real_tmp="${real_browser}.tmp.$$"
    owner="$(stat -c %u:%g -- "$browser")"

    ln -- "$browser" "$real_tmp"
    mv -f -- "$real_tmp" "$real_browser"
    install -m 0755 -- "$WRAPPER_TEMPLATE" "$wrapper_tmp"
    chown "$owner" "$wrapper_tmp"
    mv -f -- "$wrapper_tmp" "$browser"

    unset "OBSERVED_SIZES[$browser]"
    echo "Wrapped Multilogin Mimic core: $browser"
  done

  sleep "$POLL_SECONDS"
done
