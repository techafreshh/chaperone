"use client";

import { useWallet } from "./WalletProvider";

// Wallet connection state (issue #62). Wallet connection lives in the
// browser; the server keeps no sessions.
export default function WalletConnect() {
  const { signedAccountId, connecting, connect, disconnect } = useWallet();
  if (connecting) {
    return <p>Connecting wallet…</p>;
  }
  if (signedAccountId !== null) {
    return (
      <div>
        <p>Connected: {signedAccountId}</p>
        <button type="button" onClick={() => void disconnect()}>
          Disconnect
        </button>
      </div>
    );
  }
  return (
    <button type="button" onClick={connect}>
      Connect wallet
    </button>
  );
}
