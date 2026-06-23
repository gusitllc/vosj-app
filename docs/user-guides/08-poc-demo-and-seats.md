# 08 — The POC Demo: Command Center, Seats & Devstations

This guide is the **hands-on walkthrough for the live POC demo** running on the
`vosj-poc` cluster: the public URLs, how to drive the Command Center, how to assign
a Claude credential to a devstation seat with the **Seat Manager**, and how to open
a devstation. It complements [06 — The Command Center](./06-command-center.md)
(which documents the migration UI itself) and
[`deploy/poc/`](../../deploy/poc/) (the codified deploy).

> Secrets (the Seat Manager admin key and the per-seat passwords) are **not printed
> in this guide** — it gives you the one-line command to read each from the cluster.
> All surfaces below are reached through a Cloudflare tunnel; the demo is POC-only.

## 1. The public URLs

| URL | What it is |
|-----|------------|
| **https://demo.vosj.com** | The **Vosj Command Center** — the migration workstation (workloads, waves, gate signing, reconcile, ledger). |
| **https://seats.vosj.com** | The **Seat Manager** — assign a Claude credential to each devstation seat. |
| **https://seat1.vosj.com** … **https://seat5.vosj.com** | The 5 **devstations** — a code-server IDE with the `claude` CLI. |

`kubectl` access (for the admin key + passwords below) uses the POC kubeconfig:
```bash
export KUBECONFIG="$(pwd)/deploy/poc/.kube/vosj-poc.config"   # from the repo root
```

## 2. Use the Command Center (demo.vosj.com)

1. Open **https://demo.vosj.com** (or `/app.html` for the focused board).
2. In the **Bearer** field, paste the Vosj auth token:
   ```bash
   kubectl -n vosj get secret vosj-secret -o jsonpath='{.data.VOSJ_AUTH_TOKEN}' | base64 -d
   ```
   Click **Save**.
3. Drive a migration end-to-end (full detail in [06](./06-command-center.md) and
   [01](./01-getting-started.md)): **add a workload → Classify** (its 7-R
   disposition) **→ create a wave** from a template **→ sign the gate** (in the
   Human Gate Sign panel, enter a signer + role, then "Sign gate → P2") **→
   Reconcile** a unit **→ Verify Chain** in the ledger. The demo already carries a
   sample wave (`wave-smoke` at P2) and workload (`wl-smoke`).

## 3. Assign a Claude credential to a seat (seats.vosj.com)

This is how you "give a devstation a Claude license."

1. Open **https://seats.vosj.com**.
2. Paste the **Seat Manager admin key** (read it once from the cluster):
   ```bash
   kubectl -n devstations get secret seat-manager-admin \
     -o jsonpath='{.data.SEAT_MANAGER_ADMIN_KEY}' | base64 -d
   ```
3. Each of the 5 seats shows its current mode (`unassigned` until you set one).
   For a seat, pick the **mode** and paste the matching key:
   - **Hybrid** — interactive code-server + Claude Code on a Max subscription →
     paste the **OAuth key** (`CLAUDE_CODE_OAUTH_TOKEN`).
   - **AI-only** — headless / programmatic Claude → paste the **API key**
     (`ANTHROPIC_API_KEY`).
4. Click **Assign**. The Seat Manager writes that seat's `devstation-<i>-env`
   Secret (the chosen credential + mode, worker enabled) and **restarts the seat**.
   Within ~20s the seat is running with `claude` wired to your credential.

The Seat Manager never displays a stored key back — only a last-4 hint and the
mode. To change a seat, just assign again.

## 4. Open a devstation (seat1–5.vosj.com)

1. Open **https://seat1.vosj.com** (…`seat5`).
2. Enter the seat's code-server password:
   ```bash
   kubectl -n devstations get secret devstation-1-env \
     -o jsonpath='{.data.CODE_SERVER_PASSWORD}' | base64 -d   # swap -1 for -2..-5
   ```
3. You get a full VS Code / code-server IDE. Open a terminal and run **`claude`** —
   it authenticates with the credential you assigned in step 3 (a Max-subscription
   login in Hybrid mode, or the API key in AI-only mode). Assign a credential first;
   a fresh seat has no Claude credential and the worker stays off.

## 5. How many seats?

The POC starts with **5** seats. The count is set in
[`deploy/poc/config.env`](../../deploy/poc/config.env) (`DEVSTATION_COUNT`, default
5) and is user-selectable at deploy time:
```bash
./deploy/poc/deploy-all.sh --target azure-local --devstation-count 8   # 8 seats
```

## 6. Notes & limits (POC)

- The POC seats run a **lean look-alike image** (`vosj-devstation:poc` =
  code-server + the Claude Code CLI), not the heavier internal fleet image —
  functionally the same IDE + credential model.
- All surfaces are behind a **public Cloudflare tunnel** and are **POC-only**:
  the Command Center is bearer-token gated, the Seat Manager is admin-key gated,
  and each devstation is password gated. See the hardening + teardown items in
  [`docs/audits/PREMERGE-AUDIT-2026-06-22.md`](../audits/PREMERGE-AUDIT-2026-06-22.md)
  before any non-POC exposure (rotate credentials and tear the tunnel down after
  the demo).
