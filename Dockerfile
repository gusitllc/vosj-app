# Vosj Community Edition — production image.
# Hardened to whitepaper §15.8 (zero-trust, least privilege, fail-closed):
#   * non-root runtime user, read-only-friendly layout
#   * production deps only (npm ci --omit=dev)
#   * HEALTHCHECK hits the REAL /health endpoint
#   * NO secrets baked in — VOSJ_LEDGER_HMAC_KEY / VOSJ_VAULT_MASTER_KEY /
#     VOSJ_AUTH_TOKEN are injected at runtime (K8s Secret), never in the image.
# Build:  docker build -t <registry>/vosj-ce:<tag> .
#    or:  az acr build -r <acr> -t vosj-ce:<tag> .

# ---- deps stage: install production dependencies only ----------------------
FROM node:20-alpine AS deps
WORKDIR /app
# Copy only manifests first for a cacheable dependency layer.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---- runtime stage --------------------------------------------------------
FROM node:20-alpine AS runtime

# tini for correct PID-1 signal handling (graceful shutdown), wget for HEALTHCHECK.
RUN apk add --no-cache tini wget

ENV NODE_ENV=production \
    VOSJ_PORT=8080

WORKDIR /app

# node:alpine ships an unprivileged `node` user (uid 1000) — run as it.
COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json* ./
COPY --chown=node:node src ./src
COPY --chown=node:node templates ./templates
COPY --chown=node:node public ./public

USER node

EXPOSE 8080

# Real liveness/readiness signal — the app reports store/ledger/db status here.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${VOSJ_PORT}/health" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
