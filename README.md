# CHAPERONE

> **Spending limits don't make agents safe. Verifying what they pay *FOR* does.**

CHAPERONE is mission control for a **fleet** of money-handling AI agents on NEAR.
It watches what agents pay *for* — not just how much — and stops fraud that sails
under every budget cap.

## The problem

Everyone is giving AI agents spending limits. Limits didn't stop the scam that
arrives *under* the limit: an agent dutifully paying a poisoned invoice, a
fabricated "GPU renewal", an attacker-controlled vendor — all inside budget.
Day-one spend guards lock one wallet behind amount caps. Nobody verifies purpose.
We shipped that.

## The approach

- **Agents can't move money directly.** Each agent is a NEAR sub-account whose
  only key is a *function-call key restricted to the guard contract* — payments
  physically route through our Rust contract, which holds the signing rights.
- **Deterministic checks first.** Daily allowance, per-payment cap, payee
  allowlist, and a purpose reference that must resolve to a real invoice in the
  books — rejected on-chain, with the reason, in one atomic step.
- **Purpose verification, in a TEE.** Every surviving request is judged by a
  NEAR AI Cloud model running inside a TEE. Its verdict is signed; its
  attestation is server-verified (DCAP quote · RTMR3 · NVIDIA payload) and shown
  as a binary-honest chip in the UI: `TEE-verified`, `unverifiable`, or
  `deterministic-only`. The app never lies.
- **Humans have the last word.** Mismatches hold the money — one-click
  release/reject, one-click kill-switch (on-chain freeze + key revocation),
  receipts waterfall, exportable audit pack. Every state change emits an
  on-chain event: the audit log *is* the chain.
- **The guard does hold/check/pay — nothing else.** The attack suite is the spec.

## Status

Day 2 of the NEAR hackathon window (submission deadline 2026-11-14). Open
development, in the open:

| Phase | Window | Scope | State |
|---|---|---|---|
| 1 — Guard contract skeleton | Nov 2–3 | allowances · pay · hold/reject · events | in progress |
| 2 — Books + TEE verifier + UI | Nov 4–6 | purpose-refs · attestation pipeline · fleet/feed | next |
| 3 — Attack suite + kill flows + MCP | Nov 7–8 | 3 scripted on-chain blocks + 1 clean transit | planned |
| 4 — Demo + repro + submission | Nov 9–13 | video · one-command replay · freeze | planned |

Full product thinking in [`.agents/PRDs/PRD.md`](./.agents/PRDs/PRD.md); the
original build brief is [`near-chaperone-brief.md`](./near-chaperone-brief.md).

Stack: NEAR (Rust near-sdk contract) · NEAR AI Cloud (TEE-hosted purpose model)
· Next.js 15 + TypeScript + Tailwind · Supabase mirror · MCP server
(`policy_get` · `request_payment` · `pending` · `attestations`).

## License

MIT.
