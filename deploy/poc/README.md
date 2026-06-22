# Vosj POC — codified end-to-end deployment

This directory provisions the **entire Vosj proof-of-concept from code**: it
**creates the Kubernetes cluster itself** (on Azure Local *or* cloud AKS), builds
and pushes the image, deploys Vosj, deploys a few devstations, and verifies the
result. "Setting up the AKS stuff" is part of the automation — not a manual step.

```
provision cluster  →  build image  →  deploy Vosj  →  deploy devstations  →  verify
   00                    10               20                30                  40
```

One command runs all five:

```bash
cd deploy/poc
./deploy-all.sh --target azure-local      # POC default
```

Extends the chart runbook in [`../README.md`](../README.md) (same Helm chart,
same fail-closed secret model) by adding the cluster-creation + devstation layers.

---

## What it creates

| Stage | Script | Creates |
|------|--------|---------|
| 00 | `00-provision-cluster.sh` | The cluster. `azure-local` → `az aksarc create`; `azure` → `az aks create`. Writes an admin kubeconfig to `deploy/poc/.kube/vosj-poc.config` (never `~/.kube`). |
| 10 | `10-build-image.sh` | `az acr build` of `vosj-ce:$IMAGE_TAG` into `$ACR`. No local Docker needed. |
| 20 | `20-deploy-vosj.sh` | `vosj` namespace, a **fail-closed Secret** (keys generated with `openssl rand -hex 32`), `helm upgrade --install` in `memory` store mode, waits for rollout. |
| 30 | `30-deploy-devstations.sh` | `devstations` namespace, `DEVSTATION_COUNT` code-server seats from `devstation.yaml` (per-seat Secret with a generated `CODE_SERVER_PASSWORD`). **Ephemeral — emptyDir only, no PVC.** |
| 40 | `40-verify.sh` | Smoke test: Vosj `/health` → `ok:true`, `/api/templates` non-500, each devstation `Running`. Prints PASS/FAIL + access details. |

`deploy-all.sh` chains 00→40; `teardown.sh` reverses it.

---

## Prerequisites

- **Azure CLI** (`az`) — an **authenticated session** (`az login`) with rights to
  the subscription. For `azure-local`, the `aksarc` extension (the script adds it).
- **kubectl** and **helm** v3.12+.
- **openssl** (fail-closed secret generation) and **envsubst** (from gettext,
  renders `devstation.yaml`).
- For `azure-local`: a reachable Azure Local instance with a **custom location**
  and a **logical network** (defaults target the `fl-small-gpu` instance).

The scripts use absolute tool paths from `config.env` (`AZ_BIN`, `KUBECTL_BIN`)
and set `PYTHONIOENCODING=utf-8` for `az` to avoid a unicode crash; long
operations are polled, not streamed.

---

## Configure

Everything is in **`config.env`** — one source of truth, no hardcoded values in
the scripts. Edit it, or export any var before running (an exported value wins).

Key settings (POC defaults shown):

```ini
TARGET=azure-local
CLUSTER_NAME=vosj-poc
SUBSCRIPTION=a16d84c5-15b4-4f50-a06c-5e5064d9345c
RESOURCE_GROUP=rg-avd-1node-gpu
CUSTOM_LOCATION=/subscriptions/.../customLocations/fl-small-gpu-mocarb-cl
LOGICAL_NETWORK=small-fl-logicaln-dhcp     # DHCP — no static IP planning
CONTROL_PLANE_COUNT=1
NODE_COUNT=1
NODE_VM_SIZE=Standard_A4_v2                # small, fits the 1-node instance
ACR=lucaexpressacr
NAMESPACE_VOSJ=vosj
NAMESPACE_DEV=devstations
DEVSTATION_COUNT=2
VOSJ_STATE_STORE=memory                    # POC: no DB required
```

**Secrets are never stored here.** `VOSJ_LEDGER_HMAC_KEY`, `VOSJ_VAULT_MASTER_KEY`,
`VOSJ_AUTH_TOKEN`, and each devstation's `CODE_SERVER_PASSWORD` are generated at
deploy time with `openssl rand -hex 32` and written straight into Kubernetes
Secrets. The generated Vosj auth token is also stashed at
`.kube/vosj-auth-token` (gitignored) so `40-verify.sh` can call the token-gated
`/api/templates`. To wire a Claude seat, set `CLAUDE_CODE_OAUTH_TOKEN` in your
environment before stage 30 (it lands in each devstation Secret; never commit it).

---

## Run

```bash
cd deploy/poc

# Full end-to-end on Azure Local (default):
./deploy-all.sh --target azure-local

# Full end-to-end on cloud AKS:
./deploy-all.sh --target azure

# Deploy onto an EXISTING cluster (skip stage 00 — needs the kubeconfig already):
./deploy-all.sh --skip-cluster

# Reuse an image already in ACR (skip stage 10):
./deploy-all.sh --skip-build
```

You can also run any stage on its own:

```bash
./00-provision-cluster.sh --target azure-local
./10-build-image.sh
./20-deploy-vosj.sh
./30-deploy-devstations.sh
./40-verify.sh
```

Every script is **idempotent**: re-running skips create when a cluster/secret
exists and never rotates a live ledger key.

---

## Reach the demo + devstations

```bash
export KUBECONFIG="$(pwd)/.kube/vosj-poc.config"

# Vosj
kubectl -n vosj port-forward svc/vosj 8080:80
curl -s http://127.0.0.1:8080/health
curl -s -H "Authorization: Bearer $(cat .kube/vosj-auth-token)" \
  http://127.0.0.1:8080/api/templates

# A devstation (code-server) — password from its Secret:
kubectl -n devstations port-forward svc/devstation-1 8081:80
kubectl -n devstations get secret devstation-1-secret \
  -o jsonpath='{.data.CODE_SERVER_PASSWORD}' | base64 -d ; echo
```

`40-verify.sh` prints these exact commands at the end of a run.

---

## Teardown

```bash
./teardown.sh                  # helm uninstall + delete namespaces (KEEP cluster)
./teardown.sh --delete-cluster # also az aksarc/aks delete the cluster
./teardown.sh -y               # non-interactive
```

---

## Azure vs Azure-Local — the difference

Both run the **same Helm chart** and the **same image**; only stage 00 differs.

| | **Azure Local** (`--target azure-local`) | **Cloud AKS** (`--target azure`) |
|---|---|---|
| Create | `az aksarc create` | `az aks create` |
| Placement | `--custom-location` (extendedLocation) | `--location` (region) |
| Network | `--vnet-ids <logical-network ARM id>` | AKS-managed VNet |
| Registry pull | cluster must reach ACR over the site link / private endpoint | `--attach-acr $ACR` grants pull |
| Credentials | `az aksarc get-credentials --admin --file` | `az aks get-credentials --admin --overwrite-existing --file` |
| Sizing | small VM (1 CP + 1 node) for the 1-node instance | same defaults; raise for load |

On Azure Local the logical network defaults to the **DHCP** network
(`small-fl-logicaln-dhcp`) so no static IP planning is needed. Switch to a static
network by setting `LOGICAL_NETWORK` (and, if it lives elsewhere,
`LOGICAL_NETWORK_ID`) in `config.env`.

---

## Confirmed CLI flags (verified against Microsoft Learn)

`az aksarc create` accepts: `--resource-group --name --custom-location
--vnet-ids --control-plane-count --control-plane-vm-size --node-count
--node-vm-size --kubernetes-version --generate-ssh-keys | --ssh-key-value
--no-wait`. `az aksarc get-credentials` accepts `--admin --file`. `az aksarc
delete` accepts `--yes --no-wait`. `az aks get-credentials` accepts `--admin
--overwrite-existing --file`. Sources:

- [az aksarc — Microsoft Learn](https://learn.microsoft.com/en-us/cli/azure/aksarc?view=azure-cli-latest)
- [Create AKS Arc clusters using Azure CLI](https://learn.microsoft.com/en-us/azure/aks/aksarc/aks-create-clusters-cli)
- [Create logical networks for AKS on Azure Local](https://learn.microsoft.com/en-us/azure/aks/aksarc/aks-networks)
- [Retrieve admin kubeconfig (AKS Arc)](https://learn.microsoft.com/en-us/azure/aks/aksarc/retrieve-admin-kubeconfig)
- [az aks get-credentials](https://learn.microsoft.com/en-us/azure/aks/control-kubeconfig-access)

---

## Platform hard rules honoured here

- **Fail-closed secrets** — Vosj never substitutes a default ledger/vault key;
  the scripts generate them and create the Secret out-of-band.
- **No PVCs on devstations** — `devstation.yaml` is `emptyDir` only. The cluster
  CSI cannot absorb many simultaneous volume attaches (a fleet-wide per-pod PVC
  roll wedged the disk CSI once); retention, if needed, is via DB harvest.
- **Pinned image tags** — `IMAGE_TAG` defaults to a timestamp, never `:latest`.
- **Configurable, idempotent, fail-closed, heavily logged** throughout.
