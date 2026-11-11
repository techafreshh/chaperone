"use client";

import OwnerWriteButton from "./OwnerWriteButton";

// Wallet-signed kill switch (issue #62): the UI freeze is the on-chain
// `set_agent_active` freeze signed by the owner's wallet. Agent key
// revocation stays an operator CLI (`scripts/revoke-key.sh`). Fixture
// tier (no contract id) POSTs to the server fixture routes.
export default function KillButton({
  agent_id,
  active,
  contractId = "",
  network = "testnet",
}: {
  agent_id: string;
  active: boolean;
  contractId?: string;
  network?: string;
}) {
  const action = active ? "kill" : "revive";
  const label = active ? "Freeze" : "Revive";
  const confirmMessage = active ? `Freeze ${agent_id}?` : `Revive ${agent_id}?`;
  return (
    <OwnerWriteButton
      contractId={contractId}
      network={network}
      methodName="set_agent_active"
      args={{ agent_id, active: !active }}
      label={label}
      testId={`${action}-${agent_id}`}
      confirmMessage={confirmMessage}
      fallbackUrl={`/api/agents/${agent_id}/${action}`}
      fallbackMethod="POST"
      className={
        active
          ? "rounded bg-red-700 px-3 py-1 text-sm font-semibold text-white hover:bg-red-600 disabled:opacity-50"
          : "rounded bg-emerald-700 px-3 py-1 text-sm font-semibold text-white hover:bg-emerald-600 disabled:opacity-50"
      }
    />
  );
}
