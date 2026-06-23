#!/usr/bin/env bash
# =============================================================================
# seat-manager/build.sh — build & push the Seat Manager image to ACR FROM CODE.
#
# Runs `az acr build` from THIS directory (the Dockerfile's COPY paths are
# relative to seat-manager/). No secrets are baked into the image — the admin key
# and the cluster SA token are injected at runtime. The tag comes from TAG (env),
# defaulting to 'poc' to match the SEAT_MANAGER_IMAGE default in 50-deploy.
#
# Mirrors 10-build-image.sh: sources lib.sh + config.env, requires an az login,
# and builds server-side in ACR Tasks (no local Docker needed).
# =============================================================================
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib.sh
. "$SELF_DIR/../lib.sh"
load_config

TAG="${TAG:-poc}"
IMAGE_NAME="vosj-seat-manager"

banner "build Seat Manager image : ${IMAGE_NAME}:${TAG} -> $ACR"

require_cmd "az" "${AZ_BIN:-az}"
require_az_login

if [ ! -f "$SELF_DIR/Dockerfile" ]; then
  log_err "Dockerfile not found: $SELF_DIR/Dockerfile"
  exit 1
fi

log_info "registry      : $ACR"
log_info "image         : ${IMAGE_NAME}:${TAG}"
log_info "build context : $SELF_DIR"
log_info "resolves to   : ${ACR}.azurecr.io/${IMAGE_NAME}:${TAG}"

# az acr build runs the build server-side in ACR Tasks — no local Docker needed.
az acr build \
  --registry "$ACR" \
  --image "${IMAGE_NAME}:${TAG}" \
  --file "$SELF_DIR/Dockerfile" \
  "$SELF_DIR"

log_ok "build complete — pushed ${ACR}.azurecr.io/${IMAGE_NAME}:${TAG}"
