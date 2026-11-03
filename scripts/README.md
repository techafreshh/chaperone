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
