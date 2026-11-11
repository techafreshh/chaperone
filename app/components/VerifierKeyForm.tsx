"use client";

import { useState } from "react";
import { explorerTxUrl, useSafeRefresh, useWallet } from "./WalletProvider";

// Wallet-signed verifier-key rotation form (issue #62). Live tier
// (`contractId` set): the operator signs `set_verifier` with the owner
// wallet in the browser; an empty key clears to `None`. Fixture tier:
// POSTs to the server fixture route. Keeps the `verifier-key-form`
// testid and the base58 placeholder.
export default function VerifierKeyForm({
  contractId,
  network = "testnet",
  currentKey,
}: {
  contractId: string;
  network?: string;
  currentKey: string | null;
}) {
  const refresh = useSafeRefresh();
  const wallet = useWallet();
  const [key, setKey] = useState("");
  const [pending, setPending] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    setError(null);
    const trimmed = key.trim();
    if (contractId === "") {
      setPending(true);
      try {
        const res = await fetch("/api/settings/verifier-key", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ verifier_key: trimmed }),
        });
        if (!res.ok) {
          let message = `request failed: ${res.status}`;
          try {
            const body = (await res.json()) as { error?: unknown };
            if (typeof body?.error === "string" && body.error !== "") {
              message = body.error;
            }
          } catch {
            // Keep the status fallback.
          }
          setError(message);
          return;
        }
        window.location.reload();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setPending(false);
      }
      return;
    }
    if (
      typeof window !== "undefined" &&
      !window.confirm("Rotate verifier key?")
    ) {
      return;
    }
    setPending(true);
    try {
      const hash = await wallet.signAndSendOwnerTx("set_verifier", {
        public_key_base58: trimmed === "" ? null : trimmed,
      });
      setTxHash(hash);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <form data-testid="verifier-key-form" onSubmit={onSubmit}>
      <p>Current verifier key: {currentKey ?? "not set"}</p>
      <label>
        Verifier key
        <input
          name="verifier_key"
          placeholder="base58 ed25519 public key"
          value={key}
          onChange={(event) => setKey(event.target.value)}
        />
      </label>
      <button type="submit" disabled={pending}>
        Rotate verifier key
      </button>
      {txHash !== null && txHash !== "" ? (
        <a href={explorerTxUrl(txHash, network)} target="_blank" rel="noreferrer">
          {explorerTxUrl(txHash, network)}
        </a>
      ) : null}
      {error !== null && error !== "" ? <p role="alert">{error}</p> : null}
    </form>
  );
}
