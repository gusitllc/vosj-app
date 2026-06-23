#!/usr/bin/env bash
# =============================================================================
# 50-deploy-seat-manager.sh — deploy the Seat Manager console FROM CODE.
#
#   1. ensure the devstations namespace (the Seat Manager lives WITH the seats so
#      its Role can be namespace-scoped to least privilege).
#   2. create the out-of-band Secret `seat-manager-admin` with a freshly generated
#      SEAT_MANAGER_ADMIN_KEY (`openssl rand -hex 24`). Idempotent: an existing key
#      is PRESERVED across re-runs (we never rotate a live admin key by accident).
#      The plaintext key is ALSO stashed to deploy/poc/.kube/seat-manager-admin-key
#      (gitignored, chmod 600) so the operator can read it without touching the
#      cluster Secret.
#   3. envsubst seat-manager/k8s.yaml (ServiceAccount + least-priv Role/Binding +
#      Deployment + Service) and apply it.
#   4. wait for the rollout, then print the admin-key location + access details.
#
# Config (from config.env): SEAT_MANAGER_IMAGE, ACR_PULL_SECRET, NAMESPACE_DEV,
# DEVSTATION_COUNT. SEAT_MANAGER_IMAGE defaults to ${ACR}.azurecr.io/vosj-seat-manager:poc.
# NO secret is stored in config.env — the admin key is generated here.
# =============================================================================
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SELF_DIR/lib.sh"
load_config

# Defaults for the integrator-supplied config (referenced even if config.env has
# not yet added them). The image defaults to the conventional ACR repository.
SEAT_MANAGER_IMAGE="${SEAT_MANAGER_IMAGE:-${ACR}.azurecr.io/vosj-seat-manager:poc}"
SEAT_MANAGER_ADMIN_SECRET="seat-manager-admin"
ADMIN_KEY_FILE="$POC_DIR/.kube/seat-manager-admin-key"

banner "STAGE 50 — deploy Seat Manager : ns '$NAMESPACE_DEV' (image ${SEAT_MANAGER_IMAGE})"

require_cmd "kubectl" "${KUBECTL_BIN:-kubectl}"
require_kubeconfig

if ! command -v envsubst >/dev/null 2>&1; then
  log_err "envsubst not found (provided by gettext) — required to render k8s.yaml"
  exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
  log_err "openssl not found — cannot generate the fail-closed admin key"
  exit 1
fi

MANIFEST="$SELF_DIR/seat-manager/k8s.yaml"
[ -f "$MANIFEST" ] || { log_err "manifest not found: $MANIFEST"; exit 1; }

ensure_namespace "$NAMESPACE_DEV"

# --- admin-key Secret (out-of-band, generated, preserved on re-run) -----------
# If the Secret already exists, keep it (a re-run must NOT rotate the live admin
# key). Only generate + create when absent. We also refresh the local stash from
# the cluster Secret so the operator always has the current key on disk.
if kc -n "$NAMESPACE_DEV" get secret "$SEAT_MANAGER_ADMIN_SECRET" >/dev/null 2>&1; then
  log_ok "secret '$SEAT_MANAGER_ADMIN_SECRET' already present — preserving admin key"
  EXISTING="$(kc -n "$NAMESPACE_DEV" get secret "$SEAT_MANAGER_ADMIN_SECRET" \
    -o jsonpath='{.data.SEAT_MANAGER_ADMIN_KEY}' 2>/dev/null | base64 -d 2>/dev/null || true)"
  if [ -n "$EXISTING" ]; then
    printf '%s' "$EXISTING" > "$ADMIN_KEY_FILE"
    chmod 600 "$ADMIN_KEY_FILE" 2>/dev/null || true
  fi
else
  log_info "generating admin key (openssl rand -hex 24) and creating Secret '$SEAT_MANAGER_ADMIN_SECRET'"
  ADMIN_KEY="$(openssl rand -hex 24)"
  kc -n "$NAMESPACE_DEV" create secret generic "$SEAT_MANAGER_ADMIN_SECRET" \
    --from-literal=SEAT_MANAGER_ADMIN_KEY="$ADMIN_KEY"
  log_ok "created admin Secret '$SEAT_MANAGER_ADMIN_SECRET'"
  # Stash the plaintext locally (gitignored, .kube/ is in .gitignore) chmod 600.
  printf '%s' "$ADMIN_KEY" > "$ADMIN_KEY_FILE"
  chmod 600 "$ADMIN_KEY_FILE" 2>/dev/null || true
fi

# --- render + apply the manifest ----------------------------------------------
# When ACR_PULL_SECRET is empty (cluster has ACR attached via managed identity),
# strip the imagePullSecrets block entirely — an empty `- name:` is invalid and
# some admission webhooks reject it. Matches the sibling scripts' skip-when-empty
# posture (20-deploy-vosj.sh only sets the pull secret when non-empty).
log_info "rendering + applying Seat Manager manifest"
STRIP_PULL='cat'
if [ -z "${ACR_PULL_SECRET:-}" ]; then
  log_info "ACR_PULL_SECRET empty — omitting imagePullSecrets (relying on cluster ACR attach / node identity)"
  STRIP_PULL='sed /imagePullSecrets:/,+1d'
fi
NAMESPACE_DEV="$NAMESPACE_DEV" \
SEAT_MANAGER_IMAGE="$SEAT_MANAGER_IMAGE" \
ACR_PULL_SECRET="${ACR_PULL_SECRET:-}" \
DEVSTATION_COUNT="$DEVSTATION_COUNT" \
  envsubst < "$MANIFEST" | $STRIP_PULL | kc apply -f -

# --- wait for rollout ---------------------------------------------------------
log_info "waiting for seat-manager to become Ready"
if kc -n "$NAMESPACE_DEV" rollout status "deployment/seat-manager" \
     --timeout "${ROLLOUT_TIMEOUT}s"; then
  log_ok "seat-manager ready"
else
  log_err "seat-manager did not become ready"
  kc -n "$NAMESPACE_DEV" get pods -l "app.kubernetes.io/instance=seat-manager" -o wide || true
  exit 1
fi

kc -n "$NAMESPACE_DEV" get deploy,pods,svc -l "app.kubernetes.io/instance=seat-manager" -o wide || true

# --- access details -----------------------------------------------------------
banner "SEAT MANAGER — ACCESS"
cat <<EOF
Admin key (paste into the console's "Admin key" field):
  $ADMIN_KEY_FILE      (chmod 600, gitignored)
  # or read it from the cluster:
  kubectl --kubeconfig "$KUBECONFIG_PATH" -n $NAMESPACE_DEV \\
    get secret $SEAT_MANAGER_ADMIN_SECRET -o jsonpath='{.data.SEAT_MANAGER_ADMIN_KEY}' | base64 -d

Open the console (port-forward, then browse):
  kubectl --kubeconfig "$KUBECONFIG_PATH" -n $NAMESPACE_DEV port-forward svc/seat-manager 8090:80
  # then open http://127.0.0.1:8090/
EOF

log_ok "STAGE 50 complete — Seat Manager deployed to '$NAMESPACE_DEV'"
