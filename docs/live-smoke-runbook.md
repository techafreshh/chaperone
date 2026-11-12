# Live-smoke runbook (operator)

Everything the factory built is merge-tier: fixture-verified, honest, credential-free.
This runbook is the **live tier** — the ~30 operator minutes that turn `main` into a
judged, on-chain, video-ready demo. Run it with real credentials; nothing in this
document puts a secret into the repo, chat, or an issue.

## 0. Preconditions (~10 min, one-time)

| What | Where it comes from |
|---|---|
| `NEAR_AI_API_KEY` | cloud.near.ai → purchase credits (paid, no free tier) → generate key |
| `NEAR_AI_MODEL` | `curl -s https://cloud-api.near.ai/v1/models -H "Authorization: Bearer $NEAR_AI_API_KEY"` — pick a reasoning-capable catalog model id |
| `NEAR_ACCOUNT_ID` + `NEAR_PRIVATE_KEY` | a **funded** testnet account (create + fund via near-faucet.io if needed) — this is the fleet owner |
| `VERIFIER_SIGNING_KEY` / `VERIFIER_PUBLIC_KEY` | the Ed25519 pair generated VPS-side (see `factoryd.env` block in the PRD appendix / onboarding notes) — register the *public* key on-chain via `set_verifier` during step 2 |
| Contract id | e.g. `chaperone-guard.testnet` — pick or reuse |

None of these keys ever enter git, chat, or issue text. Receipts (tx hashes) do.

## 1. Real deploy (~3 min)

```sh
NEAR_ACCOUNT_ID=owner.testnet NEAR_PRIVATE_KEY=ed25519:... \
  scripts/deploy-testnet.sh --live
```

Sequence (same one the `--dry-run` prints): `cargo build` → deploy `chaperone-guard` →
`register_agent` × 4 → seed books → provision agent sub-accounts with restricted
function-call keys → `list_agents` assertion. **Save every tx hash.**

## 2. Live verifier smoke (~2 min)

```sh
NEAR_ACCOUNT_ID=owner.testnet NEAR_PRIVATE_KEY=ed25519:... \
  NEAR_AI_API_KEY=... NEAR_AI_MODEL=<model-id> \
  scripts/deploy-testnet.sh --live   # if not already done in step 1

NEAR_AI_API_KEY=... NEAR_AI_MODEL=<model-id> npm --prefix app run start &

NEAR_AI_API_KEY=... node scripts/verifier-live-smoke.mjs --judge
```

Exits 0 with a live `verified:true` and a 42-char `0x` `signing_address`;
`--judge` pushes one real judged completion end-to-end (judge → bind → sign → submit).
Any non-zero exit = fix before filming, not after.

## 3. The money-shot with credentials (~5 min)

```sh
# server still running with the live env from step 2
NEAR_AI_API_KEY=... scripts/attack-suite.sh
```

Offline HTTP gates assert as always; **with credentials present the three blocked
attacks (over-allowance, non-allowlisted payee, poisoned purpose-mismatch) and the one
clean transit run on-chain**. That on-chain block — reason shown, money held, attacker
address refused by the contract — IS the demo.

## 4. Film it (60–75s, the beats from the brief)

- **0:00–0:10** — hook: "Everyone's giving agents spending limits. Limits didn't stop
  the scam that comes in *under* the limit."
- **0:10–0:35** — fleet dashboard: four agents, allowances; a request arrives; purpose
  chip reads `TEE-verified`; it pays.
- **0:35–1:00** — the poisoned request to the attacker address: deterministic + TEE
  reject → held; one click kills the agent (key revoked); the other three unaffected.
- **1:00–1:15** — on-chain audit log / CSV export: "all enforced by a NEAR contract
  holding the signing rights." Repo + tags.

Before filming, sanity-check honesty twice: every visible live row shows
`TEE-verified` **only** because a real preflight verified it; kill the verifier env
mid-run and the chip must degrade to `attestation unverifiable` / `deterministic-only`
— that degradation is itself a great B-roll shot.

## 5. Close the loop

- [ ] Post tx hashes + smoke output to issue #21 (receipts, not keys)
- [ ] Repo freeze: `git tag v0.1.0-submission && git push --tags`
- [ ] Submission under the co-lead's identity (team size 2–4; operator listed as team
      member) — or invoke the fold path: policy layer inside SERVITOR/FOREMAN with
      README credit
- [ ] PRD §11 checkboxes ticked (attack gate, fleet gate, repro gate, README pass)
