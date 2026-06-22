#!/usr/bin/env bash
# =============================================================================
# teardown.sh — clean reversal of the POC.
#
#   1. helm uninstall the vosj release
#   2. delete the devstations + vosj namespaces (takes the Secrets/PVC-less pods)
#   3. (optional --delete-cluster) az aksarc/aks delete the cluster
#   4. remove the local kubeconfig + stashed token
#
# Idempotent: missing resources are skipped, not errors. The cluster is only
# deleted when --delete-cluster is given (the POC default keeps it for re-runs).
#
# Flags:
#   --delete-cluster   also delete the AKS / AKS-Arc cluster
#   --target az|...    substrate (for cluster delete); defaults to config.env
#   -y | --yes         non-interactive (skip the confirm prompt)
# =============================================================================
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SELF_DIR/lib.sh"
load_config

DELETE_CLUSTER=0
ASSUME_YES=0
TARGET_OVERRIDE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --delete-cluster) DELETE_CLUSTER=1; shift ;;
    --target) TARGET_OVERRIDE="$2"; shift 2 ;;
    --target=*) TARGET_OVERRIDE="${1#*=}"; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    *) log_warn "ignoring unknown arg: $1"; shift ;;
  esac
done
[ -n "$TARGET_OVERRIDE" ] && export TARGET="$TARGET_OVERRIDE"

banner "TEARDOWN — Vosj POC"
log_info "delete-cluster: $DELETE_CLUSTER   target: $TARGET"

if [ "$ASSUME_YES" -ne 1 ]; then
  printf 'Proceed with teardown? [y/N] '
  read -r ans
  case "$ans" in y|Y|yes|YES) ;; *) log_warn "aborted"; exit 0 ;; esac
fi

# --- app + namespaces (only if kubeconfig present & cluster reachable) --------
if [ -f "$KUBECONFIG_PATH" ] && kc cluster-info >/dev/null 2>&1; then
  if hm -n "$NAMESPACE_VOSJ" status "$VOSJ_RELEASE" >/dev/null 2>&1; then
    log_info "helm uninstall $VOSJ_RELEASE"
    hm -n "$NAMESPACE_VOSJ" uninstall "$VOSJ_RELEASE" || log_warn "helm uninstall failed (continuing)"
  else
    log_info "helm release '$VOSJ_RELEASE' not found — skipping"
  fi

  # In pg mode the persistent Postgres (StatefulSet + its single PVC) lives IN
  # $NAMESPACE_VOSJ, so deleting the namespace cascade-removes the PVC and its
  # data. This is intentional teardown — back up the DB first if you need to keep
  # the migration data beyond the POC.
  if [ "${VOSJ_STATE_STORE:-memory}" = "pg" ]; then
    log_warn "pg mode: deleting ns '$NAMESPACE_VOSJ' also removes Postgres '$PG_SERVICE' and its PVC (DATA LOSS)"
  fi

  for ns in "$NAMESPACE_DEV" "$NAMESPACE_VOSJ"; do
    if kc get namespace "$ns" >/dev/null 2>&1; then
      log_info "deleting namespace '$ns'"
      kc delete namespace "$ns" --wait=false || log_warn "could not delete ns '$ns'"
    else
      log_info "namespace '$ns' absent — skipping"
    fi
  done
else
  log_warn "no reachable cluster via $KUBECONFIG_PATH — skipping in-cluster cleanup"
fi

# --- cluster ------------------------------------------------------------------
if [ "$DELETE_CLUSTER" -eq 1 ]; then
  require_cmd "az" "${AZ_BIN:-az}"
  require_az_login
  case "$TARGET" in
    azure-local)
      if az aksarc show -g "$RESOURCE_GROUP" -n "$CLUSTER_NAME" >/dev/null 2>&1; then
        log_info "deleting aksarc cluster '$CLUSTER_NAME'"
        az aksarc delete -g "$RESOURCE_GROUP" -n "$CLUSTER_NAME" --yes --no-wait \
          || log_warn "aksarc delete failed"
      else
        log_info "aksarc cluster '$CLUSTER_NAME' absent — skipping"
      fi
      ;;
    azure)
      if az aks show -g "$RESOURCE_GROUP" -n "$CLUSTER_NAME" >/dev/null 2>&1; then
        log_info "deleting AKS cluster '$CLUSTER_NAME'"
        az aks delete -g "$RESOURCE_GROUP" -n "$CLUSTER_NAME" --yes --no-wait \
          || log_warn "aks delete failed"
      else
        log_info "AKS cluster '$CLUSTER_NAME' absent — skipping"
      fi
      ;;
    *) log_warn "unknown TARGET '$TARGET' — not deleting any cluster" ;;
  esac
else
  log_info "cluster preserved (pass --delete-cluster to remove it)"
fi

# --- local artifacts ----------------------------------------------------------
if [ -f "$KUBECONFIG_PATH" ]; then
  log_info "removing local kubeconfig $KUBECONFIG_PATH"
  rm -f "$KUBECONFIG_PATH"
fi
rm -f "$POC_DIR/.kube/vosj-auth-token" 2>/dev/null || true

log_ok "TEARDOWN complete"
