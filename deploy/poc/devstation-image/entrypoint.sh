#!/bin/sh
# devstation entrypoint — apply the seat's EXTENSION POLICY, then hand off to the
# upstream code-server entrypoint.
#
# Extensions come from CODE_SERVER_EXTENSIONS (comma-separated publisher.name@version)
# written into the seat's -env Secret by the Seat Manager's "Push". They install
# from OPEN VSX (code-server's default registry) — license-clean only; the policy
# never contains Marketplace-only / paid items (e.g. Copilot), so we never repoint
# the gallery (which would violate the MS Marketplace ToU).
#
# Best-effort + NON-FATAL: a missing/failed Open-VSX item must never wedge the seat.
# Ephemeral by design: /home/coder/.local is emptyDir, so this re-installs on every
# boot (correct — no per-pod PVC, honours the platform CSI rule).
set -u

exts="${CODE_SERVER_EXTENSIONS:-}"
if [ -n "$exts" ]; then
  # Install in the BACKGROUND so code-server starts immediately — a multi-extension
  # install must NOT block startup or the liveness/readiness probes would kill the
  # pod mid-install. The extensions appear after a browser reload once installed.
  (
    echo "[devstation] applying extension policy (tier=${VOSJ_SEAT_TIER:-none} policy=v${CODE_SERVER_EXT_POLICY_VERSION:-0})"
    OLD_IFS="$IFS"
    IFS=','
    for id in $exts; do
      id=$(printf '%s' "$id" | tr -d ' \t\r')
      [ -z "$id" ] && continue
      echo "[devstation] code-server --install-extension $id"
      code-server --install-extension "$id" --force || echo "[devstation] WARN install failed (continuing): $id"
    done
    IFS="$OLD_IFS"
    echo "[devstation] extension policy applied"
  ) &
fi

# Hand off to the upstream code-server entrypoint, preserving the Deployment args
# (--bind-addr, /home/coder/project, PASSWORD handling, etc.).
if [ -x /usr/bin/entrypoint.sh ]; then
  exec /usr/bin/entrypoint.sh "$@"
fi
exec code-server "$@"
