#!/usr/bin/env bash
# =============================================================================
# 60-deploy-tunnel.sh — public Cloudflare tunnel for the POC demo (codified).
#
# Creates/reuses a named CF tunnel, configures its ingress (public hostname ->
# in-cluster service) + DNS CNAMEs via the CF API (cf-tunnel-setup.cjs), then
# deploys the cloudflared connector into the POC cluster — exactly like the live
# fleet's token-based cloudflared-devstations. Reachable surfaces:
#   demo.vosj.com    -> Vosj Command Center  (vosj/${VOSJ_RELEASE}:80)
#   seats.vosj.com   -> Seat Manager         (devstations/seat-manager:80)
#   seat<N>.vosj.com -> devstation-<N>        (devstations/devstation-<N>:80)
#
# CF credentials: from env (CLOUDFLARE_API_EMAIL / CLOUDFLARE_API_KEY /
# CLOUDFLARE_ACCOUNT_ID / CF_ZONE_ID) if set; else read from the platform gateway
# pod's global key via GATEWAY_KUBECONFIG (default ~/.kube/config), GATEWAY_NAMESPACE
# (default luca-dev). The connector token is minted from the CF API and never
# committed — it lives only in the in-cluster Secret 'cloudflared-token'.
# =============================================================================
set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SELF_DIR/lib.sh"
load_config

banner "STAGE 60 — Cloudflare tunnel : ${TUNNEL_NAME:-vosj-poc} -> ${TUNNEL_BASE_DOMAIN:-vosj.com}"

require_cmd "kubectl" "${KUBECTL_BIN:-kubectl}"
require_cmd "curl" "curl"
require_cmd "node" "node"
require_kubeconfig

TUNNEL_NAME="${TUNNEL_NAME:-vosj-poc}"
BASE_DOMAIN="${TUNNEL_BASE_DOMAIN:-vosj.com}"
CF_API="https://api.cloudflare.com/client/v4"

# --- CF credentials (env, else gateway pod) ----------------------------------
if [ -z "${CLOUDFLARE_API_EMAIL:-}" ] || [ -z "${CLOUDFLARE_API_KEY:-}" ]; then
  log_info "CF creds not in env — reading the global key from the gateway pod"
  GKC="${GATEWAY_KUBECONFIG:-$HOME/.kube/config}"
  GNS="${GATEWAY_NAMESPACE:-luca-dev}"
  GPOD="$(KUBECONFIG="$GKC" "${KUBECTL_BIN:-kubectl}" -n "$GNS" get pods -l app=luca-gateway \
            -o jsonpath='{.items[0].metadata.name}' 2>/dev/null | tr -d '\r')"
  [ -n "$GPOD" ] || { log_err "no gateway pod (app=luca-gateway) in $GNS for CF creds"; exit 1; }
  gpenv() { KUBECONFIG="$GKC" "${KUBECTL_BIN:-kubectl}" -n "$GNS" exec "$GPOD" -- printenv "$1" 2>/dev/null | tr -d '\r'; }
  CLOUDFLARE_API_EMAIL="${CLOUDFLARE_API_EMAIL:-$(gpenv CLOUDFLARE_API_EMAIL)}"
  CLOUDFLARE_API_KEY="${CLOUDFLARE_API_KEY:-$(gpenv CLOUDFLARE_API_KEY)}"
  CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-$(gpenv CLOUDFLARE_ACCOUNT_ID)}"
fi
[ -n "${CLOUDFLARE_API_EMAIL:-}" ] && [ -n "${CLOUDFLARE_API_KEY:-}" ] && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] \
  || { log_err "missing CF credentials (email/key/account)"; exit 1; }

# zone id (resolve from the base domain if not supplied)
if [ -z "${CF_ZONE_ID:-}" ]; then
  CF_ZONE_ID="$(curl -s -H "X-Auth-Email: $CLOUDFLARE_API_EMAIL" -H "X-Auth-Key: $CLOUDFLARE_API_KEY" \
    "$CF_API/zones?name=$BASE_DOMAIN" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);process.stdout.write((j.result&&j.result[0]&&j.result[0].id)||"")}catch(e){}})')"
fi
[ -n "$CF_ZONE_ID" ] || { log_err "could not resolve zone id for $BASE_DOMAIN"; exit 1; }
log_ok "CF account ${CLOUDFLARE_ACCOUNT_ID} zone ${CF_ZONE_ID} ($BASE_DOMAIN)"

# --- hostnames -> in-cluster services (built as JSON for the orchestrator) ----
HOST_PAIRS_JSON="$(NAMESPACE_VOSJ="$NAMESPACE_VOSJ" VOSJ_RELEASE="$VOSJ_RELEASE" \
  NAMESPACE_DEV="$NAMESPACE_DEV" DEVSTATION_COUNT="$DEVSTATION_COUNT" node -e '
const a=[
  {host:"demo",service:`http://${process.env.VOSJ_RELEASE}.${process.env.NAMESPACE_VOSJ}.svc.cluster.local:80`},
  {host:"seats",service:`http://seat-manager.${process.env.NAMESPACE_DEV}.svc.cluster.local:80`},
];
for(let i=1;i<=+process.env.DEVSTATION_COUNT;i++)a.push({host:`seat${i}`,service:`http://devstation-${i}.${process.env.NAMESPACE_DEV}.svc.cluster.local:80`});
process.stdout.write(JSON.stringify(a));')"

# --- create/reuse tunnel + ingress + DNS, capture the connector token ---------
log_info "configuring tunnel + ingress + DNS via the CF API"
TOKEN="$(CLOUDFLARE_API_EMAIL="$CLOUDFLARE_API_EMAIL" CLOUDFLARE_API_KEY="$CLOUDFLARE_API_KEY" \
  CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID" CF_ZONE_ID="$CF_ZONE_ID" \
  TUNNEL_NAME="$TUNNEL_NAME" TUNNEL_BASE_DOMAIN="$BASE_DOMAIN" HOST_PAIRS_JSON="$HOST_PAIRS_JSON" \
  node "$SELF_DIR/cf-tunnel-setup.cjs")"
[ -n "$TOKEN" ] || { log_err "tunnel setup did not return a connector token"; exit 1; }
log_ok "tunnel configured"

# --- cloudflared connector in the POC cluster --------------------------------
ensure_namespace "$NAMESPACE_VOSJ"
# Refresh the token Secret out-of-band (the token can rotate on re-create).
kc -n "$NAMESPACE_VOSJ" delete secret cloudflared-token >/dev/null 2>&1 || true
kc -n "$NAMESPACE_VOSJ" create secret generic cloudflared-token --from-literal=token="$TOKEN" >/dev/null
log_ok "cloudflared-token Secret refreshed in '$NAMESPACE_VOSJ'"

NAMESPACE_VOSJ="$NAMESPACE_VOSJ" envsubst < "$SELF_DIR/cloudflared.yaml" | kc apply -f -
kc -n "$NAMESPACE_VOSJ" rollout status deployment/cloudflared --timeout "${ROLLOUT_TIMEOUT}s" || {
  log_warn "cloudflared rollout slow; check 'kubectl -n $NAMESPACE_VOSJ get pods -l app=cloudflared'"
}

banner "TUNNEL READY — public demo URLs"
log_ok "  https://demo.${BASE_DOMAIN}    (Vosj Command Center)"
log_ok "  https://seats.${BASE_DOMAIN}   (Seat Manager)"
for i in $(seq 1 "$DEVSTATION_COUNT"); do log_ok "  https://seat${i}.${BASE_DOMAIN}   (devstation-${i})"; done
log_info "DNS may take ~30-60s to propagate; cloudflared connects immediately."
