#!/usr/bin/env bash
# =============================================================================
# 20-deploy-vosj.sh — deploy Vosj CE onto the POC cluster FROM CODE.
#
#   1. ensure the vosj namespace
#   2. create the FAIL-CLOSED Secret out-of-band with freshly generated keys
#      (VOSJ_LEDGER_HMAC_KEY / VOSJ_VAULT_MASTER_KEY / VOSJ_AUTH_TOKEN via
#      `openssl rand -hex 32`) — secrets NEVER live in config.env or values.yaml.
#      Idempotent: existing keys are preserved across re-runs (we never rotate a
#      live ledger key by accident).
#   3. helm upgrade --install referencing that existing secret, in memory store
#      mode (POC default — no DB required).
#   4. wait for rollout.
#
# Uses KUBECONFIG=deploy/poc/.kube/vosj-poc.config via the kc/hm wrappers.
# =============================================================================
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SELF_DIR/lib.sh"
load_config

banner "STAGE 20 — deploy Vosj : release '$VOSJ_RELEASE' -> ns '$NAMESPACE_VOSJ'"

require_cmd "kubectl" "${KUBECTL_BIN:-kubectl}"
require_cmd "helm" "${HELM_BIN:-helm}"
require_kubeconfig

CHART_DIR="$REPO_ROOT/deploy/helm/vosj"
if [ ! -f "$CHART_DIR/Chart.yaml" ]; then
  log_err "helm chart not found: $CHART_DIR"
  exit 1
fi

ensure_namespace "$NAMESPACE_VOSJ"

# --- fail-closed Secret (out-of-band, generated) ------------------------------
# If the Secret already exists, keep it (a re-run must NOT rotate the ledger HMAC
# key — that would make the existing chain unverifiable). Only create when absent.
if kc -n "$NAMESPACE_VOSJ" get secret "$VOSJ_SECRET_NAME" >/dev/null 2>&1; then
  log_ok "secret '$VOSJ_SECRET_NAME' already present in '$NAMESPACE_VOSJ' — preserving keys"
else
  log_info "generating fail-closed secrets (openssl rand -hex 32) and creating Secret"
  LEDGER_KEY="$(gen_secret)"
  VAULT_KEY="$(gen_secret)"
  AUTH_TOKEN="$(gen_secret)"
  # PG password placeholder — unused in memory mode, but the chart's env wiring
  # references the key, so we supply a non-empty value to keep the pod schedulable.
  PG_PASSWORD="$(gen_secret)"

  kc -n "$NAMESPACE_VOSJ" create secret generic "$VOSJ_SECRET_NAME" \
    --from-literal=VOSJ_LEDGER_HMAC_KEY="$LEDGER_KEY" \
    --from-literal=VOSJ_VAULT_MASTER_KEY="$VAULT_KEY" \
    --from-literal=VOSJ_AUTH_TOKEN="$AUTH_TOKEN" \
    --from-literal=PG_PASSWORD="$PG_PASSWORD"
  log_ok "created fail-closed Secret '$VOSJ_SECRET_NAME'"

  # Stash the auth token locally (gitignored) so 40-verify.sh can call the
  # token-gated /api/templates without re-reading the cluster Secret.
  printf '%s' "$AUTH_TOKEN" > "$POC_DIR/.kube/vosj-auth-token"
  chmod 600 "$POC_DIR/.kube/vosj-auth-token" 2>/dev/null || true
fi

# --- ACR pull secret (private registry) ---------------------------------------
# The chart references .Values.imagePullSecrets; the cluster needs a docker-registry
# secret to pull from the private ACR. Idempotent; degrades gracefully if the ACR
# has no admin creds (then rely on a cluster ACR-attach / node identity).
PULL_SET=()
if [ -n "${ACR_PULL_SECRET:-}" ]; then
  if kc -n "$NAMESPACE_VOSJ" get secret "$ACR_PULL_SECRET" >/dev/null 2>&1; then
    log_ok "ACR pull secret '$ACR_PULL_SECRET' already present"
  else
    log_info "creating ACR pull secret '$ACR_PULL_SECRET' for ${ACR}.azurecr.io"
    _au="$("${AZ_BIN:-az}" acr credential show -n "$ACR" --query username -o tsv 2>/dev/null || true)"
    _ap="$("${AZ_BIN:-az}" acr credential show -n "$ACR" --query 'passwords[0].value' -o tsv 2>/dev/null || true)"
    if [ -n "$_au" ] && [ -n "$_ap" ]; then
      kc -n "$NAMESPACE_VOSJ" create secret docker-registry "$ACR_PULL_SECRET" \
        --docker-server="${ACR}.azurecr.io" --docker-username="$_au" --docker-password="$_ap" >/dev/null
      log_ok "created ACR pull secret '$ACR_PULL_SECRET'"
    else
      log_warn "ACR admin creds unavailable — skipping pull secret (relying on cluster ACR attach / node identity)"
      ACR_PULL_SECRET=""
    fi
  fi
  [ -n "$ACR_PULL_SECRET" ] && PULL_SET=(--set "imagePullSecrets[0].name=$ACR_PULL_SECRET")
fi

# --- helm upgrade --install ---------------------------------------------------
log_info "deploying chart $CHART_DIR"
log_info "  image      : ${IMAGE_REPOSITORY}:${IMAGE_TAG}"
log_info "  stateStore : $VOSJ_STATE_STORE"
log_info "  replicas   : $VOSJ_REPLICAS"
log_info "  secret     : existing '$VOSJ_SECRET_NAME' (fail-closed, out-of-band)"

hm upgrade --install "$VOSJ_RELEASE" "$CHART_DIR" \
  --namespace "$NAMESPACE_VOSJ" \
  --set image.repository="$IMAGE_REPOSITORY" \
  --set image.tag="$IMAGE_TAG" \
  --set image.pullPolicy=Always \
  --set replicaCount="$VOSJ_REPLICAS" \
  --set config.stateStore="$VOSJ_STATE_STORE" \
  --set secret.create=false \
  --set secret.existingSecret="$VOSJ_SECRET_NAME" \
  "${PULL_SET[@]}" \
  --wait --timeout "${ROLLOUT_TIMEOUT}s"

log_info "rollout status:"
kc -n "$NAMESPACE_VOSJ" rollout status "deployment/$VOSJ_RELEASE" \
  --timeout "${ROLLOUT_TIMEOUT}s" || {
    log_err "vosj rollout did not complete"
    kc -n "$NAMESPACE_VOSJ" get pods -o wide || true
    exit 1
  }

kc -n "$NAMESPACE_VOSJ" get pods,svc -o wide || true
log_ok "STAGE 20 complete — Vosj deployed to '$NAMESPACE_VOSJ'"
