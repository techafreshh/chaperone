"use client";

import { useState } from "react";
import { explorerTxUrl, useSafeRefresh, useWallet } from "./WalletProvider";

// Generic wallet-signed owner write (issue #62). Live tier (`contractId`
// set): confirm → `wallet.signAndSendTransaction` with a single
// `FunctionCall` action → testnet/mainnet explorer link →
// `router.refresh()` so the next chain read shows the result. Errors
// render inline and change nothing. Fixture tier (`contractId` empty):
// `fetch`-POST to `fallbackUrl` and reload, so the in-memory overlay
// reflects the decision.
//
// `signer` is an injectable seam for tests (and the global
// `window.__CHAPERONE_SIGNER__` / `window.__CHAPERONE_WALLET_MOCK__`
// hooks cover black-box probes that mock the wallet surface).
export interface OwnerSigner {
  signAndSendTransaction: (tx: {
    signerId?: string;
    receiverId: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    actions: any[];
  }) => Promise<unknown>;
}

export default function OwnerWriteButton({
  contractId,
  network = "testnet",
  methodName,
  args,
  label,
  testId,
  confirmMessage,
  fallbackUrl,
  fallbackMethod = "POST",
  signer,
  className,
}: {
  contractId: string;
  network?: string;
  methodName: string;
  args: Record<string, unknown>;
  label: string;
  testId: string;
  confirmMessage?: string;
  fallbackUrl?: string;
  fallbackMethod?: string;
  signer?: OwnerSigner | null;
  className?: string;
}) {
  const refresh = useSafeRefresh();
  const wallet = useWallet();
  const [pending, setPending] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    if (pending) return;
    if (
      confirmMessage !== undefined &&
      confirmMessage !== "" &&
      typeof window !== "undefined" &&
      !window.confirm(confirmMessage)
    ) {
      return;
    }
    setError(null);
    // Fixture tier: no contract id → POST to the server fixture route.
    if (contractId === "") {
      if (fallbackUrl === undefined || fallbackUrl === "") return;
      setPending(true);
      try {
        const res = await fetch(fallbackUrl, { method: fallbackMethod });
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
    // Live tier: wallet-signed FunctionCall. The row stays as-is until
    // the next chain read (`router.refresh()`); no optimistic update.
    setPending(true);
    try {
      let hash: string;
      if (signer !== undefined && signer !== null) {
        const { buildOwnerAction, extractTxHash } = await import(
          "./WalletProvider"
        );
        const outcome = await signer.signAndSendTransaction({
          receiverId: contractId,
          actions: [buildOwnerAction(methodName, args)],
        });
        hash = extractTxHash(outcome);
        if (hash === "") throw new Error("wallet returned no transaction hash");
      } else {
        hash = await wallet.signAndSendOwnerTx(methodName, args);
      }
      setTxHash(hash);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <span>
      <button
        type="button"
        data-testid={testId}
        onClick={onClick}
        disabled={pending}
        className={
          className ??
          "rounded bg-sky-700 px-3 py-1 text-sm font-semibold text-white hover:bg-sky-600 disabled:opacity-50"
        }
      >
        {label}
      </button>
      {txHash !== null && txHash !== "" ? (
        <a href={explorerTxUrl(txHash, network)} target="_blank" rel="noreferrer">
          {explorerTxUrl(txHash, network)}
        </a>
      ) : null}
      {error !== null && error !== "" ? <p role="alert">{error}</p> : null}
    </span>
  );
}
