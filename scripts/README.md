# Agent provisioning scripts

`provision-agents.sh` creates locked agent sub-accounts and registers them on
the guard; `revoke-key.sh` removes an agent's guard-scoped key. Both are thin
executable wrappers around the companion Node helpers, which use `near-api-js`
v7 (`Account`, `JsonRpcProvider`, `KeyPair`, explicit function-call access keys).

## Prerequisites

- `node` on `PATH`.
- Root `npm ci` (provides `near-api-js`). CI installs root dependencies and smoke-checks the `near-api-js` imports before running the offline tests.
- Testnet credentials of the signer account, which must be both the
  sub-account parent (`agent-<i>.<signer>`) and the guard owner (`register_agent`
  is owner-gated):

```sh
export NEAR_ACCOUNT_ID=signer.testnet
export NEAR_PRIVATE_KEY=ed25519:...
export NEAR_RPC_URL=https://rpc.testnet.near.org   # optional, this is the default
export NEAR_CONTRACT_ID=guard.signer.testnet        # or pass --contract
```

## Provision

```sh
scripts/provision-agents.sh --count 4 --contract guard.signer.testnet
```

Per `i` in `1..count` the script:

1. Creates `agent-<i>.<signer>` funded with `--initial-balance` NEAR
   (default `0.5`), controlled by a fresh operator full-access key — skipped
   when the account already exists.
2. Adds a function-call key scoped to `request_payment` on the guard with the
   explicit `--allowance` budget (default `250000000000000000000000` yoctoNEAR =
   0.25 NEAR) — skipped when the stored key is already on-chain and correctly
   scoped; stale guard-scoped keys are deleted.
3. Calls `register_agent` with `--daily-allowance` (default `50` NEAR),
   `--per-payment-cap` (default `10` NEAR) and repeatable `--payee` ids —
   skipped with `skipped <id>: already registered` when already on-chain.
4. Fails closed unless the account holds exactly the operator full-access key
   plus the guard-scoped agent key, then writes the keystore entry.
5. After all agents, asserts `list_agents` contains every provisioned id.

Full flag reference: `scripts/provision-agents.sh --help`.

## Revoke

```sh
scripts/revoke-key.sh agent-1 --contract guard.signer.testnet
```

Deletes every key on the agent whose
`permission.FunctionCall.receiver_id` equals the guard, signed by the stored
operator key, then re-queries to confirm the key is gone. An already-absent
key is success (`already revoked`, exit 0). Accepts the short ref (`agent-1`)
or the full account id. Full flag reference: `scripts/revoke-key.sh --help`.

## Operator key-custody model

- The agent principal only ever receives the function-call credential
  (`agentPrivateKey` in the keystore). It can call `request_payment` on the
  guard within its gas budget and nothing else — it cannot transfer, stake,
  or add keys.
- The operator-custody full-access key (`operatorPrivateKey`) stays in
  `scripts/.agent-keys/<agent-id>.json` (mode `0600`, git-ignored). It is what
  makes later revocation possible: deleting a key must be signed by a
  full-access key on that account, so a fully locked account with no retained
  key could never satisfy revoke.
- `scripts/.agent-keys/` contains live private keys: never commit it, never
  copy it to the agent host.

## The allowance=0-means-unlimited gotcha

Off-chain `AddKey` (what these scripts use) and the contract key-creation
path treat allowance `0` differently:

- Off-chain `AddKey` with `allowance: 0` means a **zero budget** — every
  transaction signed by the key fails. Omitting the allowance means
  **unlimited**. These scripts therefore always pass an explicit non-zero
  `--allowance` string, and lock verification rejects anything else.
- Contract `promise_batch_action_add_key_with_function_call` with allowance
  `0` is special-cased to mean **unlimited**. That rule applies ONLY to that
  contract path, which these scripts do not use.

Passing `0` here would brick the agent key; omitting the allowance would grant
unlimited gas. Both are rejected by validation.

## Live operator checklist (run when testnet credentials land)

1. `scripts/provision-agents.sh --count 4` → 4 accounts exist and
   `list_agents` shows 4 agents.
2. Fetch an agent access key via RPC (`view_access_key`) → its
   `permission.FunctionCall.receiver_id` equals the guard contract id and
   `allowance` is a non-zero numeric string.
3. After the agent is killed, `scripts/revoke-key.sh agent-1` → the key no
   longer appears in RPC `view_access_keys`.

## Supabase mirror sync

`scripts/mirror-sync.mjs` mirrors on-chain agents, requests, verdicts and
audit events into Supabase PostgREST tables (migration
`supabase/migrations/0001_chaperone_mirror.sql`). The chain stays the
source of truth: the sync is read-only against NEAR and never
 authoritative for payment. The app reads the mirror via
`GET /api/requests`.

Required env:

```sh
export SUPABASE_URL=https://<project>.supabase.co
export SUPABASE_SERVICE_KEY=<service-role key>   # server-side only, never NEXT_PUBLIC_
export NEAR_CONTRACT_ID=guard.signer.testnet      # live chain only
```

Without `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` the sync reports disabled
and exits 0 without writing a row (never silent, never fake rows):

```sh
npm run mirror:sync -- --once
# mirror disabled: SUPABASE_URL/SUPABASE_SERVICE_KEY not configured
```

With credentials, one pass (polls every `MIRROR_POLL_MS`, default 15000,
unless `--once`):

```sh
npm run mirror:sync -- --once
# mirror sync complete: agents=1 requests=9 verdicts=0 audit_events=9
```

Offline runs use a stub chain with view-identical shapes instead of RPC
(`--stub <path>` or `$MIRROR_STUB_FILE`):

```json
{
  "agents": [{
    "agent_id": "agent-1.signer.testnet",
    "daily_allowance_yocto": "50000000000000000000000000",
    "per_payment_cap_yocto": "10000000000000000000000000",
    "payee_allowlist": ["good.near"],
    "active": true,
    "spent_today_yocto": "0",
    "remaining_today_yocto": "50000000000000000000000000"
  }],
  "requests": [{
    "request_id": 9,
    "agent_id": "agent-1.signer.testnet",
    "payee": "good.near",
    "amount_yocto": "5000000000000000000000000",
    "purpose_ref": "invoice-114",
    "vendor": "CoreWeave",
    "status": "staged",
    "reason": null
  }]
}
```

(`request_id` is dense from the detected base: id 9 syncs alongside 1-8;
a stub holding only id 9 mirrors nothing, mirroring the on-chain walk.)

## Live operator checklist: mirror (post-funding)

1. Apply `supabase/migrations/0001_chaperone_mirror.sql` to the project.
2. `npm run mirror:sync -- --once` → counts line reports synced rows.
3. Spot-check `requests` row id 9 carries the on-chain `payee`/`amount_yocto`.
4. `GET /api/requests?limit=5` → 200 JSON array, length ≤ 5, each item
   with `request_id`/`status`.

## Attack suite one-command replay

`attack-suite.sh` provisions fixture state on testnet, fires 3 blocked
attacks plus 1 clean transit, and prints per-gate pass/fail — the
reproducible money-shot for judges. `fixtures.sh` runs the idempotent
setup step alone. Both are thin executable wrappers around the companion
Node helpers, which use `near-api-js` v7 plus a locally-generated suite
Ed25519 key (base58 via root `bs58`).

Required env (same signer as provisioning, plus the guard id):

```sh
export GUARD_CONTRACT_ID=guard.signer.testnet   # or NEAR_CONTRACT_ID, or --contract
export NEAR_ACCOUNT_ID=signer.testnet           # funded owner, agent parent
export NEAR_PRIVATE_KEY=ed25519:...
```

One command from a fresh clone:

```sh
./scripts/attack-suite.sh
```

Expected stdout (exit 0), one line per gate, each carrying `request_id=`
and `tx=` references (held/paid lines also carry `verdict_tx=` plus the
fixture `attestation=` fields):

```text
GATE over-allowance: BLOCKED request_id=<n> tx=<hash>
GATE allowlist: BLOCKED request_id=<n> tx=<hash>
GATE purpose-mismatch: HELD request_id=<n> tx=<hash> verdict_tx=<hash> attestation=verifier:<base58> sig:<prefix>
GATE clean-transit: PAID request_id=<n> tx=<hash> verdict_tx=<hash> attestation=verifier:<base58> sig:<prefix>
```

Gate contract:

- `over-allowance`: `20` NEAR to the good payee cites `invoice-114` — above
  the `10` NEAR per-payment cap, inside the daily allowance and the `30`
  NEAR ref cap — and is rejected with `ExceedsPerPaymentCap`.
- `allowlist`: `1` NEAR to the evil probe payee (never allowlisted) is
  rejected with `PayeeNotAllowlisted`.
- `purpose-mismatch`: `5` NEAR to the allowlisted attacker payee with a
  poisoned vendor stages, then the fixture `consistent=false` verdict holds
  it (`held`).
- `clean-transit`: `5` NEAR to the good payee with `invoice-114`/`CoreWeave`
  stages, then the fixture `consistent=true` verdict pays it (`paid`).

Re-running is safe: fixtures skip provisioned agents, skip
`already registered` purpose refs, overwrite the agent policy (daily `1000`
NEAR for re-run headroom, cap stays `10` NEAR), and reuse the suite key at
`scripts/.agent-keys/verifier.json` — the second run also exits 0.

```sh
./scripts/attack-suite.sh --skip-fixtures   # fixtures already provisioned
./scripts/attack-suite.sh --help             # full flag reference
```

Fixture vs live: the suite signs verdicts with its local suite key
registered via the owner-gated `set_verifier` — the `attestation=` fields
name that key and never claim TEE verification. Live NEAR AI judgment
stays an operator step: `node scripts/verifier-live-smoke.mjs --judge`.
