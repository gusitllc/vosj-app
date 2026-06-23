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

# --- ACR pull secret (private devstation image) ------------------------------
# The fleet devstation image lives in the private ACR, so this namespace needs a
# docker-registry secret to pull it (pull secrets are namespace-scoped — the one
# 20-deploy-vosj.sh minted lives in the vosj namespace, not here). Idempotent;
# degrades to a warning if ACR admin creds are unavailable.
if [ -n "${ACR_PULL_SECRET:-}" ]; then
  if kc -n "$NAMESPACE_DEV" get secret "$ACR_PULL_SECRET" >/dev/null 2>&1; then
    log_ok "ACR pull secret '$ACR_PULL_SECRET' already present in '$NAMESPACE_DEV'"
  else
    log_info "creating ACR pull secret '$ACR_PULL_SECRET' in '$NAMESPACE_DEV' for ${ACR}.azurecr.io"
    _au="$("${AZ_BIN:-az}" acr credential show -n "$ACR" --query username -o tsv 2>/dev/null | tr -d '\r' || true)"
    _ap="$("${AZ_BIN:-az}" acr credential show -n "$ACR" --query 'passwords[0].value' -o tsv 2>/dev/null | tr -d '\r' || true)"
    if [ -n "$_au" ] && [ -n "$_ap" ]; then
      kc -n "$NAMESPACE_DEV" create secret docker-registry "$ACR_PULL_SECRET" \
        --docker-server="${ACR}.azurecr.io" --docker-username="$_au" --docker-password="$_ap" >/dev/null
      log_ok "created ACR pull secret '$ACR_PULL_SECRET' in '$NAMESPACE_DEV'"
    else
      log_warn "ACR admin creds unavailable — devstation image pull may ImagePullBackOff"
    fi
  fi
fi

if [ "$DEVSTATION_COUNT" -lt 1 ] 2>/dev/null; then
  log_warn "DEVSTATION_COUNT=$DEVSTATION_COUNT (<1) — nothing to deploy"
  exit 0
fi

deploy_seat() {
  local idx="$1"
  local name="devstation-${idx}"
  # '-env' (NOT '-secret'): mirrors the live fleet's devstation-<persona>-env and is
  # the Secret the Seat Manager website patches to assign a credential per seat.
  local secret="${name}-env"

  log_info "--- seat $idx : $name ---"

  # Per-seat -env Secret — create only when absent (keep password stable on re-run;
  # NEVER clobber a credential the Seat Manager has since assigned). A fresh seat is
  # "empty": worker OFF, mode unassigned, both credential keys blank. The Seat
  # Manager later sets CLAUDE_CODE_OAUTH_TOKEN (Hybrid) or ANTHROPIC_API_KEY (AI-only).
  if kc -n "$NAMESPACE_DEV" get secret "$secret" >/dev/null 2>&1; then
    log_ok "secret '$secret' already present — preserving (may hold an assigned credential)"
  else
    local pw
    pw="$(gen_secret)"
    log_info "creating per-seat -env Secret '$secret' (generated CODE_SERVER_PASSWORD, no credential yet)"
    kc -n "$NAMESPACE_DEV" create secret generic "$secret" \
      --from-literal=CODE_SERVER_PASSWORD="$pw" \
      --from-literal=PASSWORD="$pw" \
      --from-literal=DEVSTATION_NAME="$name" \
      --from-literal=DEVSTATION_WORKER_ENABLED="false" \
      --from-literal=VOSJ_SEAT_MODE="unassigned" \
      --from-literal=CLAUDE_MODEL="${DEVSTATION_CLAUDE_MODEL:-opus}" \
      --from-literal=CLAUDE_FALLBACK_MODEL="${DEVSTATION_CLAUDE_FALLBACK_MODEL:-sonnet}" \
      --from-literal=CLAUDE_CODE_OAUTH_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN:-}" \
      --from-literal=ANTHROPIC_API_KEY="" \
      --from-literal=VOSJ_SEAT_TIER="none" \
      --from-literal=CODE_SERVER_EXTENSIONS="" \
      --from-literal=CODE_SERVER_EXT_POLICY_VERSION="0"
  fi

  # Render the manifest for this seat and apply it.
  log_info "rendering + applying manifest for $name"
  DEVSTATION_NAME="$name" \
  DEVSTATION_SECRET="$secret" \
  NAMESPACE_DEV="$NAMESPACE_DEV" \
  DEVSTATION_IMAGE="$DEVSTATION_IMAGE" \
  DEVSTATION_PORT="$DEVSTATION_PORT" \
  ACR_PULL_SECRET="${ACR_PULL_SECRET:-vosj-acr-pull}" \
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
