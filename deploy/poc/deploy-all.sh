#!/usr/bin/env bash
# =============================================================================
# deploy-all.sh — END-TO-END Vosj POC orchestrator.
#
# Runs the whole POC FROM CODE, in order:
#   00 provision cluster  ->  10 build image  ->  [15 deploy Postgres, pg mode only]
#   ->  20 deploy Vosj  ->  30 deploy devstations  ->  40 verify
#
# Stage 15 runs ONLY when VOSJ_STATE_STORE=pg (deploys a persistent Postgres that
# Vosj then uses). In the default memory mode stage 15 is skipped entirely.
#
# Flags:
#   --target azure|azure-local   substrate to provision (overrides config.env)
#   --skip-cluster               deploy onto an EXISTING cluster (skip stage 00;
#                                requires deploy/poc/.kube/vosj-poc.config to exist)
#   --skip-build                 reuse the IMAGE_TAG already in ACR (skip stage 10)
#   -h | --help                  usage
#
# set -e: any stage failing aborts the run. Each stage prints its own banner.
# =============================================================================
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SELF_DIR/lib.sh"

SKIP_CLUSTER=0
SKIP_BUILD=0
TARGET_OVERRIDE=""

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET_OVERRIDE="$2"; shift 2 ;;
    --target=*) TARGET_OVERRIDE="${1#*=}"; shift ;;
    --skip-cluster) SKIP_CLUSTER=1; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    -h|--help) usage 0 ;;
    *) log_err "unknown arg: $1"; usage 1 ;;
  esac
done

load_config
[ -n "$TARGET_OVERRIDE" ] && export TARGET="$TARGET_OVERRIDE"

banner "VOSJ POC — END-TO-END DEPLOY"
log_info "target        : $TARGET"
log_info "cluster       : $CLUSTER_NAME (rg $RESOURCE_GROUP)"
log_info "image         : ${IMAGE_REPOSITORY}:${IMAGE_TAG}"
log_info "vosj ns       : $NAMESPACE_VOSJ (store=$VOSJ_STATE_STORE)"
log_info "devstations   : $DEVSTATION_COUNT in ns $NAMESPACE_DEV"
log_info "skip-cluster  : $SKIP_CLUSTER   skip-build: $SKIP_BUILD"
log_info "kubeconfig    : $KUBECONFIG_PATH"

START_TS="$(date +%s)"

# --- stage 00: cluster --------------------------------------------------------
if [ "$SKIP_CLUSTER" -eq 1 ]; then
  log_warn "STAGE 00 skipped (--skip-cluster); expecting existing kubeconfig"
  require_kubeconfig
else
  "$SELF_DIR/00-provision-cluster.sh" --target "$TARGET"
fi

# --- stage 10: image ----------------------------------------------------------
if [ "$SKIP_BUILD" -eq 1 ]; then
  log_warn "STAGE 10 skipped (--skip-build); reusing ${IMAGE_REPOSITORY}:${IMAGE_TAG}"
else
  "$SELF_DIR/10-build-image.sh"
fi

# --- stage 15: postgres (pg mode ONLY) ----------------------------------------
# Deploy the persistent Postgres BEFORE Vosj so the chart's migration Job (which
# 20 triggers) has a database to migrate. In memory mode this stage is skipped.
if [ "${VOSJ_STATE_STORE:-memory}" = "pg" ]; then
  "$SELF_DIR/15-deploy-postgres.sh"
else
  log_info "STAGE 15 skipped — VOSJ_STATE_STORE='${VOSJ_STATE_STORE:-memory}' (memory mode, no DB)"
fi

# --- stage 20: vosj -----------------------------------------------------------
"$SELF_DIR/20-deploy-vosj.sh"

# --- stage 30: devstations ----------------------------------------------------
"$SELF_DIR/30-deploy-devstations.sh"

# --- stage 40: verify ---------------------------------------------------------
"$SELF_DIR/40-verify.sh"

# --- summary ------------------------------------------------------------------
END_TS="$(date +%s)"
banner "POC DEPLOY COMPLETE"
log_ok "elapsed       : $(( END_TS - START_TS ))s"
log_ok "cluster       : $CLUSTER_NAME ($TARGET) — kubeconfig $KUBECONFIG_PATH"
log_ok "vosj          : release '$VOSJ_RELEASE' in ns '$NAMESPACE_VOSJ' (store=$VOSJ_STATE_STORE)"
if [ "${VOSJ_STATE_STORE:-memory}" = "pg" ]; then
  log_ok "postgres      : '$PG_SERVICE' in ns '$NAMESPACE_VOSJ' (persistent, ${PG_STORAGE} PVC) — Vosj migrated + connected"
fi
log_ok "image         : ${IMAGE_REPOSITORY}:${IMAGE_TAG}"
log_info "devstations:"
for i in $(seq 1 "$DEVSTATION_COUNT"); do
  log_ok "  - devstation-${i} in ns '$NAMESPACE_DEV'"
done
cat <<EOF

Next: reach the demo + devstations (see also 40-verify.sh ACCESS DETAILS):
  export KUBECONFIG="$KUBECONFIG_PATH"
  kubectl -n $NAMESPACE_VOSJ port-forward svc/$VOSJ_RELEASE 8080:80
  # then open http://127.0.0.1:8080/health

Teardown when done:
  ./teardown.sh            # remove app + namespaces (keep cluster)
  ./teardown.sh --delete-cluster   # also delete the cluster
EOF
