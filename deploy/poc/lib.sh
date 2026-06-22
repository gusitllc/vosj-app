#!/usr/bin/env bash
# =============================================================================
# deploy/poc/lib.sh — shared helpers for the Vosj POC automation.
#
# Sourced by every stage script. Provides: config loading, structured logging,
# az/kubectl/helm wrappers (correct binaries + PYTHONIOENCODING), the POC
# kubeconfig path, and small guards. NO side effects on source beyond defining
# functions and resolving POC_DIR / REPO_ROOT.
# =============================================================================

# --- resolve key paths --------------------------------------------------------
# POC_DIR = directory containing this lib (deploy/poc). REPO_ROOT = two up.
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export POC_DIR="$LIB_DIR"
export REPO_ROOT="$(cd "$POC_DIR/../.." && pwd)"

# --- load config --------------------------------------------------------------
# shellcheck source=/dev/null
load_config() {
  local cfg="${1:-$POC_DIR/config.env}"
  if [ ! -f "$cfg" ]; then
    log_err "config not found: $cfg"
    exit 1
  fi
  # shellcheck disable=SC1090
  . "$cfg"
  # The POC kubeconfig path is derived from POC_DIR + the configured filename.
  export KUBECONFIG_PATH="$POC_DIR/${KUBECONFIG_FILENAME:-.kube/vosj-poc.config}"
}

# --- logging ------------------------------------------------------------------
_ts() { date +'%Y-%m-%dT%H:%M:%S%z'; }
log()      { printf '[%s] %s\n'        "$(_ts)" "$*"; }
log_info() { printf '[%s] INFO  %s\n'  "$(_ts)" "$*"; }
log_warn() { printf '[%s] WARN  %s\n'  "$(_ts)" "$*" >&2; }
log_err()  { printf '[%s] ERROR %s\n'  "$(_ts)" "$*" >&2; }
log_ok()   { printf '[%s] OK    %s\n'  "$(_ts)" "$*"; }

# A clear stage banner used by deploy-all and each stage script.
banner() {
  local title="$*"
  printf '\n'
  printf '================================================================================\n'
  printf '  %s\n' "$title"
  printf '================================================================================\n'
}

# --- tool wrappers ------------------------------------------------------------
# az is invoked with PYTHONIOENCODING=utf-8 to avoid the unicode crash on this
# box. We always poll status rather than streaming long-running operations.
az() {
  PYTHONIOENCODING="${PYTHONIOENCODING:-utf-8}" "${AZ_BIN:-az}" "$@"
}

kc() {
  KUBECONFIG="$KUBECONFIG_PATH" "${KUBECTL_BIN:-kubectl}" "$@"
}

hm() {
  KUBECONFIG="$KUBECONFIG_PATH" "${HELM_BIN:-helm}" "$@"
}

# --- guards -------------------------------------------------------------------
require_cmd() {
  local label="$1" bin="$2"
  if ! command -v "$bin" >/dev/null 2>&1 && [ ! -x "$bin" ]; then
    log_err "$label not found or not executable: $bin"
    exit 1
  fi
}

require_az_login() {
  if ! az account show >/dev/null 2>&1; then
    log_err "no authenticated az session — run: az login"
    exit 1
  fi
  # Pin the subscription so every subsequent call targets the right scope.
  az account set --subscription "$SUBSCRIPTION" >/dev/null 2>&1 || {
    log_err "could not set subscription $SUBSCRIPTION"
    exit 1
  }
  log_ok "az session active; subscription set to $SUBSCRIPTION"
}

require_kubeconfig() {
  if [ ! -f "$KUBECONFIG_PATH" ]; then
    log_err "POC kubeconfig missing: $KUBECONFIG_PATH"
    log_err "run 00-provision-cluster.sh first (or pass --skip-cluster only if the kubeconfig exists)."
    exit 1
  fi
}

# Generate a 256-bit hex secret. Fails closed if openssl is unavailable.
gen_secret() {
  if ! command -v openssl >/dev/null 2>&1; then
    log_err "openssl not found — cannot generate fail-closed secrets"
    exit 1
  fi
  openssl rand -hex 32
}

# Ensure a namespace exists (idempotent).
ensure_namespace() {
  local ns="$1"
  if kc get namespace "$ns" >/dev/null 2>&1; then
    log_info "namespace '$ns' already exists"
  else
    log_info "creating namespace '$ns'"
    kc create namespace "$ns"
  fi
}
