# CHAPERONE

> **Spending limits don't make agents safe. Verifying what they pay *FOR* does.**

CHAPERONE is mission control for a **fleet** of money-handling AI agents on NEAR.
It watches what agents pay *for* — not just how much — and stops fraud that sails
under every budget cap.

## Problem

Everyone is giving AI agents spending limits. Limits didn't stop the scam that
arrives *under* the limit: an agent dutifully paying a poisoned invoice, a
fabricated "GPU renewal", an attacker-controlled vendor — all inside budget.
Day-one spend guards lock one wallet behind amount caps. Nobody verifies purpose.
We shipped that.

## NEAR

CHAPERONE is NEAR-native end to end:

- **Guard contract (Rust, `contract/`).** Each agent is a NEAR sub-account whose
  only key is a *function-call key restricted to the guard contract* — payments
  physically route through our Rust contract, which holds the signing rights.
  Deterministic checks first: daily allowance, per-payment cap, payee
  allowlist, and a purpose reference that must resolve to a real invoice in the
  books — rejected on-chain, with the reason, in one atomic step.
- **Purpose verification in a TEE.** Every surviving request is judged by a
  NEAR AI Cloud model running inside a TEE. Its verdict is signed; its
  attestation is server-verified (DCAP quote · RTMRS · NVIDIA payload) and shown
  as a binary-honest chip in the UI: `TEE-verified`, `unverifiable`, or
  `deterministic-only`. The app never lies.
- **Humans have the last word.** Mismatches hold the money — one-click
  release/reject, one-click kill-switch (on-chain freeze + key revocation),
  receipts waterfall, exportable audit pack. Every state change emits an
  on-chain event: the audit log *is* the chain.
- **The guard does hold/check/pay — nothing else.** The attack suite is the spec.

## Try it

From a clean clone, no secrets needed:

```sh
npm ci
scripts/deploy-testnet.sh --dry-run   # prints the exact live deploy sequence, changes nothing
scripts/attack-suite.sh               # builds the app, probes every page, runs contract tests, exits 0
```

Then open the fleet in your browser (the suite starts its own server; or run
one yourself with `npm run build && npm run start` and visit
`http://localhost:3000/fleet`).

What those two commands do:

- `deploy-testnet.sh --dry-run` prints `cargo build` → contract deploy →
  `register_agent` × 4 → `seed-books` → `provision-agents` → `list_agents`
  assertion. Add `--live` (with `NEAR_ACCOUNT_ID`/`NEAR_PRIVATE_KEY` set) to
  execute it for real; add `--sandbox` for the offline `near-workspaces`
  round trip instead.
- `scripts/fund-testnet.sh` tops up agents below threshold (faucet first,
  signer transfer fallback); without credentials it prints its plan and exits 0.
- `attack-suite.sh` asserts `GET /api/health` → `{"ok":true}`, `GET /fleet`
  holds 4 agents, `GET /requests` shows a `TEE-verified` row, and
  `GET /api/audit/export?format=csv` starts with
  `request_id,status,verdict_signature,chain_tx` — then runs
  `cargo test -p chaperone-guard`. On-chain gates run too when credentials
  are present, and print `SKIP` otherwise.

Per-script flags, env vars, and the live operator checklist live in
[`scripts/README.md`](./scripts/README.md).

## Limitations

- **Sandbox vs live.** Merge-tier verification is deterministic and offline:
  `--dry-run` prints command sequences, `--sandbox` replays deploy → 4 agents
  → 3 blocks + 1 staged transit → kill-switch + key revoke against a local
  `near-workspaces` sandbox (never testnet, never the faucet). Live testnet
  runs only via explicit `--live` flags with operator credentials.
- **Faucet is an operator step.** Real testnet funding (faucet top-up, signer
  transfers, real-deploy receipts and tx hashes) happens post-merge by the
  operator and is recorded as an issue comment — never baked into the repo.
- **TEE-degradation honesty.** Without a live attestation the UI shows
  `unverifiable` or `deterministic-only`, never `TEE-verified`. Fixture rows
  (fleet agents, request badges, receipt signatures) are labeled display
  placeholders carrying the probe strings with zero credentials — never
  synthesized evidence.
- **No demo video or submission paperwork** in this lap; see
  [`.agents/PRDs/PRD.md`](./.agents/PRDs/PRD.md) for the full product picture.

## The approach

- **Agents can't move money directly.** Each agent is a NEAR sub-account whose
  only key is a *function-call key restricted to the guard contract* — payments
  physically route through our Rust contract, which holds the signing rights.
- **Deterministic checks first.** Daily allowance, per-payment cap, payee
  allowlist, and a purpose reference that must resolve to a real invoice in the
  books — rejected on-chain, with the reason, in one atomic step.
- **Purpose verification, in a TEE.** Every surviving request is judged by a
  NEAR AI Cloud model running inside a TEE. Its verdict is signed; its
  attestation is server-verified and shown as a binary-honest chip in the UI.
- **Humans have the last word.** Mismatches hold the money — one-click
  release/reject, one-click kill-switch, receipts waterfall, audit pack.

## Status

Day 2 of the NEAR hackathon window (submission deadline 2026-11-14). Open
development, in the open:

| Phase | Window | Scope | State |
|---|---|---|---|
| 1 — Guard contract skeleton | Nov 2–3 | allowances · pay · hold/reject · events | in progress |
| 2 — Books + TEE verifier + UI | Nov 4–6 | purpose-refs · attestation pipeline · fleet/feed | next |
| 3 — Attack suite + kill flows + MCP | Nov 7–8 | 3 scripted on-chain blocks + 1 clean transit | planned |
| 4 — Demo + repro + submission | Nov 9–13 | video · one-command replay · freeze | planned |

Full product thinking in [`.agents/PRDs/PRD.md`](./.agents/PRDs/PRD.md) — the
single requirement source for all build work.

Stack: NEAR (Rust near-sdk contract) · NEAR AI Cloud (TEE-hosted purpose model)
· Next.js 15 + TypeScript + Tailwind · Supabase mirror · MCP server
(`policy_get` · `request_payment` · `pending` · `attestations`).

## License

MIT.
