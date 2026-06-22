# Vosj CE — Deploy Runbook

Copy-pasteable runbook to deploy **Vosj Community Edition** with the Helm chart in
[`helm/vosj`](helm/vosj). Hardened to whitepaper §15.8 (zero-trust, least
privilege, **fail-closed secrets**).

- **Primary target:** AKS enabled by Azure Arc on **Azure Local** (Azure Stack HCI).
- **Secondary:** cloud AKS.

The two run the same chart; only image build/registry and a couple of platform
notes differ — see [Platform notes](#platform-notes).

---

## 0. Prerequisites

- `kubectl` pointed at the target cluster (`kubectl config current-context`).
- `helm` v3.12+ (`helm version`).
- A container registry the cluster can pull from (ACR for both targets).
- A reachable PostgreSQL (production uses CloudNativePG; `STATE_STORE=pg`).

---

## 1. Generate the fail-closed secrets

Vosj **never** substitutes a default for these. If the ledger HMAC key is absent,
`append()` throws and the audit chain cannot be written; if the vault master key is
absent, the vault refuses to operate. Generate strong random values once and keep
them in your secret manager:

```bash
# 32-byte (256-bit) hex keys
export VOSJ_LEDGER_HMAC_KEY=$(openssl rand -hex 32)
export VOSJ_VAULT_MASTER_KEY=$(openssl rand -hex 32)
# Bearer token for the REST API (token auth mode)
export VOSJ_AUTH_TOKEN=$(openssl rand -hex 32)
# PostgreSQL password for the vosj DB user
export PG_PASSWORD='<your-postgres-password>'
```

> Losing `VOSJ_LEDGER_HMAC_KEY` makes the existing ledger chain unverifiable
> (`verifyChain` recomputes the HMAC with the key). Rotate deliberately and archive
> the prior key with the data it signed.

### Recommended: create the Secret out-of-band

Keeping keys out of `values.yaml` and out of Helm's release history is the
production-preferred path. Create the Secret yourself, then point the chart at it
with `secret.create=false secret.existingSecret=<name>`:

```bash
kubectl create namespace vosj --dry-run=client -o yaml | kubectl apply -f -

kubectl create secret generic vosj-secret -n vosj \
  --from-literal=VOSJ_LEDGER_HMAC_KEY="$VOSJ_LEDGER_HMAC_KEY" \
  --from-literal=VOSJ_VAULT_MASTER_KEY="$VOSJ_VAULT_MASTER_KEY" \
  --from-literal=VOSJ_AUTH_TOKEN="$VOSJ_AUTH_TOKEN" \
  --from-literal=PG_PASSWORD="$PG_PASSWORD"
```

---

## 2. Build & push the image

```bash
# Cloud AKS or Azure Local (both pull from ACR):
az acr build -r <acr-name> -t vosj-ce:0.1.0 -f Dockerfile .
# -> image ends up at <acr-name>.azurecr.io/vosj-ce:0.1.0
```

---

## 3. Install

### 3a. With a pre-created Secret (recommended)

```bash
helm upgrade --install vosj ./deploy/helm/vosj -n vosj --create-namespace \
  --set image.repository=<acr-name>.azurecr.io/vosj-ce \
  --set image.tag=0.1.0 \
  --set secret.create=false \
  --set secret.existingSecret=vosj-secret \
  --set config.postgres.host=<pg-host> \
  --set config.postgres.user=vosj \
  --set config.postgres.database=vosj
```

### 3b. Let Helm create the Secret (keys passed at install)

```bash
helm upgrade --install vosj ./deploy/helm/vosj -n vosj --create-namespace \
  --set image.repository=<acr-name>.azurecr.io/vosj-ce \
  --set image.tag=0.1.0 \
  --set config.postgres.host=<pg-host> \
  --set config.postgres.user=vosj \
  --set config.postgres.database=vosj \
  --set secret.values.ledgerHmacKey="$VOSJ_LEDGER_HMAC_KEY" \
  --set secret.values.vaultMasterKey="$VOSJ_VAULT_MASTER_KEY" \
  --set secret.values.authToken="$VOSJ_AUTH_TOKEN" \
  --set secret.values.pgPassword="$PG_PASSWORD"
```

The **pre-install/pre-upgrade migration Job** (`<release>-migrate`) runs
`npm run migrate` against PostgreSQL before the Deployment rolls, applying the
idempotent `src/db/schema.sql`. Watch it:

```bash
kubectl get jobs -n vosj
kubectl logs -n vosj job/vosj-migrate
```

> Demo / no-DB mode: set `--set config.stateStore=memory`. The migration Job is
> skipped automatically (it only runs in `pg` mode). State is ephemeral — demo only.

---

## 4. Verify `/health`

`/health` returns real store/ledger/db status — not a static `ok`.

```bash
kubectl rollout status deployment/vosj -n vosj --timeout=5m
kubectl port-forward -n vosj svc/vosj 8080:80 &
curl -s http://127.0.0.1:8080/health | tee /dev/stderr | grep -q '"ok":true'
```

Healthy output looks like:

```json
{ "ok": true, "version": "0.1.0", "store": "pg", "storeOk": true,
  "dbConfigured": true, "ledgerOk": true, "workloads": 0, "waves": 0 }
```

Checklist — investigate before declaring success:

- `storeOk: true` and `store: "pg"` (DB reachable; not silently on memory).
- `ledgerOk: true` (HMAC key present and chain verifies).
- `dbConfigured: true`.

Authenticated API smoke test (token mode):

```bash
curl -s -H "Authorization: Bearer $VOSJ_AUTH_TOKEN" \
  http://127.0.0.1:8080/api/... # see src/api/routes when mounted
```

---

## 5. Rollback

```bash
helm history vosj -n vosj
helm rollback vosj <REVISION> -n vosj
```

---

## Platform notes

### AKS-Arc on Azure Local (primary)

- Cluster is connected via **Azure Arc**; target it with the same `kubectl`/Helm
  flow. Confirm the context is the Arc-enabled AKS cluster, not cloud AKS.
- **Registry pull:** the cluster must reach ACR. On Azure Local this is typically
  over the site link / private endpoint — verify image pulls succeed
  (`kubectl describe pod` shows no `ImagePullBackOff`).
- **Storage:** Vosj CE is **stateless** (state lives in PostgreSQL); no PVC is
  required by this chart. Do not back the pods with per-pod PVCs.
- **Default-deny egress:** in a zero-trust setup, allow egress only to the
  PostgreSQL endpoint and the registry. The app makes no other outbound calls in CE.
- **Node sizing:** default resource requests (100m / 128Mi) suit small Azure Local
  nodes; raise `resources` for production load.

### Cloud AKS (secondary)

- Attach ACR to the cluster (`az aks update --attach-acr <acr>`) or supply
  `imagePullSecrets`.
- For CloudNativePG with a self-signed cert, keep
  `config.postgres.sslRejectUnauthorized=false` (default). With a CA-trusted cert,
  set it to `true`.
- Front the ClusterIP Service with an Ingress/Gateway; do not change
  `service.type` to `LoadBalancer` unless the API is meant to be publicly reachable.

---

## Security invariants honoured by this chart

- **Fail-closed secrets** — no default HMAC/vault keys; absence stops signing/vault.
- **Non-root**, `readOnlyRootFilesystem: true`, all Linux capabilities dropped,
  `allowPrivilegeEscalation: false`, `seccompProfile: RuntimeDefault`.
- **No secrets in the image or ConfigMap** — only the Secret (which you can keep
  entirely out-of-band via `existingSecret`).
- **Migration runs before rollout** so the app never serves against an un-migrated DB.
