#!/usr/bin/env bash
# =============================================================================
# 30-deploy-devstations.sh — deploy DEVSTATION_COUNT devstations FROM CODE.
#
#   1. ensure the devstations namespace
#   2. per seat: generate a CODE_SERVER_PASSWORD (openssl), create a per-seat
#      Secret (+ optional CLAUDE_CODE_OAUTH_TOKEN from config.env), then envsubst
#      devstation.yaml and apply it.
#   3. wait for each Deployment to become Available.
#
# EPHEMERAL by design: devstation.yaml uses emptyDir only — NO per-pod PVC.
# Secrets are generated, never stored in config.env. Idempotent: existing per-seat
# Secrets are preserved (password stays stable across re-applies).
# =============================================================================
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SELF_DIR/lib.sh"
load_config

banner "STAGE 30 — deploy devstations : $DEVSTATION_COUNT seat(s) -> ns '$NAMESPACE_DEV'"

require_cmd "kubectl" "${KUBECTL_BIN:-kubectl}"
require_kubeconfig

if ! command -v envsubst >/dev/null 2>&1; then
  log_err "envsubst not found (provided by gettext) — required to render devstation.yaml"
  exit 1
fi

MANIFEST="$POC_DIR/devstation.yaml"
[ -f "$MANIFEST" ] || { log_err "manifest not found: $MANIFEST"; exit 1; }

ensure_namespace "$NAMESPACE_DEV"

if [ "$DEVSTATION_COUNT" -lt 1 ] 2>/dev/null; then
  log_warn "DEVSTATION_COUNT=$DEVSTATION_COUNT (<1) — nothing to deploy"
  exit 0
fi

deploy_seat() {
  local idx="$1"
  local name="devstation-${idx}"
  local secret="${name}-secret"

  log_info "--- seat $idx : $name ---"

  # Per-seat Secret — create only when absent (keep password stable on re-run).
  if kc -n "$NAMESPACE_DEV" get secret "$secret" >/dev/null 2>&1; then
    log_ok "secret '$secret' already present — preserving"
  else
    local pw
    pw="$(gen_secret)"
    log_info "creating per-seat Secret '$secret' (generated CODE_SERVER_PASSWORD)"
    # CLAUDE_CODE_OAUTH_TOKEN may be empty (optional in the manifest).
    kc -n "$NAMESPACE_DEV" create secret generic "$secret" \
      --from-literal=CODE_SERVER_PASSWORD="$pw" \
      --from-literal=CLAUDE_CODE_OAUTH_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN:-}"
  fi

  # Render the manifest for this seat and apply it.
  log_info "rendering + applying manifest for $name"
  DEVSTATION_NAME="$name" \
  DEVSTATION_SECRET="$secret" \
  NAMESPACE_DEV="$NAMESPACE_DEV" \
  DEVSTATION_IMAGE="$DEVSTATION_IMAGE" \
  DEVSTATION_PORT="$DEVSTATION_PORT" \
  DEVSTATION_CPU_REQUEST="$DEVSTATION_CPU_REQUEST" \
  DEVSTATION_CPU_LIMIT="$DEVSTATION_CPU_LIMIT" \
  DEVSTATION_MEM_REQUEST="$DEVSTATION_MEM_REQUEST" \
  DEVSTATION_MEM_LIMIT="$DEVSTATION_MEM_LIMIT" \
    envsubst < "$MANIFEST" | kc apply -f -
}

for i in $(seq 1 "$DEVSTATION_COUNT"); do
  deploy_seat "$i"
done

# Wait for each Deployment to become Available.
log_info "waiting for devstations to become Ready"
for i in $(seq 1 "$DEVSTATION_COUNT"); do
  name="devstation-${i}"
  if kc -n "$NAMESPACE_DEV" rollout status "deployment/$name" \
       --timeout "${ROLLOUT_TIMEOUT}s"; then
    log_ok "$name ready"
  else
    log_err "$name did not become ready"
    kc -n "$NAMESPACE_DEV" get pods -l "app.kubernetes.io/instance=$name" -o wide || true
    exit 1
  fi
done

kc -n "$NAMESPACE_DEV" get deploy,pods,svc -o wide || true
log_ok "STAGE 30 complete — $DEVSTATION_COUNT devstation(s) running in '$NAMESPACE_DEV'"
