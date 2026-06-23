# Vosj POC — Pre-Merge Reverse-Engineering Audit (2026-06-22)

**Verdict: GO — merge approved.** Six independent reviewers reverse-engineered the
full POC stack; the test suite is **92/92 green**. Five of six lenses returned a
clean GO; the sixth (secrets/exposure) returned GO-WITH-FIXES whose sole "blocker"
is the **public Cloudflare demo tunnel — an explicitly-accepted POC trade-off, not
a code defect**. All five hard invariants are enforced structurally, auth is
fail-closed, and every secret is a freshly-generated 256-bit value, never committed.

The findings below are **defense-in-depth + pre-production hardening**, tracked to
closure. None blocked the merge.

## Method

A 6-lens reverse-engineering workflow (parallel `Explore` reviewers, each reading
the real code, → one synthesis). Lenses:

| Lens | Scope | Readiness |
|------|-------|-----------|
| Engine + invariants | `src/engine/*`, `src/ledger/*` + invariant tests | **GO** |
| REST API + auth + DB | `src/api/*`, `src/db/pool.js`, `src/config.js` | **GO** |
| Command Center UI | `public/index.js` ↔ `routes.js` contracts, XSS | **GO** |
| Seat Manager (privileged) | `deploy/poc/seat-manager/*` | **GO** |
| Deploy automation | `deploy/poc/*.sh`, manifests, image, tunnel | **GO** |
| Secrets + public exposure | whole repo + tunnel risk | **GO-WITH-FIXES** |

**Confirmed sound (no action):** all 5 hard invariants enforced structurally
(verified-before-Jump, no-agent-self-sign, separation-of-duties, Strangler-Fig for
high-risk, HMAC-chained fail-closed ledger); every mutating route carries
`requireCapability`; the bearer principal is `agent`-kind so it cannot self-sign;
all SQL parameterised; constant-time secret comparison; UI escapes every server
value into the DOM and aligns with all 12 API contracts; deploy scripts idempotent
+ fail-closed with no committed secrets; `.kube/*` gitignored.

## Follow-up tracker

Drive these to closure as post-POC hardening (before any non-POC / customer use).

| ID | Sev | Area | Action | Status |
|----|-----|------|--------|--------|
| AUDIT-01 | major | engine/gate | At the cutover gate, re-verify `proof.hash === hashProof(proof)` so a third-party connector cannot forge `{ok:true, hash:'…'}`. `gate.js:47` / `state-machine.js:95`. | Open |
| AUDIT-02 | major | ledger | `_prevHash()` null-guard: `return (last && last.hash) ? last.hash : GENESIS` so a corrupted store can't silently break the chain. `ledger.js:43`. | Open |
| AUDIT-03 | minor | engine/waiver | Make `isWaivable()` reject undefined/null `check.name` explicitly before the list compare. `waiver.js:40`. | Open |
| AUDIT-04 | major | seat-manager | Rate-limit `POST /api/seats/:id/assign` (e.g. 1 req/5s/IP) + audit-log every assign (seat id, mode, key-hint — never the key); validate the admin key is non-empty + ≥32 chars. | Open |
| AUDIT-05 | major | devstation | Harden code-server before wider use: `--disable-file-uploads`, front with an oauth2-proxy/auth sidecar (a leaked seat password = RCE as `coder` with the Claude credential in env). | Open |
| AUDIT-06 | major | config/auth | Explicit startup hard-fail when `AUTH_MODE=token && !AUTH_TOKEN` (today: implicit per-request 503); mark `AUTH_MODE=open` DEV-ONLY in docs. | Open |
| AUDIT-07 | major | `.env.example` | Document the REQUIRED fail-closed secrets (`VOSJ_AUTH_TOKEN`, `VOSJ_LEDGER_HMAC_KEY`, `VOSJ_VAULT_MASTER_KEY`) so an operator can't deploy half-configured. | Open |
| AUDIT-08 | blocker* | tunnel | *Accepted POC trade-off.* Public tunnel (`demo`/`seats`/`seat1-5.vosj.com`) is POC-only; document POC-only in `DEPLOYMENT.md`, add a Cloudflare WAF rate-limit on `/api/seats/*`, and treat tunnel teardown as mandatory. | Accepted / Teardown |
| AUDIT-09 | major | `.kube/*` creds | Post-demo: rotate cluster credentials; replace the long-lived auth token with a short-TTL `TokenRequest`; give the Vosj API a minimal-RBAC ServiceAccount (own namespace, not admin). | Teardown |
| AUDIT-10 | minor | tunnel | Add `deploy/poc/99-cleanup-tunnel.sh` to delete the named CF tunnel + DNS on teardown (else dead CNAMEs linger). | Open |
| AUDIT-11 | minor | tunnel script | `unset CLOUDFLARE_API_KEY` after `cf-tunnel-setup.cjs`; prefer a scoped CF API token over the global key. | Open |
| AUDIT-12 | minor | UI | Add a token-handling warning to `docs/user-guides/06-command-center.md` + a "Clear token" button. | Open |

\* AUDIT-08 is the lone audit "blocker" and is an accepted POC trade-off, not a
code defect — see verdict above.

## Provenance

- Workflow run: `wf_44221daa-c88` (6 reviewers + synthesis), 2026-06-22.
- Test baseline at audit time: `VOSJ_LEDGER_HMAC_KEY=… VOSJ_VAULT_MASTER_KEY=… npm test` → **92 tests, 92 pass, 0 fail** (incl. `test/config.test.js`, the SSL off-switch regression cover added during this review).
