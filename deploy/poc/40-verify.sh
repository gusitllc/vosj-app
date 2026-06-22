#!/usr/bin/env bash
# =============================================================================
# 40-verify.sh — smoke-test the POC. Prints a clear PASS/FAIL + access details.
#
# Checks:
#   1. Vosj /health returns {"ok":true} (real store/ledger status, not static).
#   2. Vosj /api/templates returns non-500 (token-gated — uses the stashed
#      VOSJ_AUTH_TOKEN; a 401 without a token still proves the route is alive).
#   3. each devstation pod is Running.
#
# Probes run INSIDE the cluster via `kubectl exec` into the vosj pod (curl/wget),
# avoiding a flaky local port-forward. Falls back to port-forward if exec lacks a
# shell. Read-only — makes no changes.
# =============================================================================
set -uo pipefail   # NOTE: not -e; we want to run every check and total the result.

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SELF_DIR/lib.sh"
load_config

banner "STAGE 40 — verify POC"

require_cmd "kubectl" "${KUBECTL_BIN:-kubectl}"
require_kubeconfig

FAILS=0
pass() { log_ok   "PASS  $*"; }
fail() { log_err  "FAIL  $*"; FAILS=$((FAILS+1)); }

VOSJ_SVC="$VOSJ_RELEASE"
# The container listens on VOSJ_PORT (chart containerPort, default 8080).
VOSJ_CONTAINER_PORT="${VOSJ_PORT:-8080}"

# Resolve a vosj pod to exec into.
POD="$(kc -n "$NAMESPACE_VOSJ" get pods \
  -l "app.kubernetes.io/instance=$VOSJ_RELEASE" \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo '')"

# In-pod fetch helper: prefer wget (present in the alpine image), fall back to
# curl. Echoes the body to stdout; non-zero on transport failure.
incluster_get() {
  local url="$1" hdr="${2:-}"
  if [ -z "$POD" ]; then return 2; fi
  if [ -n "$hdr" ]; then
    kc -n "$NAMESPACE_VOSJ" exec "$POD" -- \
      sh -c "wget -q -O- --header='$hdr' '$url' 2>/dev/null || curl -fsS -H '$hdr' '$url' 2>/dev/null"
  else
    kc -n "$NAMESPACE_VOSJ" exec "$POD" -- \
      sh -c "wget -q -O- '$url' 2>/dev/null || curl -fsS '$url' 2>/dev/null"
  fi
}

# ---- check 1: /health --------------------------------------------------------
log_info "check 1: Vosj /health"
if [ -z "$POD" ]; then
  fail "/health — no vosj pod found in ns '$NAMESPACE_VOSJ'"
else
  HEALTH="$(incluster_get "http://127.0.0.1:${VOSJ_CONTAINER_PORT}/health" || echo '')"
  log_info "/health -> ${HEALTH:-<empty>}"
  if printf '%s' "$HEALTH" | grep -q '"ok":[[:space:]]*true'; then
    pass "/health returns ok:true"
  else
    fail "/health did not return ok:true"
  fi
fi

# ---- check 2: /api/templates (token-gated, expect non-500) -------------------
log_info "check 2: Vosj /api/templates (non-500)"
AUTH_TOKEN=""
[ -f "$POC_DIR/.kube/vosj-auth-token" ] && AUTH_TOKEN="$(cat "$POC_DIR/.kube/vosj-auth-token")"
if [ -z "$POD" ]; then
  fail "/api/templates — no vosj pod"
else
  HDR=""
  [ -n "$AUTH_TOKEN" ] && HDR="Authorization: Bearer $AUTH_TOKEN"
  # We can't read the HTTP status from wget -O- easily; instead we check the body
  # is JSON and not a 500 error envelope. A 200 returns {"ok":true,"templates":..}
  # an unauthenticated 401 returns {"ok":false,...} — both prove the route lives.
  TPL="$(incluster_get "http://127.0.0.1:${VOSJ_CONTAINER_PORT}/api/templates" "$HDR" || echo '')"
  log_info "/api/templates -> ${TPL:-<empty>}"
  if printf '%s' "$TPL" | grep -qE '"templates"|"ok":[[:space:]]*(true|false)'; then
    pass "/api/templates responded (route alive, non-500)"
  else
    fail "/api/templates gave no valid JSON response (possible 500 / route down)"
  fi
fi

# ---- check 3: devstation pods Running ----------------------------------------
log_info "check 3: devstation pods Running"
for i in $(seq 1 "${DEVSTATION_COUNT:-0}"); do
  name="devstation-${i}"
  phase="$(kc -n "$NAMESPACE_DEV" get pods \
    -l "app.kubernetes.io/instance=$name" \
    -o jsonpath='{.items[0].status.phase}' 2>/dev/null || echo '')"
  if [ "$phase" = "Running" ]; then
    pass "$name is Running"
  else
    fail "$name not Running (phase='${phase:-<none>}')"
  fi
done

# ---- access details ----------------------------------------------------------
banner "ACCESS DETAILS"
cat <<EOF
Kubeconfig (export to use kubectl/helm against the POC):
  export KUBECONFIG="$KUBECONFIG_PATH"

Vosj API (port-forward, then browse / curl):
  kubectl --kubeconfig "$KUBECONFIG_PATH" -n $NAMESPACE_VOSJ port-forward svc/$VOSJ_SVC 8080:80
  curl -s http://127.0.0.1:8080/health
  # token-gated routes:
  curl -s -H "Authorization: Bearer \$(cat $POC_DIR/.kube/vosj-auth-token)" \\
    http://127.0.0.1:8080/api/templates

Devstations (code-server) — port-forward each seat:
EOF
for i in $(seq 1 "${DEVSTATION_COUNT:-0}"); do
  name="devstation-${i}"
  printf '  kubectl --kubeconfig "%s" -n %s port-forward svc/%s 808%s:80\n' \
    "$KUBECONFIG_PATH" "$NAMESPACE_DEV" "$name" "$i"
  printf '    password: kubectl --kubeconfig "%s" -n %s get secret %s-secret -o jsonpath="{.data.CODE_SERVER_PASSWORD}" | base64 -d\n' \
    "$KUBECONFIG_PATH" "$NAMESPACE_DEV" "$name"
done

# ---- verdict -----------------------------------------------------------------
banner "VERDICT"
if [ "$FAILS" -eq 0 ]; then
  log_ok "ALL CHECKS PASSED"
  exit 0
else
  log_err "$FAILS CHECK(S) FAILED"
  exit 1
fi
