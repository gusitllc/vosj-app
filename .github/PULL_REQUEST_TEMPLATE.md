<!-- Thanks for contributing to Vosj CE. Keep PRs small and focused. -->

## What does this PR do?

<!-- One or two sentences. Link any related issue. -->

## Checklist

- [ ] `npm test` passes locally (all `node:test` suites green) and existing tests are not regressed.
- [ ] `node --check` run on every changed `.js` file.
- [ ] **Connectors/Executors only:** a genuine `verify()` is implemented (no always-`ok:true`), and a test is included with **a passing case and at least one broken case**.
- [ ] No new dependencies — only `express`, `pg`, `dotenv`, and Node.js built-ins.
- [ ] House rules respected: files < 300 lines, functions < 30 lines, <= 3 indent levels; parameterised SQL only; `{ ok, ... }` / `{ ok:false, error }` envelopes; `esc()` on HTML; fail-closed on missing secrets.
- [ ] Invariants respected and **not weakened**: Verified-before-Jump, no-agent-self-sign, separation of duties, tamper-evident ledger, Strangler-Fig-for-high-risk, baseline-drift guard.
- [ ] Conventional Commit title (e.g. `feat(connector): ...`, `fix: ...`, `docs: ...`).
