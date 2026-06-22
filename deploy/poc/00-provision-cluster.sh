#!/usr/bin/env bash
# =============================================================================
# 00-provision-cluster.sh — provision the Kubernetes cluster FROM CODE.
#
# Supports two substrates (TARGET in config.env or --target):
#   azure-local : AKS enabled by Azure Arc on Azure Local, via `az aksarc`.
#   azure       : managed cloud AKS, via `az aks`.
#
# Idempotent: if the cluster already exists it skips create and just fetches
# fresh credentials into deploy/poc/.kube/vosj-poc.config (NOT ~/.kube/config,
# so it never clobbers your other contexts).
#
# Flags confirmed via Microsoft Learn (see deploy/poc/README.md "Confirmed
# flags"): az aksarc create takes --custom-location --vnet-ids
# --control-plane-count --node-count --node-vm-size --generate-ssh-keys
# --kubernetes-version; az aksarc get-credentials takes --admin --file.
# =============================================================================
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SELF_DIR/lib.sh"
load_config

# --- arg parse: allow --target override --------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    --target=*) TARGET="${1#*=}"; shift ;;
    *) log_warn "ignoring unknown arg: $1"; shift ;;
  esac
done
export TARGET

banner "STAGE 00 — provision cluster ($TARGET) : $CLUSTER_NAME"

require_cmd "az" "${AZ_BIN:-az}"
require_az_login
mkdir -p "$(dirname "$KUBECONFIG_PATH")"

# -----------------------------------------------------------------------------
# Azure Local (AKS Arc)
# -----------------------------------------------------------------------------
provision_azure_local() {
  log_info "ensure aksarc CLI extension present"
  # Only add when missing — `--upgrade` forces a slow re-download every run.
  az extension show --name aksarc >/dev/null 2>&1 \
    || az extension add --name aksarc --yes >/dev/null 2>&1 \
    || log_warn "could not add aksarc extension (may already be present)"

  if az aksarc show -g "$RESOURCE_GROUP" -n "$CLUSTER_NAME" >/dev/null 2>&1; then
    log_ok "aksarc cluster '$CLUSTER_NAME' already exists — skipping create"
  else
    log_info "creating aksarc cluster '$CLUSTER_NAME'"
    log_info "  custom-location : $CUSTOM_LOCATION"
    log_info "  vnet-ids        : $LOGICAL_NETWORK_ID"
    log_info "  control-plane   : $CONTROL_PLANE_COUNT x $CONTROL_PLANE_VM_SIZE"
    log_info "  nodes           : $NODE_COUNT x $NODE_VM_SIZE"

    # Build the arg list; only append optional flags when set.
    set -- \
      --resource-group "$RESOURCE_GROUP" \
      --name "$CLUSTER_NAME" \
      --custom-location "$CUSTOM_LOCATION" \
      --vnet-ids "$LOGICAL_NETWORK_ID" \
      --control-plane-ip "$CONTROL_PLANE_IP" \
      --control-plane-count "$CONTROL_PLANE_COUNT" \
      --control-plane-vm-size "$CONTROL_PLANE_VM_SIZE" \
      --node-count "$NODE_COUNT" \
      --node-vm-size "$NODE_VM_SIZE"

    if [ -n "${K8S_VERSION:-}" ]; then
      set -- "$@" --kubernetes-version "$K8S_VERSION"
    fi
    if [ -n "${SSH_KEY_VALUE:-}" ]; then
      set -- "$@" --ssh-key-value "$SSH_KEY_VALUE"
    else
      set -- "$@" --generate-ssh-keys
    fi

    # --no-wait + poll: avoid streaming a long LRO (and the unicode crash).
    # MSYS_NO_PATHCONV / MSYS2_ARG_CONV_EXCL: stop Git Bash (Windows) from rewriting
    # the leading-slash ARM ids (--vnet-ids, --custom-location) into a 'C:/.../Git/...'
    # path, which makes az reject --vnet-ids. Scoped to this call so the get-credentials
    # --file path below is still translated correctly.
    # az aksarc create can exit NON-ZERO on a transient 'provisionedClusterInstances/
    # default not found' during submit while the cluster actually provisions fine
    # (provisioningState=Accepted). Do NOT treat its exit as fatal — the polled
    # provisioningState below is the source of truth.
    MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' az aksarc create "$@" --no-wait \
      || log_warn "aksarc create returned non-zero during submit — verifying via provisioningState (usually a benign transient)"
    poll_aksarc_ready
  fi

  log_info "fetching admin kubeconfig -> $KUBECONFIG_PATH"
  az aksarc get-credentials \
    --resource-group "$RESOURCE_GROUP" \
    --name "$CLUSTER_NAME" \
    --admin \
    --file "$KUBECONFIG_PATH"
}

# Poll `az aksarc show` provisioningState until Succeeded (or fail/ timeout).
poll_aksarc_ready() {
  local i=0 state=""
  while [ "$i" -lt "$PROVISION_POLL_MAX" ]; do
    state="$(az aksarc show -g "$RESOURCE_GROUP" -n "$CLUSTER_NAME" \
      --query properties.provisioningState -o tsv 2>/dev/null | tr -d '\r' || echo '')"
    log_info "aksarc provisioningState=${state:-<none>} (poll $((i+1))/$PROVISION_POLL_MAX)"
    case "$state" in
      Succeeded) log_ok "aksarc cluster provisioned"; return 0 ;;
      Failed|Canceled) log_err "aksarc provisioning ended in state: $state"; exit 1 ;;
    esac
    i=$((i+1))
    sleep "$PROVISION_POLL_INTERVAL"
  done
  log_err "aksarc provisioning did not reach Succeeded within the poll budget"
  exit 1
}

# -----------------------------------------------------------------------------
# Managed cloud AKS
# -----------------------------------------------------------------------------
provision_azure() {
  log_info "ensure resource group '$RESOURCE_GROUP' exists in $LOCATION"
  az group create --name "$RESOURCE_GROUP" --location "$LOCATION" >/dev/null

  if az aks show -g "$RESOURCE_GROUP" -n "$CLUSTER_NAME" >/dev/null 2>&1; then
    log_ok "AKS cluster '$CLUSTER_NAME' already exists — skipping create"
  else
    log_info "creating managed AKS cluster '$CLUSTER_NAME' ($NODE_COUNT x $NODE_VM_SIZE)"

    set -- \
      --resource-group "$RESOURCE_GROUP" \
      --name "$CLUSTER_NAME" \
      --location "$LOCATION" \
      --node-count "$NODE_COUNT" \
      --node-vm-size "$NODE_VM_SIZE" \
      --attach-acr "$ACR"

    if [ -n "${K8S_VERSION:-}" ]; then
      set -- "$@" --kubernetes-version "$K8S_VERSION"
    fi
    if [ -n "${SSH_KEY_VALUE:-}" ]; then
      set -- "$@" --ssh-key-value "$SSH_KEY_VALUE"
    else
      set -- "$@" --generate-ssh-keys
    fi

    az aks create "$@"
    log_ok "managed AKS cluster created"
  fi

  log_info "fetching kubeconfig -> $KUBECONFIG_PATH"
  az aks get-credentials \
    --resource-group "$RESOURCE_GROUP" \
    --name "$CLUSTER_NAME" \
    --admin \
    --overwrite-existing \
    --file "$KUBECONFIG_PATH"
}

# -----------------------------------------------------------------------------
case "$TARGET" in
  azure-local) provision_azure_local ;;
  azure)       provision_azure ;;
  *) log_err "unknown TARGET '$TARGET' (expected azure-local|azure)"; exit 1 ;;
esac

# Sanity: the kubeconfig should now talk to a cluster.
if kc get nodes >/dev/null 2>&1; then
  log_ok "kubeconfig works — cluster reachable:"
  kc get nodes -o wide || true
else
  log_warn "kubeconfig written but 'kubectl get nodes' failed; check connectivity"
fi

log_ok "STAGE 00 complete — kubeconfig at $KUBECONFIG_PATH"
