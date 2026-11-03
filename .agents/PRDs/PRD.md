---
type: prd
project: chaperone
status: draft
created: 2026-11-03
source: near-chaperone-brief.md + brainstorm session Nov 3 + verified NEAR AI/Tidepool recon
---

# PRD — CHAPERONE

*Purpose verification for fleets of money-handling agents on NEAR.*

**Competition context:** NEAR Hackathon, repo public before 2026-11-14T23:59Z, single uneditable submission, AI-screened then human-judged. Tracks: `security` (primary), `agents`, tag `privacy`. Ships standalone **only if** a human co-lead owns the submission (Techa's email is capped at 2 submissions, taken by SERVITOR + FOREMAN) — decision gate Nov 7/9. Otherwise CHAPERONE folds in as SERVITOR/FOREMAN's policy layer. This PRD assumes the standalone track (per owner decision Nov 3: "just build"), with the fold-in path preserved: everything through Phase 3 is reusable as the embedded policy layer.

**Build rules (binding on every agent, and on any plan/implement/review prompt or doc derived from this file):**
- **Q-015 (hard rule):** no agent may ever read `near-chaperone-brief.md`. This PRD is the **sole** requirement source. The Books component and all sample data must stay independent of SERVITOR/FOREMAN — no sibling-repo code, briefs, or docs, ever.
- Lap 1 is a **walking skeleton**: the contract crate compiling with its first green unit tests, a minimal Next.js 15 app shell serving `/api/health`, and a CI workflow (`.github/workflows/ci.yml`) that runs `cargo test` for the contract and builds the app. The factory merge gate autodetects checks (`required_checks: ["*"]`). **`/api/health` contract: HTTP 200, body exactly the JSON `{"ok":true}`** — this shape is pinned because the verifier scenario asserts it.
- Demo video, Verification-Center footage, co-lead coordination, and the final submission (§12 Phase 4) are **operator-run** — they must not become agent build issues.

---

## 1. Executive Summary

Everyone is giving AI agents spending limits. Limits did not stop the scam that arrives *under* the limit — an agent dutifully paying a poisoned invoice, a fabricated GPU renewal, an attacker-controlled "vendor" inside budget. The field named this gap publicly on hackathon day 1; nobody shipped it. CHAPERONE ships it.

CHAPERONE is **mission control for a fleet of money-handling agents**. Where day-one "spend guards" lock one wallet behind amount caps, CHAPERONE governs a workforce: each agent is a NEAR sub-account whose only key is a function-call key restricted to the **guard contract** — it literally cannot move money any other way. Every payment request must carry a **purpose** (vendor, amount, reference to a real invoice or order). Deterministic checks run first (daily allowance, per-payment cap, payee allowlist, purpose-ref exists and covers the amount). Then a **TEE-hosted model on NEAR AI Cloud** judges request-versus-reason consistency; its verdict is signed, its attestation is server-verified, and the UI shows a binary-honest "TEE-verified" chip. Mismatches hold the money for a human. Everything — requests, verdicts, holds, kills, payments — emits on-chain events: the audit log *is* the chain.

**MVP goal:** a standalone hackathon submission by Nov 13 that demonstrably blocks three scripted fraud attacks on-chain (over-allowance, non-allowlisted payee, purpose-mismatch), lets one clean payment transit with the full attestation chain visible, manages ≥4 independent agents, and replays its attack suite one-command from a fresh clone.

## 2. Mission

**Mission statement:** *Make agent spending safe by verifying what agents pay FOR — with enforcement that lives on-chain and evidence a stranger can audit.*

**Core principles:**

1. **Purpose, not just amount.** An allowance is a ceiling; purpose verification is the judgment.
2. **Enforcement lives in the contract, not the app.** The app can't pay anyone. The contract's checks are the only checks that matter.
3. **The attestation is honest or absent.** If the TEE chain verifies, show the chip. If it doesn't, the UI says exactly that — the app never lies, never degrades silently.
4. **Humans have the last (and fastest) word.** One-click kill-switch, one-click approve/reject on holds, receipts forever.
5. **The guard does hold/check/pay — nothing else.** Attack suite is the spec; feature creep is the enemy (v1 hard rule from brief §6).

## 3. Target Users

| Persona | Who | Technical comfort | Needs / pains |
|---|---|---|---|
| **Fleet operator** (primary) | Runs 4+ AI agents that spend real money (invoice payment, GPU rental, supplier orders) | Developer-grade; comfortable with wallets, testnets, MCP | Wants to see *what* agents pay for, block fraud before money moves, freeze a rogue agent instantly, and produce an audit trail for the boss/auditor/judge |
| **MCP operator** (primary-adjacent) | Drives agents from Claude/any MCP client and wants payments available as a tool — *guarded* | High | Wants to *feel* the guard refuse a bad request from inside the chat, without leaving Claude |
| **Hackathon judge** (audience, must convince) | AI screen then human judge; unknown background, ~5 min attention | Mixed | Needs the problem legible in seconds, the money-shot (poisoned request blocked on-chain) undeniable in a minute, the NEAR-native fit explicit |

## 4. MVP Scope

### In scope

**Core functionality**
- [ ] Guard contract (Rust, near-sdk 5): fleet treasury (deposit/withdraw), agent registry with per-agent policy (daily allowance, per-payment cap, payee allowlist, active flag), `request_payment`, signed-verdict intake, hold → human approve/reject, kill-switch, event emission for every state change
- [ ] Deterministic checks (in-contract): agent active, per-payment cap, daily allowance (UTC-day), payee allowlisted, purpose-ref exists/open, amount ≤ purpose-ref cap
- [ ] Books: independent, tiny in-app ledger of invoices/orders (id, vendor, cap) mirrored on-chain via `register_purpose_ref` — *fully independent data model, no SERVITOR code or briefs read (Q-015)*
- [ ] Purpose verifier service: NEAR AI Cloud TEE-hosted model judges request-vs-reason; verdict Ed25519-signed; contract verifies signature before any payment
- [ ] Attestation pipeline: preflight attestation report with random nonce → server-side verification (DCAP quote, RTMR3 event-log replay, MRCONFIGID via app_compose, NVIDIA GPU payload via NRAS) → store verified `signing_address` → response signature recovery per completion → match → badge
- [ ] Operator web app: fleet dashboard (agents, allowances, remaining-today), live request feed with purpose chips + attestation badge, approval queue (holds), kill-switch button, receipts waterfall, exportable audit pack (JSON + CSV of on-chain events), wallet login
- [ ] MCP server: `policy_get`, `request_payment` (guarded), `pending`, `attestations`
- [ ] Attack suite: 3 scripted attacks blocked on-chain (over-allowance, non-allowlisted payee, poisoned purpose-mismatch to attacker address) + 1 clean transit with full attestation chain shown
- [ ] Repro: fresh clone → attack suite replays one-command against a fixture chain state; plus a live small demo path

**Technical**
- [ ] Agent sub-account provisioning: locked account + function-call key restricted to the guard contract (`allowance` set via `promise_batch_action_add_key_with_function_call` path; document the allowance=0-means-unlimited gotcha)
- [ ] Key revocation demo flow (near-api-js): kill-switch freezes on-chain while the provisioning backend deletes the agent's key off-chain — defense in depth
- [ ] On-Demand attestation badge state machine: `verified | unverifiable | deterministic-only` surfaced literally in the UI

**Integration**
- [ ] Supabase mirror: policies, requests, verdicts, audit events (queryable backing for the UI waterfall)
- [ ] NEAR testnet deployment + faucet funding scripts; mainnet dust only for final footage

### Out of scope (v1)
- [ ] Zero-knowledge proofs (Gloam noted; out of window)
- [ ] ML risk-model training beyond the hosted purpose-verifier prompt
- [ ] Non-NEAR chains, mobile apps
- [ ] Tidepool / 1Click swap UX (Tidepool verified as a community swap-only sandbox — wrong tool)
- [ ] BYOM: deploying our own model into NEAR AI TEE (catalog models only, verified recon)
- [ ] Browser-side attestation verification (browsers can't verify the TLS binding; verification is server-side by design)

## 5. User Stories

1. As a **fleet operator**, I want to see every agent with its allowance, cap, and remaining-today budget, so that I know the fleet's blast radius at a glance.
   - *Example:* Dashboard shows 4 agents; `agent-1` spent 30 N of 50 N today; `agent-3` is frozen.
2. As a **fleet operator**, I want a payment request to arrive with a purpose and a TEE-verified chip, so that I can trust (or challenge) *why* money is moving.
   - *Example:* "agent-1 → CoreWeave → 30 N, FOR invoice #114" shows a green `TEE-verified` chip; clicking it shows the attestation details.
3. As a **fleet operator**, I want a poisoned request (attacker-controlled payee, purpose that doesn't hold) to be **blocked on-chain** with the reason displayed, so that fraud never becomes my loss.
   - *Example:* Attacker invoice to `attacker.near` fails allowlist instantly; a purpose-mismatch (right payee, wrong reason) gets rejected by the TEE model and lands in the approval queue with the verifier's objection.
4. As a **fleet operator**, I want to freeze any agent with one click so that a compromised agent stops spending before I've diagnosed it.
   - *Example:* Click kill → on-chain active=false + agent's function-call key deleted; other 3 agents unaffected.
5. As a **fleet operator**, I want held requests queued for my judgment so that ambiguous-but-legit payments can be released and junk rejected.
   - *Example:* "GPU renewal pitched as 'invoice #114'" waits in queue; I approve — it pays — or reject — it's recorded as such, forever.
6. As an **MCP operator**, I want `request_payment` to feel the guard refuse from inside Claude, so that the guard is real in the tools I already use.
   - *Example:* Claude asks for a 400 N payment; MCP returns the on-chain rejection reason, not an app-side "no".
7. As an **auditor/judge**, I want an exportable audit pack so that every payment decision is traceable end-to-end.
   - *Example:* One click downloads JSON+CSV: request → deterministic result → verdict + verdict signature → attestation state → payment/hold event, all referencing on-chain tx/receipt ids.
8. As a **developer re-running the demo**, I want the attack suite to replay one-command from a fresh clone so that reproducibility is trivial.
   - *Example:* `./scripts/attack-suite.sh` provisions fixture state on testnet, fires all 3 attacks + 1 clean transit, prints pass/fail per gate.

**Technical stories**
9. As the **contract**, I hold the fleet treasury and sign payments *only* after deterministic checks + a verifier-signed verdict, so that no client or app can bypass policy.
10. As the **verifier service**, I pre-verify the TEE attestation with a fresh nonce and match each completion's recovered signer to the verified report, so that the badge reflects reality or doesn't render.

## 6. Core Architecture & Patterns

```
                       ┌─────────────────────────────┐
                       │  Operator web app (Next.js) │
                       │  fleet · feed · queue · kill │
                       └──────┬──────────────┬───────┘
                              │ wallet login │ read mirror / write via wallet
                    ┌─────────▼───┐   ┌──────▼─────────┐
                    │  Supabase   │   │ Guard contract │◄─── function-call keys
                    │ (mirror of  │   │ (Rust, NEAR)   │     restricted to guard
                    │ on-chain    │   │ treasury ·     │      `request_payment`
                    │ state+audit)│   │ checks · holds │
                    └─────────▲───┘   └───┬───────▲────┘
                              │           │       │ signed verdict (Ed25519)
                   ┌──────────┴───┐   ┌───┴──────────────┐
                   │ Books (tiny  │   │ Verifier service │──► NEAR AI Cloud
                   │ ledger: refs │   │ (VPS, TS)        │    TEE model · attestation
                   │ vendor, cap) │   └──────────────────┘    verify: DCAP · RTMR3 ·
                   └──────────────┘                            MRCONFIGID · NVIDIA NRAS
                                        ▲
                              ┌─────────┴────────┐
                              │ MCP server (TS)  │◄── Claude / any MCP client
                              │ policy_get ·     │
                              │ request_payment ·│
                              │ pending ·        │
                              │ attestations     │
                              └──────────────────┘
```

**Directory structure**

```
chaperone/
├── contract/          # guard contract (Rust, near-sdk 5) + unit tests = attack-suite spec
│   └── src/           # lib.rs (Guard), policy.rs, request.rs, books.rs, verifier.rs, events.rs, tests.rs
├── app/               # Next.js 15 + TS + Tailwind (fleet UI, queue, receipts, audit pack)
├── mcp/               # MCP server (official TS SDK) on the VPS, live through Nov 18+
├── scripts/           # provisioning, key rotation/revoke, attack suite, funding
└── docs/              # this PRD, brief, phase notes
```

**Key design patterns**
- **Deterministic-first, judgment-second:** contract rejects instantly on hard rules; only surviving requests get the model's judgment; mismatches hold for humans.
- **Signed verdicts, permissionless submission:** anyone may post a verdict to the contract — the Ed25519 signature over the canonical payload (context → request id → agent → payee → amount → purpose-ref → verdict byte) is the authorization.
- **Binary-honest attestation:** UI badge states are `TEE-verified` / `attestation unverifiable` / `deterministic-only`; never a gradient.
- **Events as the audit log:** every mutation emits a `chaperone/1.0.0` standard-format event; Supabase is a *mirror*, the chain is the source.
- **Sequenced request ids:** monotonic `request_seq` makes verdict payloads canonical and replay-safe.

## 7. Tools / Features

### 7.1 Guard contract API (Rust, near-sdk 5)

| Method | Caller | Purpose |
|---|---|---|
| `new(owner_id?)` | init | Set fleet owner; empty registries |
| `register_agent(agent_id, daily_allowance_yocto, per_payment_cap_yocto, payee_allowlist)` | owner | Onboard an agent with its policy |
| `set_agent_policy(agent_id, daily?, cap?)` | owner | Tune allowances |
| `add_payees / remove_payees` | owner | Manage allowlist |
| `set_agent_active(agent_id, active)` | owner | **Kill-switch / revive** |
| `set_verifier(public_key_base58?)` | owner | Register/rotate verifier Ed25519 key |
| `register_purpose_ref(ref_id, vendor, max_amount_yocto?)` | owner | Books → chain: an invoice/order the agents may pay |
| `close_purpose_ref(ref_id)` | owner | Books → chain: closed/reconciled |
| `deposit_fleet_funds` `#[payable]` | anyone | Fund the treasury |
| `withdraw_fleet_funds(to, amount)` | owner | Govern leftover funds |
| `request_payment(payee, amount_yocto, purpose_ref, vendor) → request_id` | **agent's function-call key** | The guarded door. Deterministic checks; reject-and-record, or stage for verdict |
| `submit_verdict(request_id, consistent, signature_base58)` | anyone w/ valid verifier sig | Consistent → pay; inconsistent → hold |
| `approve_hold(request_id)` / `reject_hold(request_id)` | owner | Human release/reject on held payments |
| views: `get_agent · list_agents · get_request · list_requests · list_queue · get_purpose_ref · list_purpose_refs · fleet_summary · treasury · get_verifier` | anyone | UI + audit backing |

Events (`chaperone/1.0.0`): `agent_registered · policy_updated · payees_updated · agent_killed · agent_reenabled · verifier_set · purpose_ref_registered · purpose_ref_closed · funds_deposited · funds_withdrawn · request_created · request_rejected · verdict_recorded · request_held · request_paid`.

### 7.2 Purpose verifier (VPS service)

1. **Preflight (once per verifier key / on rotation; nonce per request):** `GET cloud-api.near.ai/v1/attestation/report?model=<id>&provider=near&include_tls_fingerprint=true&signing_algo=ecdsa&nonce=<random-64-hex>` with `x-no-aliasing: true` → verify Intel quote (dcap-qvl), replay event log → RTMR3, SHA-256(app_compose) → MRCONFIGID, `request_nonce` == ours, NVIDIA payload via `POST nras.attestation.nvidia.com/v3/attest/gpu` → store verified `signing_address`.
2. **Judge (per request):** OpenAI-compatible chat completion via `cloud-api.near.ai/v1` (catalog model), `Accept-Encoding: identity`, retain exact request/response bytes, prompt compares request (vendor/amount/ref) against the reason and returns `consistent | inconsistent` + objection.
3. **Bind (per request):** `GET /v1/signature/<chat_id>?signing_algo=ecdsa` → EIP-191 ECDSA recover over `<MODEL_ID>:<sha256(req)>:<sha256(res)>` → must equal stored `signing_address`.
4. **Attest:** sign the contract-bound verdict payload with the registered Ed25519 key; submit on-chain.
5. **Badge truth:** only step-verified chains render `TEE-verified`; any failure renders `attestation unverifiable`; system down → `deterministic-only`, labeled.

### 7.3 Operator app pages

- **Fleet** — agent cards (allowance, remaining-today, active), add/edit agent, treasury balance.
- **Requests feed** — every request (paid/held/rejected/awaiting-verdict) with purpose chip + attestation state; poisoned rows highlighted with reasons.
- **Approval queue** — held requests with objection text; approve/reject in one click; killed-agent banner on affected rows.
- **Receipts & audit** — receipts waterfall per agent; `Export audit pack` (JSON+CSV).
- **Settings** — verifier key rotation with badge-state preview; kill-switch confirmations single-tap, revivable.

### 7.4 MCP server

| Tool | Arguments | Behavior |
|---|---|---|
| `policy_get` | `agent_id?` | Returns live on-chain policy for the agent(s) |
| `request_payment` | `payee, amount_near, purpose_ref, vendor` | Signs with the *agent's* function-call key through the guard; returns on-chain accept/reject + reason verbatim |
| `pending` | — | Held requests + objections |
| `attestations` | `request_id` | Attestation state + verification details for a request |

## 8. Technology Stack

| Layer | Choice | Notes (verified Nov 3 recon) |
|---|---|---|
| Contract | Rust + near-sdk 5, WASM target `wasm32-unknown-unknown` | `UnorderedMap` state, standard-format events, `env::ed25519_verify` for verdict signatures |
| Purpose model | NEAR AI Cloud, `https://cloud-api.near.ai/v1`, OpenAI-compatible SDK | Live; ~65 catalog models; **no BYOM** — pick a catalog model; credits purchase required (no free tier documented) |
| Attestation | `/v1/attestation/report`, `/v1/signature/<chat_id>`, NVIDIA NRAS | Server-side only (no browser TLS-binding verification); reference impl `near-examples/nearai-cloud-verification-example`; no-code fallback `cloud.near.ai/verify` for demo footage |
| App | Next.js 15, TypeScript, Tailwind CSS | Vercel-deployable or VPS |
| Mirror | Supabase (Postgres) | Policies, requests, verdicts, audit events |
| Wallet/login | NEAR wallet login (near-api-js) | Operator only; agents never hold master keys |
| Keys | near-api-js provisioning + revoke scripts | FC key restricted to guard contract; **allowance=0 means unlimited** when set via contract `promise_batch` — set explicit allowances; lock agent accounts after provisioning |
| MCP | Official TS SDK (`@modelcontextprotocol/sdk`) | On VPS; live through Nov 18+ |
| Chains | **Plain NEAR testnet** for dev/demo; mainnet dust for final footage | **Tidepool rejected** (recon): community swap-only sandbox for 1Click Intents — not a general contract environment |
| Test deps | `ed25519-dalek` (dev) + `bs58` | Real signature verification in unit tests |

## 9. Security & Configuration

**Authentication / authorization**
- Operator UI: NEAR wallet login; admin methods gated by contract `owner` (predecessor must equal fleet owner).
- Agents: locked sub-accounts; **only** a function-call key restricted to the guard contract's methods — no transfer capability, no key management, by NEAR protocol design.
- Verifier: Ed25519 key registered on-chain by owner; verdict signatures verified in-contract; submission is permissionless but signature-gated.

**Attestation security**
- Fresh random nonce per attestation call (anti-replay); `x-no-aliasing: true` (anti-instance-aliasing).
- Known recon caveat: NEAR AI docs admit the flow "does not yet form a complete model-to-Gateway-to-final-response chain," and instances may share signing keys with different configs → verify `signing_address` per completion, re-run preflight on rotation, and keep the badge honest when checks fail.

**Configuration (env, VPS secret store)**
- `NEAR_NETWORK=testnet|mainnet`, `GUARD_CONTRACT_ID`, `FLEET_OWNER_ACCOUNT`, `NEAR_AI_API_KEY`, verifier `SIGNING_KEY` (never in app/email/git), `SUPABASE_URL` + service key, MCP port.

**Security scope** — in: key-scope design, on-chain enforcement, signature verification, attestation verification, event audit. Out: ZK, key sharding, MEV/front-running UX, production treasury sizing.

## 10. API Specification

### 10.1 Contract — verdict payload (must be byte-stable)

```
payload = "chaperone-verdict-v1"
        || le_u64(request_id)
        || agent_id_bytes || payee_id_bytes
        || le_u128(amount_yocto)
        || purpose_ref_utf8
        || verdict_byte      // 1 = consistent, 0 = inconsistent
verdict = ed25519_sign(verifier_key, payload)   // base58 in the call
```

### 10.2 Verifier service (internal, TS)

```
POST /verify            { request_id }          → { consistent, objection?, signature }
GET  /attestation/status                        → { badge: "verified"|"unverifiable"|"deterministic-only", details }
POST /attestation/preflight { model }           → { signing_address, verified: true }
```

### 10.3 MCP tools — example

```jsonc
// request_payment call
{ "payee": "coreweave.near", "amount_near": "30", "purpose_ref": "invoice-114", "vendor": "CoreWeave" }
// guard refuses (example)
{ "status": "rejected", "request_id": 7, "reason": "PayeeNotAllowlisted",
  "chain_ref": "8kF3…tx", "note": "attacker.near is not on agent-1's allowlist" }
```

## 11. Success Criteria

**MVP success = the submission ships Nov 13 under a co-lead's name with every eval gate green** (or, if folded, ships *inside* SERVITOR + FOREMAN with policy credit — gates 1–2 then run against their integration).

**Functional requirements**
- [ ] 3 scripted attacks blocked **on-chain**, reasons recorded as events (attack gate)
- [ ] 1 clean transit end-to-end with attestation chain shown (attack gate)
- [ ] ≥4 agents under management, independent allowances; killing one blocks only that agent (fleet gate)
- [ ] Fresh clone → attack suite replays one-command (repro gate)
- [ ] Verification Center / no-code path can double-check our badge claim live
- [ ] README machine-pass: problem (agents hold money) · NEAR fit (function-call keys, NEAR AI TEE, own contract) · try-it · limitations · MIT

**Quality indicators**
- Contract unit tests green (attack suite as spec) after first compile pass
- 60–75s demo video hitting the script beats (§demo of brief)
- App never shows a fake badge (spot-check: kill the verifier → badge degrades, labeled)

**UX goals**
- Judge "gets it" in ≤30s from the landing video/frame
- Kill→freeze→unaffected-others is visible in one screen
- Money-shot (blocked poisoned payment with reason) is one click from the landing page

## 12. Implementation Phases

**Phase 1 — Contract skeleton + env truth (Nov 2–3)** ✅ env decided via recon
- Goal: the guard exists, checks are real, tests are the spec.
- [x] Rust/scaffold decisions; testnet-over-Tidepool verified; attestation pipeline verified
- [ ] Contract source: policy/request/books/verifier/events + owner & agent surfaces
- [ ] Unit tests: 5 deterministic rejects, kill-switch, hold→approve/reject, sig-fail, day-roll
- [ ] *Needs a Rust toolchain to compile/test — tool forbidden locally by owner (Nov 3); compile pass either via owner-approved env or DOES-provided runner*
- Validation: `cargo test` green (once toolchain available); attack-relevant checks serially covered

**Phase 2 — Books, verifier, first UI (Nov 4–6)**
- Goal: purpose verification real end-to-end.
- [ ] Independent books model + `register_purpose_ref` mirror; sample invoices
- [ ] Verifier service: preflight → judge → bind → sign→submit; badge state machine
- [ ] App: fleet view + request feed w/ purpose chips + honest badge
- Validation: one clean payment transits with `TEE-verified` chip; poisoned payload holds with objection text

**Phase 3 — Attack suite, kill flows, MCP (Nov 7–8)**
- Goal: the demo's spine is scripted and green.
- [ ] Provisioning scripts (locked agent accounts, restricted FC keys, allowance≠0)
- [ ] Attack suite: 3 blocks + 1 transit, one-command replay w/ fixtures
- [ ] Kill-switch on-chain + key-revoke demo; fleet unaffected proof
- [ ] MCP server w/ 4 tools against guard
- Validation: `scripts/attack-suite.sh` all-green from clean clone; MCP refusal shows raw on-chain reason
- **Nov 7: co-lead confirmation checkpoint · Nov 9: go/no-go** (fold path: policy layer + README credits, stop standalone spend)

**Phase 4 — Polish, footage, submit (Nov 9–13)**
- Goal: judged-on merits.
- [ ] Demo video (60–75s per brief beats); Verification Center footage
- [ ] README (machine-pass checklist) + attack-suite docs; mainnet dust clip
- [ ] Freeze repo pre-submit; submit under co-lead identity (Techa listed as team member)
- Validation: repro gate from a third-party clone; all gates green in video

**Operator-run — keep off the agent backlog:** demo video · Verification-Center footage · co-lead coordination · final submission · repo freeze.

## 13. Future Considerations (post-MVP)

- Chain-signature integrations so the guard can instead *vet* MPC signatures for cross-chain spend gates; multi-treasury budgets per agent "department"
- ZK-based purpose proofs (the Gloam thread) when the window allows
- Streaming/rate-splitting guards (subplot limits rather than per-request)
- Real books integrations (accounting suites, expense APIs) behind the same `purpose_ref` seam
- Risk-model tuning on held-request outcomes; fleet-wide anomaly surfacing
- Standing down `deterministic-only` mode by hardening the complete attestation chain as NEAR AI docs mature

## 14. Risks & Mitigations

1. **TEE/attestation churn or partial chain (documented gap, recon-confirmed).** *Mitigation:* binary-honest badge; deterministic path always exists; per-request signer match + nonce; Verification Center footage as independent proof.
2. **Contract feature creep.** *Mitigation:* hard rule — guard does hold/check/pay (+owner withdraw as refund path); every candidate feature must trace to an attack-suite line or it's out.
3. **Transfer-failure async gap (prototype cut-corner): payment promises are fire-and-forget in the skeleton.** *Mitigation:* fund check before transfer + underfunded requests stay held; Phase 3 stretch: promise-callback reconciliation emitting `request_failed` + allowance rollback.
4. **No co-lead by Nov 7/9.** *Mitigation:* fold is a first-class success path: architecture is component-shaped (contract + verifier + MCP standalone), so SERVITOR/FOREMAN integration is days, not a rewrite; README credit + security-tag contribution on both.
5. **Two-submission cap math forces under-polish.** *Mitigation:* eval gates before polish; polish order: money-shot → fleet kill → audit pack; demos scripted to script beats, not freeform.

## 15. Appendix

**Related documents**
- `near-chaperone-brief.md` (repo root) — source brief; submission contract mirrors SERVITOR's §6 (not read here, per Q-015)

**Verified references (recon, Nov 3)**
- NEAR AI Cloud quickstart/private-inference/verification docs: `https://docs.near.ai/cloud/*`
- Attestation report + signature endpoints: `cloud-api.near.ai/v1/...`; verifier example: `near-examples/nearai-cloud-verification-example`; no-code: `cloud.near.ai/verify`
- Access keys (FC-key constraints, locked accounts): `https://docs.near.org/protocol/accounts-contracts/access-keys`
- Testnet faucet: `near-faucet.io` (up) — Tidepool (`usetidepool.tech`) verified as swap-only community sandbox
- `platform.near.ai`: DNS-dead as of recon — do not build on it

**Repo structure**
```
chaperone/
├── near-chaperone-brief.md   # original brief (unchanged input)
├── .agents/PRDs/PRD.md       # this document
├── contract/                 # Phase 1
├── app/                      # Phase 2
├── mcp/                      # Phase 3
└── scripts/                  # Phases 2–3
```
