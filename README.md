# CHAPERONE

> **Spending limits don't make agents safe. Verifying what they pay *for* does.**

Chaperone is mission control for a fleet of money-handling AI agents on NEAR: every payment routes through a Rust guard contract (`chaperone-guard`), surviving requests are purpose-verified, and humans hold the last word on mismatches.

[Why](#why) • [Prerequisites](#prerequisites) • [Quickstart](#quickstart) • [Usage](#usage) • [Configuration](#configuration) • [Architecture](#architecture) • [Limitations](#limitations) • [Validation](#validation)

## Why

Everyone gives AI agents spending limits. Limits don't stop the scam that arrives *under* the limit: an agent dutifully paying a poisoned invoice, a fabricated "GPU renewal", an attacker-controlled vendor — all inside budget. Amount caps check how much; nobody checks what for. Chaperone verifies purpose: deterministic on-chain checks first (allowance, per-payment cap, payee allowlist, a purpose reference that must resolve to a real invoice in the books), then a signed purpose verdict, then a human decision on anything that doesn't line up. The guard does hold/check/pay — nothing more; the attack suite is the spec.

## Prerequisites

- `node` 22+ on `PATH` (CI uses Node 22).
- `git`.
- Rust toolchain with `cargo` (only for the contract tests the suite runs via `cargo test -p chaperone-guard`).
- No secrets needed for the default path below — offline gates run credential-free and chain gates print `SKIP` and exit 0 without credentials.

## Quickstart

From a clean clone, no secrets needed:

```sh
git clone https://github.com/techafreshh/chaperone.git
cd chaperone
npm ci
scripts/deploy-testnet.sh --dry-run   # prints the exact live deploy sequence, changes nothing
scripts/attack-suite.sh               # builds the app, probes every page, runs contract tests, exits 0
```

Then run the app yourself and open the fleet:

```sh
npm run build && npm run start
```

Open `http://localhost:3000/fleet` in your browser. `GET /api/health` returns `{"ok": true}`.

> [!NOTE]
> Two ports, two servers: `npm run start` (Next.js) listens on port `3000` by default; the attack suite defaults to `$PORT` or `3107` — it reuses a healthy server already on that port, otherwise it builds, starts, and stops its own. Pass `--port <n>` to pin it, or `--help` to see every flag.

What those two commands do:

- `scripts/deploy-testnet.sh --dry-run` (the default mode) prints `cargo build` → contract deploy → `register_agent` × 4 → `seed-books` → `provision-agents` → `list_agents` assertion with zero mutation. Add `--sandbox` for the offline `near-workspaces` round trip, or `--live` (with `NEAR_ACCOUNT_ID`/`NEAR_PRIVATE_KEY` set) to execute against testnet for real.
- `scripts/attack-suite.sh` asserts `GET /api/health` → `{"ok": true}`, `GET /fleet` holds agents `agent-1` through `agent-4`, `GET /requests` shows a `TEE-verified` row, and `GET /api/audit/export?format=csv` starts with `request_id,status,verdict_signature,chain_tx` — then runs `cargo test -p chaperone-guard`. On-chain gates (3 blocked attacks + 1 clean transit) run too when credentials are present, and print `SKIP` otherwise. Every flag is documented via `scripts/attack-suite.sh --help`.

## Usage

### Pages

| Route | What it shows |
|---|---|
| `/fleet` | The 4-agent fleet and per-agent state (tiers: live chain, fixture, stub file, disabled). |
| `/requests` | Payment requests with binary-honest attestation chips: `TEE-verified`, `unverifiable`, or `deterministic-only`. |
| `/queue` | Held requests awaiting one-click approve/reject. |
| `/receipts` | Receipt waterfall plus the CSV audit export. |
| `/verify` | Live judged-verdict entry point (`POST /verify`). |
| `/settings` | Guard contract binding and verifier key configuration. |

### APIs

- `GET /api/health` → `{"ok": true}` (quickstart health assertion).
- `GET /api/audit/export?format=csv` → receipts CSV starting with `request_id,status,verdict_signature,chain_tx`.
- `POST /api/queue/[id]/approve` and `POST /api/queue/[id]/reject` — human decision on held requests.
- `POST /api/agents/[id]/kill` (on-chain freeze + key revocation) and `POST /api/agents/[id]/revive`.
- `POST /api/attestation/preflight` (alias: `/attestation/preflight`) — live preflight against NEAR AI Cloud when `NEAR_AI_API_KEY` is set, fixture mode otherwise.

### MCP

The MCP server (`mcp/`) exposes four tools over guard state — live chain when `GUARD_CONTRACT_ID` is set, otherwise a seeded in-memory fixture that replays the contract's `request_payment` check order: `policy_get`, `request_payment`, `pending`, `attestations`. Reason strings are verbatim copies of the contract (`AgentInactive`, `ExceedsDailyAllowance`, `ExceedsPerPaymentCap`, `PayeeNotAllowlisted`, `PurposeRefNotFound`, …); the fixture never claims TEE proof.

### Scripts

Every script prints its own usage with `--help`; per-script prerequisites, flags, and the live operator checklist live in [`scripts/README.md`](./scripts/README.md).

```sh
scripts/deploy-testnet.sh --help    # --dry-run (default) | --sandbox | --live
scripts/attack-suite.sh --help      # --skip-app | --skip-build | --skip-chain | --skip-cargo | --port <n>
scripts/fund-testnet.sh --help      # top up agents below threshold (--live only; prints plan and exits 0 without creds)
node scripts/verifier-live-smoke.mjs --help   # live preflight + judged smoke; SKIP with exit 0 when NEAR_AI_API_KEY is unset
node scripts/sandbox-verify.mjs --help        # offline near-workspaces round trip
```

## Configuration

Only the variables the code actually reads. CLI flags override env in every script (`--contract`, `--account-id`, `--private-key`, `--rpc-url`).

| Variable | Used by | Default |
|---|---|---|
| `GUARD_CONTRACT_ID` | Attack/chain gates (`resolveGuardId`), app chain tiers (`fleet`, `queue`, `receipts`, `verify`), MCP live adapter, mirror | _(none — live paths stay disabled/SKIP without it)_ |
| `NEAR_CONTRACT_ID` | Legacy fallback for the guard id in the same readers | _(none)_ |
| `NEAR_ACCOUNT_ID` | Signer (guard owner + agent parent) for deploy, attack suite, fixtures, provision, seed-books, fund, revoke, verify | `signer.testnet` placeholder in `--dry-run` plans only |
| `NEAR_PRIVATE_KEY` | Signer key (`ed25519:…`) for the same writers | _(none — live writes fail closed without it)_ |
| `NEAR_RPC_URL` | All NEAR RPC callers | `https://rpc.testnet.near.org` |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | Supabase mirror target | _(none — mirror is disabled without both)_ |
| `MIRROR_POLL_MS` | `mirror-sync` poll interval | `15000` |
| `MIRROR_STUB_FILE` | Local JSON stub chain for offline mirror runs | _(none)_ |
| `NEAR_AI_API_KEY` | Attestation preflight/judge (`app/lib/attestation.ts`), verifier live smoke | _(none — fixture mode)_ |
| `NEAR_AI_MODEL` | Model id for live judgment | `qwen3-30b` |
| `PORT` | Attack-suite app server port | `3107` (Next.js `npm run start` itself defaults to `3000`) |
| `FLEET_STUB_FILE` | File-injected fleet tier for harnesses (`loadStubAgents`) | _(none)_ |
| `SUITE_GOOD_PAYEE` / `SUITE_ATTACKER_PAYEE` / `SUITE_EVIL_PAYEE` | Clean-transit / held-transit / never-allowlisted probes | `good.testnet` / `attacker.testnet` / `evil.testnet` |
| `SMOKE_BASE_URL` | Verifier live smoke target | `http://localhost:3000` |
| `VERIFY_REQUEST_ID` | Request id for `--judge` smoke | `5` |

## Architecture

```text
contract/    Rust guard (chaperone-guard): allowances, per-payment caps, allowlist, purpose refs, hold/reject, events
app/         Next.js 15 + TypeScript UI and API routes (fleet, requests, queue, receipts, verify, settings)
scripts/     Operator CLIs: deploy-testnet, attack-suite, fixtures, seed-books, provision-agents, fund-testnet, mirror-sync, sandbox-verify
verifier/    TEE purpose-judgment pipeline (preflight, judge, bind, sign)
mcp/         MCP server: policy_get, request_payment, pending, attestations
```

The money path is one way: agent sub-accounts hold only function-call keys scoped to the guard, so payments physically route through `request_payment` → deterministic checks → signed purpose verdict → human release/reject. Every state change emits an on-chain event.

## Limitations

- **Sandbox vs live.** Merge-tier verification is deterministic and offline: `--dry-run` prints command sequences, `--sandbox` replays deploy → 4 agents → staged transit → kill-switch against a local `near-workspaces` sandbox (never testnet, never the faucet). Live testnet runs only via explicit `--live` flags with operator credentials.
- **Faucet is an operator step.** Real testnet funding (faucet top-up, signer transfers, real-deploy receipts and tx hashes) happens post-merge by the operator and is recorded outside the repo — never baked into the tree.
- **TEE-degradation honesty.** Without a live attestation the UI shows `unverifiable` or `deterministic-only`, never `TEE-verified`. Fixture rows (fleet agents, request badges, receipt signatures) are display placeholders carrying the probe strings with zero credentials — never synthesized evidence.
- **Roadmap, not product:** live mainnet deployment, automated faucet funding in CI, video or submission paperwork. See [`.agents/PRDs/PRD.md`](./.agents/PRDs/PRD.md) for the full product picture.

## Validation

CI (`.github/workflows/ci.yml`) runs five jobs: `contract` (`cargo test -p chaperone-guard`), `app` (install + vitest + build), `scripts` (import checks + `node --test scripts/**/*.test.mjs` + offline sandbox verify), `verifier` (test + `tsc`), `mcp` (test + `tsc` + build). Reproduce the offline core locally with `scripts/deploy-testnet.sh --dry-run` (exit 0, no mutation) and `scripts/attack-suite.sh --skip-chain`.

MIT — see [`LICENSE`](./LICENSE).
