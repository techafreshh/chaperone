---
type: project
created: 2026-11-02
status: draft-awaiting-approval
tags: [near, hackathon, chaperone, build-brief]
---

# CHAPERONE — Build Brief (NEAR Hackathon — component-first; standalone needs a human co-lead)

**For:** coding agent / factory loop. Standalone repo — do NOT read `near-servitor-brief.md` or `near-foreman-brief.md` (independence rule Q-015). **Submission math:** Techa's single email caps at 2 submissions (SERVITOR + FOREMAN take those). CHAPERONE ships on **Nov 13 only if a real human co-lead owns the submission** (their name/email; Techa stays on as team member — team size `2 - 4`). Otherwise it ships *as a component inside SERVITOR + FOREMAN* (it is literally their policy layer) and their READMEs credit it — that alone feeds the `security` tag on both.
**Product:** CHAPERONE — mission control for a *fleet* of money-handling agents. The chaperone watches what the agents pay *for*, not just how much. Where the six day-one "spend guards" each lock **one wallet behind amount caps**, CHAPERONE governs **a workforce**: per-agent allowances (function-call keys, enforced on-chain), **purpose verification** — every payment carries a reason ("FOR invoice #114, GPU rental") checked by an attested TEE-hosted model (NEAR AI) before the guard contract moves money — plus approval queue, kill-switches, live receipts, fleet waterfall. *"Spending limits don't make agents safe. Verifying what they pay FOR does."* (that gap was publicly named in the field on day 1 and nobody shipped it).
**Competition:** NEAR HACKATHON — repo public before **2026-11-14T23:59:00Z**, single uneditable submission, AI-screened then human-judged.
**Tracks:** `security` (primary), `agents`, tag `privacy`.

## 1. Product contract

1. **Fleet view:** each agent = NEAR sub-account with a scoped function-call key (daily allowance, per-payment cap, payee allowlist — all enforced by the guard contract, not the app).
2. **Spend requests with purpose:** every payment request must carry structured intent (vendor, amount, purpose-ref). Deterministic checks first (allowance, allowlist, ref exists in the books); then the **purpose check**: a TEE-hosted model on NEAR AI judges request-vs-reason consistency; its verdict is signed — **attestation chip surfaced in the UI** (privacy/TEE hook).
3. **The guard contract (NEAR, own contract):** holds the signing rights. Pass → pays; mismatch → holds for human; human can release/reject; everything emits events = the on-chain audit log. Demo must include the money-shot: an injected/poisoned request to an attacker address **blocked on-chain** with the reason shown.
4. **Approval queue + kill-switch:** human web UI (wallet login); one click freezes an agent (allowance key revoked), receipts waterfall, exportable audit pack. MCP: `policy_get`, `request_payment` (guarded!), `pending`, `attestations` — so an MCP client *feels* the guard refuse a bad request from inside Claude.
5. **Books integration:** purpose-refs resolve against real invoices/orders (a tiny ledger model in-app; SERVITOR-flavored sample data works) — this is what makes it *fleet ops*, not one wallet.

**Non-goals (v1):** no ZK (Gloam noted; out of scope for the window), no ML risk-model training, no non-NEAR chains, no mobile.

## 2. Architecture

- Next.js 15 + TS + Tailwind; Supabase (policies, requests, verdicts, audit mirror). Guard + allowance logic in a small NEAR contract (Rust, near-sdk) holding signing rights; app never holds master keys.
- Purpose-verifier: TEE-hosted model via **NEAR AI Cloud** (`cloud-api.near.ai/v1`; verify attestation/verification docs D1 — the whole privacy tag rests on surfacing that attestation). Fallback when TEE path is down: deterministic rules only, UI **honestly degrades the attestation badge** (label it).
- Access keys: near-api-js key rotation flows; demo scripts for revoke-on-kill.
- Dev on **Tidepool** (verify D1) / mainnet dust for footage. MCP via official TS SDK on the VPS; live through Nov 18+.
- If standalone: account `chaperone.near` is claimable — the co-lead creates the payout wallet per hackathon rules.

## 3. Eval gate

- **Attack gate (hard):** 3 scripted attacks blocked on-chain: over-allowance, non-allowlisted payee, purpose-mismatch (poisoned-invoice style). One allowed transit with full attestation chain shown.
- **Fleet gate:** ≥4 agents under management with independent allowances; killing one mid-run blocks only that agent.
- **Repro gate:** fresh clone → attack suite replays one-command (fixture chain state), plus live small demo path.
- README machine pass: problem (agents hold money), NEAR fit (function-call keys, NEAR AI TEE verification, own contract), try-it, limitations, MIT.

## 4. Plan (fits the 2-submission core; only continues standalone if co-lead confirmed by Nov 7)

- **D1–D2 (Nov 2–3):** contract skeleton (allowances, pay, hold/reject, events); Tidepool verify.
- **D3–D5 (Nov 4–6):** purpose-ref ledger; deterministic checks; TEE-verifier integration + attestation surfacing; UI: fleet + request feed.
- **D6–D7 (Nov 7–8):** attack suite scripted; kill-switch/revocation flows; MCP surface.
- **D8 (Nov 9):** **co-lead go/no-go.** If GO → polish + demo video (D9–11), repro (D12), submit D13 under co-lead's email (Techa NOT lead). If NO-GO → fold: become SERVITOR/FOREMAN's policy layer, credit in both READMEs, stop standalone spend.
- Submission contract identical to SERVITOR (§6 there), fields under the co-lead's identity.

## 5. Demo script (only if standalone GO; 60–75s)

- **0:00–0:10** "Everyone's giving agents spending limits. Limits didn't stop the scam that comes in *under* the limit."
- **0:10–0:35** Fleet dashboard: four agents, allowances; a payment request arrives — purpose chip verifies via TEE — pays.
- **0:35–1:00** The block: poisoned request (attacker address, no invoice ref) — deterministic + TEE reject, held, then agent killed on-screen (key revoked, fleet unaffected).
- **1:00–1:15** On-chain audit log + "all enforced by a NEAR contract holding the signing rights." Repo + tags.

## 6. Risks

- TEE/attestation API churn → badge system is binary-honest; deterministic path always exists so the app never lies.
- Contract complexity creep → the guard does *hold/check/pay/refund*, nothing else; attack suite is the spec.
- Splits attention from the two flagships → hard NO-GO date Nov 9; folding into SERVITOR/FOREMAN is a success path, not a failure.
