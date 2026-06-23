#!/usr/bin/env bash
# =============================================================================
# build.sh — build the lean POC devstation image in ACR (server-side, no local
# Docker). Tag defaults to :poc; override with DEVSTATION_IMAGE_TAG. ACR defaults
# to lucaexpressacr; override with ACR. Mirrors deploy/poc/10-build-image.sh.
# =============================================================================
set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACR="${ACR:-lucaexpressacr}"
TAG="${DEVSTATION_IMAGE_TAG:-poc}"
AZ_BIN="${AZ_BIN:-az}"

echo "building ${ACR}.azurecr.io/vosj-devstation:${TAG} from $SELF_DIR"
"$AZ_BIN" acr build \
  --registry "$ACR" \
  --image "vosj-devstation:${TAG}" \
  --file "$SELF_DIR/Dockerfile" \
  "$SELF_DIR"
echo "done — pushed ${ACR}.azurecr.io/vosj-devstation:${TAG}"
