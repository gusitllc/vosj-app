# Vosj POC Seat Manager — credential-assignment console for the devstation seats.
# Zero runtime deps (raw http + global fetch + the in-cluster ServiceAccount), so
# the image is tiny and the dependency layer is empty. NO secrets baked in — the
# admin key + the cluster SA token are injected at runtime (K8s Secret / mounted
# SA), never in the image.
# Build:  az acr build -r <acr> -t vosj-seat-manager:<tag> -f Dockerfile .

FROM node:20-alpine
WORKDIR /app

# Copy manifest(s) first for a cacheable install layer. There are no runtime
# dependencies, so this is effectively a no-op, but it keeps the contract honest
# (npm ci uses the lockfile when present; npm install otherwise).
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; \
    else npm install --omit=dev --no-audit --no-fund; fi

# Copy the application (server + static assets).
COPY server.js ./server.js
COPY public ./public

# node:alpine ships an unprivileged `node` user (uid 1000) — run as it.
USER node

EXPOSE 8080

CMD ["node", "server.js"]
