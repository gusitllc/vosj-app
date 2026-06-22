# Vosj — Deployment Guide (step-by-step)

**Audience:** an operator deploying Vosj Community Edition end-to-end onto Kubernetes — either **AKS enabled by Azure Arc on Azure Local** (the primary, hardest target) or **managed Azure AKS**.
**Scope:** from zero to a verified, running Vosj + devstations, *provisioning the cluster itself from code*. Every step says **what to run**, **what it does**, and **why it matters**. Troubleshooting at the end is drawn from real deployment runs, not theory.

> The automation lives in [`deploy/poc/`](../deploy/poc/). This guide explains it one step at a time; [`deploy/poc/README.md`](../deploy/poc/README.md) is the terse command reference.

---

## 0. Mental model — what you are building

```
                 az aksarc create (Azure Local)  OR  az aks create (Azure)
   config.env  ─────────────────────────────────────────────────────────►  a Kubernetes cluster
       │                                                                          │
       │  az acr build → vosj-ce:<tag> ──► your container registry (ACR) ─────────┤
       │                                                                          ▼
       │                                                          helm upgrade --install vosj
       │                                                          (+ fail-closed Secret, ACR pull secret)
       │                                                                          │
       └────────────────────────────────────────────────► N ephemeral devstations (code-server seats)
                                                                                  │
                                                                40-verify ── /health · /api · pods Running
```

Five ordered stages, each an idempotent script; `deploy-all.sh` runs them in order:

| Stage | Script | Does |
|------|--------|------|
| 00 | `00-provision-cluster.sh` | Creates the cluster (Azure Local **or** Azure); writes an isolated kubeconfig |
| 10 | `10-build-image.sh` | `az acr build` the `vosj-ce` image into your ACR |
| 20 | `20-deploy-vosj.sh` | Namespace + **fail-closed Secret** + **ACR pull secret** + `helm upgrade --install` + rollout wait |
| 30 | `30-deploy-devstations.sh` | N ephemeral devstation seats (code-server), one Secret each |
| 40 | `40-verify.sh` | Smoke test: `/health` ok, `/api/templates` non-500, devstation pods Running |

---

## 1. Prerequisites

1. **Tooling** (paths are configurable in `config.env`):
   - Azure CLI `az` (logged in: `az login`; correct subscription: `az account set -s <sub>`)
   - `kubectl`, `helm`
   - For Azure Local: the `aksarc` and `stack-hci-vm` CLI extensions (00 installs `aksarc` automatically)
2. **A container registry (ACR)** you can `az acr build` into, e.g. `lucaexpressacr`. If it's private, either enable the admin user (`az acr update -n <acr> --admin-enabled true`) so the deploy can mint a pull secret, **or** attach it to the cluster's identity.
3. **For Azure Local:** an Azure Local instance with
   - a **custom location** (extendedLocation), and
   - a **logical network** with a defined subnet (static logical networks expose an IP pool; DHCP ones do not).
4. **For Azure Local:** a **free static IP** in the logical network's subnet for the Kubernetes API server (the control-plane VIP). This is the single most important parameter — see §3.

---

## 2. Configure — `deploy/poc/config.env`

Everything is driven from `config.env`; no script hardcodes an id, path, or secret. Edit it, or export any variable before running (every line is `${VAR:-default}`, so an exported env wins).

Key variables and **why**:

| Variable | Example | Why it matters |
|---|---|---|
| `TARGET` | `azure-local` \| `azure` | Which substrate to provision |
| `SUBSCRIPTION` / `RESOURCE_GROUP` | … | Azure scope |
| `CUSTOM_LOCATION` | `…/customLocations/fl-small-gpu-mocarb-cl` | The Azure Local instance to build on (azure-local only) |
| `LOGICAL_NETWORK` | `small-fl-logical-st` | **Use a network with a defined subnet/pool.** A pure-DHCP network has no `addressPrefix`, which complicates the static control-plane IP |
| `CONTROL_PLANE_IP` | `192.168.1.70` | **The API-server VIP — a FREE static IP in the subnet (see §3).** Wrong/occupied IP is the #1 failure |
| `CONTROL_PLANE_VM_SIZE` | `Standard_K8S3_v1` | **Must be an aksarc control-plane size**, not a general VM size |
| `NODE_VM_SIZE` | `Standard_A4_v2` | Worker size; keep modest on small instances |
| `K8S_VERSION` | `1.32.9` | Pin to a version your instance supports (`az aksarc get-versions`) |
| `CONTROL_PLANE_COUNT` / `NODE_COUNT` | `1` / `1` | A 1+1 cluster fits a small single-node Azure Local |
| `ACR` / `IMAGE_NAME` | `lucaexpressacr` / `vosj-ce` | Registry + image |
| `ACR_PULL_SECRET` | `vosj-acr-pull` | Per-namespace docker-registry secret the deploy creates so the cluster can pull the private image. Set `""` if ACR is attached via identity |
| `VOSJ_STATE_STORE` | `memory` | `memory` = no DB (great for a demo); `pg` for persistence |
| `DEVSTATION_COUNT` | `1`–`2` | Number of code-server seats (ephemeral) |

**Secrets are never in `config.env`.** The two fail-closed keys (`VOSJ_LEDGER_HMAC_KEY`, `VOSJ_VAULT_MASTER_KEY`) and the auth token are generated at deploy time with `openssl rand -hex 32` and pushed straight into a Kubernetes Secret. A re-run preserves them (never rotates a live ledger key).

---

## 3. (Azure Local) Choose the control-plane IP — do this carefully

`az aksarc create` needs `--control-plane-ip`: a **static IP** that becomes the Kubernetes API-server endpoint. It must be:
- inside the logical network's **subnet** (e.g. `192.168.1.0/24`),
- **outside** the network's node IP pool (e.g. `.80–.98`),
- **not used** by anything else on the (often shared) subnet — including other clusters' control planes.

**How to find one (the method that this repo's automation uses):**

```bash
# 1. See the subnet + node IP pool of your logical network:
az stack-hci-vm network lnet list -g <rg> -o json   # look at subnets[].properties.addressPrefix + ipPools

# 2. List control-plane IPs already taken by other clusters (avoid collisions):
az aksarc list -o json | grep -i hostIp

# 3. Probe a candidate is free (no reply ≈ free):
ping -n 1 -w 700 192.168.1.70
```

Pick the first non-responding address outside the pool and set `CONTROL_PLANE_IP`. (The repo's `deploy-all` wrapper does this probe automatically in the POC.)

> **Why this is the #1 gotcha:** a generated/guessed control-plane IP that is occupied makes `az aksarc create` fail late and confusingly. Spending 60 seconds here saves a 30-minute failed provision.

---

## 4. Deploy — one command (or stage by stage)

### One command
```bash
cd deploy/poc
./deploy-all.sh --target azure-local           # or --target azure
#   flags: --skip-cluster (use an existing cluster) · --skip-build (reuse the last image)
```
It runs 00→10→20→30→40 with banners and a final summary (cluster, Vosj service, devstation list, access details).

### Stage by stage (recommended the first time, so you can inspect each)
```bash
cd deploy/poc
bash 00-provision-cluster.sh --target azure-local   # ~20–40 min on Azure Local (polls provisioningState)
bash 10-build-image.sh                              # ~30–60 s
bash 20-deploy-vosj.sh                              # ~1–2 min (waits for rollout)
bash 30-deploy-devstations.sh                       # ~1–2 min
bash 40-verify.sh                                   # seconds
```

**What stage 00 actually submits (Azure Local):**
```
az aksarc create -g <rg> -n <cluster> \
  --custom-location <cl> --vnet-ids <logical-network-arm-id> \
  --control-plane-ip <free-static-ip> \
  --control-plane-count 1 --control-plane-vm-size Standard_K8S3_v1 \
  --node-count 1 --node-vm-size Standard_A4_v2 \
  --kubernetes-version 1.32.9 --generate-ssh-keys --no-wait
```
then polls `az aksarc show … --query provisioningState` until `Succeeded`, and fetches an **admin kubeconfig into `deploy/poc/.kube/vosj-poc.config`** (it never touches your `~/.kube/config`).

**What stage 20 does that matters:** creates the fail-closed Secret, then (if the registry is private) mints a `docker-registry` pull secret from `az acr credential show` and wires it via the chart's `imagePullSecrets`, then `helm upgrade --install … --wait`. Without the pull secret a private-ACR image is `ImagePullBackOff` — this guide's automation handles it; if you bring your own chart, ensure the same.

---

## 5. Verify & access

`40-verify.sh` prints PASS/FAIL for `/health` (`ok:true`), `/api/templates` (non-500), and each devstation pod (Running), then the access details:

```bash
export KUBECONFIG="$PWD/.kube/vosj-poc.config"

# Vosj API
kubectl -n vosj port-forward svc/vosj 8080:80 &
curl -s localhost:8080/health
curl -s -H "Authorization: Bearer $(cat .kube/vosj-auth-token)" localhost:8080/api/templates

# A devstation (code-server)
kubectl -n devstations port-forward svc/devstation-1 8081:80 &
kubectl -n devstations get secret devstation-1-secret -o jsonpath='{.data.CODE_SERVER_PASSWORD}' | base64 -d
```

A healthy `/health` looks like:
```json
{"ok":true,"version":"0.1.0","store":"memory","storeOk":true,"ledgerOk":true,"workloads":0,"waves":0}
```

For your first migration walkthrough (workload → 7-R classify → wave → sign gates → reconcile → Jump), follow [`docs/user-guides/01-getting-started.md`](user-guides/01-getting-started.md).

---

## 6. Teardown

```bash
cd deploy/poc
./teardown.sh --yes                    # helm uninstall + delete namespaces + remove local kubeconfig
./teardown.sh --yes --delete-cluster   # also az aksarc/aks delete the cluster
```

---

## 7. Azure vs Azure Local — the differences

| | Azure Local (`--target azure-local`) | Azure (`--target azure`) |
|---|---|---|
| Create | `az aksarc create` | `az aks create` |
| Networking | You supply `--vnet-ids` (logical network) **and a static `--control-plane-ip`** | Managed; no control-plane IP to pick |
| Control-plane size | `Standard_K8S3_v1` (aksarc-specific) | Not applicable |
| ACR | Pull secret (or attach) | `--attach-acr` grants the kubelet identity AcrPull |
| kubeconfig | `az aksarc get-credentials --admin --file` | `az aks get-credentials --admin --file` |

---

## 8. Troubleshooting (from real runs)

| Symptom | Cause | Fix |
|---|---|---|
| Pod `ImagePullBackOff` | Private ACR, no pull secret in the namespace | Ensure `ACR_PULL_SECRET` is set and the ACR admin user is enabled (`az acr update -n <acr> --admin-enabled true`); 20 mints the secret. Or attach ACR to the cluster identity |
| `helm … context deadline exceeded` | Rollout never became ready (almost always the pull failure above) | Fix the pull secret; `helm uninstall` the failed release (or delete the namespace) and re-run 20 |
| `az aksarc create` fails / cluster never reaches `Succeeded` | Occupied or out-of-subnet `CONTROL_PLANE_IP`, or an invalid control-plane VM size | Re-pick a free in-subnet IP (§3); use `Standard_K8S3_v1` |
| `az aksarc create` rejects `--vnet-ids` showing `C:/…/Git/subscriptions/…` | **Git Bash (MSYS) rewrote the leading-slash ARM id into a Windows path** | Wrap the create in `MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'` (the script does) |
| Deploy aborts seconds after submit on `provisionedClusterInstances/default … could not be found` | `az aksarc create` exits non-zero on a transient during submit **while the cluster provisions fine** (`provisioningState=Accepted`) | Don't trust the create exit code — poll the state instead (the script does) |
| The provisioning poll is stuck (state always empty), never sees `Succeeded` | Wrong JMESPath — the field is **nested** | Query `properties.provisioningState`, not top-level `provisioningState` |
| `aksarc` CLI extension install takes ~30 min every run | `--upgrade` re-downloads it | Add only when missing: `az extension show … || az extension add …` |
| `unrecognized arguments` on `stack-hci-vm network lnet show -n` | That subcommand doesn't take `-n` | Use `lnet list -g <rg> -o json` and read the object |
| `az` crashes with a unicode error on Windows | Console encoding | `export PYTHONIOENCODING=utf-8` (config.env sets this) |
| Pod `Pending` / unschedulable on a small node | 1-node Azure Local out of room | Lower `DEVSTATION_COUNT`, shrink VM sizes, or add a node |
| `npm test` fails locally with a secret error | The two keys are fail-closed (no default) | Export `VOSJ_LEDGER_HMAC_KEY` and `VOSJ_VAULT_MASTER_KEY` before `npm test` |

---

## 9. Production notes (beyond the POC)

- **State:** set `VOSJ_STATE_STORE=pg` and supply `PG_*`; run `npm run migrate` (the chart includes a migration Job).
- **Secrets:** keep the ledger HMAC key in a real secret manager; rotating it invalidates the existing tamper-evident chain by design.
- **Devstations:** they are **ephemeral by design** (emptyDir, no PVC) — durable per-pod volumes do not scale on every CSI; persist work to git/DB, not the pod.
- **TLS/ingress, RBAC, waivers, the ledger:** see [`docs/user-guides/07-operations.md`](user-guides/07-operations.md).
