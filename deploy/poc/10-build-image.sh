#!/usr/bin/env bash
# =============================================================================
# 10-build-image.sh — build & push the Vosj CE image to ACR FROM CODE.
#
# Runs `az acr build` from the repo root so the Dockerfile's COPY paths resolve.
# No secrets are baked into the image (the Dockerfile injects them at runtime via
# the K8s Secret). The tag comes from config.env (IMAGE_TAG), defaulting to a
# timestamp so each build is uniquely addressable — never a floating :latest.
# =============================================================================
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SELF_DIR/lib.sh"
load_config

banner "STAGE 10 — build image : ${IMAGE_NAME}:${IMAGE_TAG} -> $ACR"

require_cmd "az" "${AZ_BIN:-az}"
require_az_login

if [ ! -f "$REPO_ROOT/Dockerfile" ]; then
  log_err "Dockerfile not found at repo root: $REPO_ROOT/Dockerfile"
  exit 1
fi

log_info "registry         : $ACR"
log_info "image            : ${IMAGE_NAME}:${IMAGE_TAG}"
log_info "build context    : $REPO_ROOT"
log_info "resolves to      : ${IMAGE_REPOSITORY}:${IMAGE_TAG}"

# az acr build runs the build server-side in ACR Tasks — no local Docker needed.
az acr build \
  --registry "$ACR" \
  --image "${IMAGE_NAME}:${IMAGE_TAG}" \
  --file "$REPO_ROOT/Dockerfile" \
  "$REPO_ROOT"

log_ok "STAGE 10 complete — pushed ${IMAGE_REPOSITORY}:${IMAGE_TAG}"
