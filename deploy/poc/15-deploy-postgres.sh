#!/usr/bin/env bash
# =============================================================================
# 15-deploy-postgres.sh — deploy a PERSISTENT PostgreSQL for Vosj pg mode.
#
# Runs BETWEEN stage 10 (build) and stage 20 (deploy Vosj), and ONLY when
# VOSJ_STATE_STORE=pg. In memory mode it is a clean no-op (Vosj keeps using the
# in-memory StateStore — no DB at all).
#
#   1. ensure the vosj namespace.
#   2. SINGLE-SOURCE the PG password: ensure the FAIL-CLOSED Secret
#      ($VOSJ_SECRET_NAME) exists and carries a PG_PASSWORD key. This is the SAME
#      Secret 20-deploy-vosj.sh references — so Postgres (POSTGRES_PASSWORD) and
#      Vosj (PG_PASSWORD) read the identical generated password. If the Secret
#      already exists we PRESERVE it (never rotate a live ledger/PG key); if it is
#      missing entirely we create it here with all four generated keys so a
#      pg-mode run that starts at stage 15 still has a coherent Secret.
#   3. envsubst postgres.yaml -> a single-PVC StatefulSet + ClusterIP Service
#      ($PG_SERVICE), then apply. Idempotent.
#   4. wait for Postgres Ready (rollout + pg_isready).
#
# ONE PVC ONLY. The platform CSI hazard is MANY simultaneous per-pod PVC attaches
# (a fleet-wide roll wedged the disk CSI once); a single long-lived Postgres PVC
# is the supported pattern. Devstations stay emptyDir / NO-PVC.
#
# Uses KUBECONFIG=deploy/poc/.kube/vosj-poc.config via the kc wrapper.
# =============================================================================
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SELF_DIR/lib.sh"
load_config

banner "STAGE 15 — deploy PostgreSQL : svc '$PG_SERVICE' -> ns '$NAMESPACE_VOSJ'"

# --- memory mode: clean skip --------------------------------------------------
if [ "${VOSJ_STATE_STORE:-memory}" != "pg" ]; then
  log_info "VOSJ_STATE_STORE='${VOSJ_STATE_STORE:-memory}' (not 'pg') — skipping Postgres deploy"
  log_ok "STAGE 15 skipped — memory mode uses the in-memory StateStore (no DB)"
  exit 0
fi

require_cmd "kubectl" "${KUBECTL_BIN:-kubectl}"
require_kubeconfig

if ! command -v envsubst >/dev/null 2>&1; then
  log_err "envsubst not found (provided by gettext) — required to render postgres.yaml"
  exit 1
fi

MANIFEST="$POC_DIR/postgres.yaml"
[ -f "$MANIFEST" ] || { log_err "manifest not found: $MANIFEST"; exit 1; }

ensure_namespace "$NAMESPACE_VOSJ"

# --- single-sourced PG password (via the fail-closed Secret) ------------------
# The Secret is the single source of truth for PG_PASSWORD. Postgres sources
# POSTGRES_PASSWORD from it (secretKeyRef in postgres.yaml) and Vosj sources
# PG_PASSWORD from it (chart env helper) — same Secret, same key, same value.
if kc -n "$NAMESPACE_VOSJ" get secret "$VOSJ_SECRET_NAME" >/dev/null 2>&1; then
  log_ok "secret '$VOSJ_SECRET_NAME' already present — preserving PG_PASSWORD (no rotation)"
  # Defensive: a pre-existing Secret created in a previous memory-mode run already
  # carries a PG_PASSWORD placeholder, so nothing to add. If somehow absent, fail
  # closed rather than silently deploying Postgres with an empty password.
  if ! kc -n "$NAMESPACE_VOSJ" get secret "$VOSJ_SECRET_NAME" \
        -o jsonpath='{.data.PG_PASSWORD}' 2>/dev/null | grep -q .; then
    log_err "secret '$VOSJ_SECRET_NAME' exists but has no PG_PASSWORD key — refusing to deploy Postgres without a password"
    log_err "delete the secret and re-run, or add a PG_PASSWORD key, then retry"
    exit 1
  fi
else
  log_info "secret '$VOSJ_SECRET_NAME' absent — creating fail-closed Secret with generated keys (incl. PG_PASSWORD)"
  LEDGER_KEY="$(gen_secret)"
  VAULT_KEY="$(gen_secret)"
  AUTH_TOKEN="$(gen_secret)"
  PG_PASSWORD="$(gen_secret)"

  kc -n "$NAMESPACE_VOSJ" create secret generic "$VOSJ_SECRET_NAME" \
    --from-literal=VOSJ_LEDGER_HMAC_KEY="$LEDGER_KEY" \
    --from-literal=VOSJ_VAULT_MASTER_KEY="$VAULT_KEY" \
    --from-literal=VOSJ_AUTH_TOKEN="$AUTH_TOKEN" \
    --from-literal=PG_PASSWORD="$PG_PASSWORD"
  log_ok "created fail-closed Secret '$VOSJ_SECRET_NAME' (PG_PASSWORD single-sourced for both Postgres and Vosj)"

  # Stash the auth token locally (gitignored) so 40-verify.sh can call the
  # token-gated /api/templates without re-reading the cluster Secret — mirrors 20.
  printf '%s' "$AUTH_TOKEN" > "$POC_DIR/.kube/vosj-auth-token"
  chmod 600 "$POC_DIR/.kube/vosj-auth-token" 2>/dev/null || true
fi

# --- render + apply the Postgres manifest -------------------------------------
log_info "deploying PostgreSQL"
log_info "  service   : $PG_SERVICE (port $PG_PORT) in ns '$NAMESPACE_VOSJ'"
log_info "  image     : $PG_IMAGE"
log_info "  database  : $PG_DATABASE   user: $PG_USER"
log_info "  storage   : $PG_STORAGE (ONE PVC, default storageClass)"
log_info "  password  : sourced from Secret '$VOSJ_SECRET_NAME' key PG_PASSWORD (single-sourced)"

NAMESPACE_VOSJ="$NAMESPACE_VOSJ" \
PG_SERVICE="$PG_SERVICE" \
PG_PORT="$PG_PORT" \
PG_USER="$PG_USER" \
PG_DATABASE="$PG_DATABASE" \
VOSJ_SECRET_NAME="$VOSJ_SECRET_NAME" \
PG_IMAGE="$PG_IMAGE" \
PG_STORAGE="$PG_STORAGE" \
PG_CPU_REQUEST="$PG_CPU_REQUEST" \
PG_CPU_LIMIT="$PG_CPU_LIMIT" \
PG_MEM_REQUEST="$PG_MEM_REQUEST" \
PG_MEM_LIMIT="$PG_MEM_LIMIT" \
  envsubst < "$MANIFEST" | kc -n "$NAMESPACE_VOSJ" apply -f -

# --- wait for Postgres Ready --------------------------------------------------
log_info "waiting for StatefulSet '$PG_SERVICE' rollout"
if ! kc -n "$NAMESPACE_VOSJ" rollout status "statefulset/$PG_SERVICE" \
       --timeout "${ROLLOUT_TIMEOUT}s"; then
  log_err "Postgres StatefulSet '$PG_SERVICE' did not become ready"
  kc -n "$NAMESPACE_VOSJ" get pods -l "app.kubernetes.io/instance=$PG_SERVICE" -o wide || true
  kc -n "$NAMESPACE_VOSJ" describe statefulset "$PG_SERVICE" | tail -30 || true
  exit 1
fi

# Belt-and-suspenders: confirm pg_isready inside the pod (the readiness probe
# already gates this, but an explicit check makes the stage log self-evident).
log_info "confirming pg_isready in pod '${PG_SERVICE}-0'"
if kc -n "$NAMESPACE_VOSJ" exec "${PG_SERVICE}-0" -- \
     pg_isready -U "$PG_USER" -d "$PG_DATABASE" -h 127.0.0.1 >/dev/null 2>&1; then
  log_ok "Postgres accepting connections (pg_isready OK)"
else
  log_warn "pg_isready check inconclusive (pod Ready per probe, but exec check non-zero) — continuing"
fi

kc -n "$NAMESPACE_VOSJ" get statefulset,pods,svc,pvc -l "app.kubernetes.io/name=vosj-postgres" -o wide || true
log_ok "STAGE 15 complete — PostgreSQL '$PG_SERVICE' running in '$NAMESPACE_VOSJ' (1 PVC, persistent)"
