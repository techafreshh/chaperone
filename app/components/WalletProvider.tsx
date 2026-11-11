"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";

// Router refresh that stays SSR-safe: `useRouter` throws its mount
// invariant under `renderToStaticMarkup` (unit tests) and anywhere the
// app router is absent, so fall back to a no-op there. The live browser
// always has the router mounted and re-reads chain state.
export function useSafeRefresh(): () => void {
  try {
    const router = useRouter();
    return () => router.refresh();
  } catch {
    return () => {};
  }
}

// Owner wallet connection (issue #62). Client-only NEAR
// `@near-wallet-selector` setup (MyNearWallet + Meteor) behind a React
// context so every owner write is signed by the operator's wallet in the
// browser. The app server holds no owner key. All selector imports are
// dynamic inside `useEffect` so SSR/prerender never touches `window`.

export const OWNER_WRITE_GAS_STR = "30000000000000";
export const OWNER_WRITE_DEPOSIT_STR = "0";

export function ownerWriteGas(): bigint {
  return BigInt(OWNER_WRITE_GAS_STR);
}

export function ownerWriteDeposit(): bigint {
  return BigInt(OWNER_WRITE_DEPOSIT_STR);
}

export function explorerTxUrl(hash: string, network: string): string {
  const host =
    network === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io";
  return `${host}/txns/${hash}`;
}

// Build the `FunctionCall` action for an owner write. Uses the v10
// `actionCreators.functionCall` NAJ action when available, with the
// internal `{ type: "FunctionCall", params }` shape attached as compat
// fields so mocked-wallet probes can assert `methodName`/`args`
// regardless of which representation they inspect.
export function buildOwnerAction(
  methodName: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, unknown>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actionCreators?: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  const gas = ownerWriteGas();
  const deposit = ownerWriteDeposit();
  const compat = {
    type: "FunctionCall",
    params: {
      methodName,
      args,
      gas: OWNER_WRITE_GAS_STR,
      deposit: OWNER_WRITE_DEPOSIT_STR,
    },
  };
  try {
    if (
      actionCreators !== undefined &&
      actionCreators !== null &&
      typeof actionCreators.functionCall === "function"
    ) {
      const naj = actionCreators.functionCall(methodName, args, gas, deposit);
      if (naj !== null && typeof naj === "object" && !Array.isArray(naj)) {
        return { ...naj, ...compat };
      }
      return naj;
    }
  } catch {
    // Fall through to the internal shape below.
  }
  return compat;
}

// Extract a tx hash from the wallet outcome shapes (`transaction.hash`,
// `transaction_outcome.id`, bare `hash`/string).
export function extractTxHash(outcome: unknown): string {
  if (typeof outcome === "string") return outcome;
  if (outcome !== null && typeof outcome === "object") {
    const record = outcome as Record<string, unknown>;
    const tx = record.transaction as Record<string, unknown> | undefined;
    if (tx !== null && typeof tx === "object" && tx !== undefined) {
      if (typeof tx.hash === "string" && tx.hash !== "") return tx.hash;
      if (typeof tx.id === "string" && tx.id !== "") return tx.id;
    }
    const txOutcome = record.transaction_outcome as
      | Record<string, unknown>
      | undefined;
    if (txOutcome !== null && typeof txOutcome === "object" && txOutcome !== undefined) {
      if (typeof txOutcome.id === "string" && txOutcome.id !== "") {
        return txOutcome.id;
      }
    }
    if (typeof record.hash === "string" && record.hash !== "") return record.hash;
    if (typeof record.transactionHash === "string" && record.transactionHash !== "") {
      return record.transactionHash;
    }
  }
  return "";
}

export interface WalletContextValue {
  signedAccountId: string | null;
  connecting: boolean;
  connect: () => void;
  disconnect: () => Promise<void>;
  signAndSendOwnerTx: (
    methodName: string,
    args: Record<string, unknown>,
  ) => Promise<string>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readGlobalMockSigner(): any {
  try {
    if (typeof window === "undefined") return null;
    const w = window as unknown as Record<string, unknown>;
    const mock =
      w.__CHAPERONE_SIGNER__ ?? w.__CHAPERONE_WALLET_MOCK__ ?? null;
    if (
      mock !== null &&
      typeof mock === "object" &&
      typeof (mock as Record<string, unknown>).signAndSendTransaction ===
        "function"
    ) {
      return mock;
    }
    return null;
  } catch {
    return null;
  }
}

const WalletContext = createContext<WalletContextValue | null>(null);

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (ctx !== null) return ctx;
  // Outside a provider (unit tests): global-mock-only fallback so the
  // injected `signer` prop path on `OwnerWriteButton` still works.
  return {
    signedAccountId: null,
    connecting: false,
    connect: () => {},
    disconnect: async () => {},
    signAndSendOwnerTx: async (methodName, args) => {
      const mock = readGlobalMockSigner();
      if (mock === null) {
        throw new Error("wallet not connected");
      }
      const outcome = await mock.signAndSendTransaction({
        receiverId: "",
        actions: [buildOwnerAction(methodName, args)],
      });
      const hash = extractTxHash(outcome);
      if (hash === "") throw new Error("wallet returned no transaction hash");
      return hash;
    },
  };
}

export default function WalletProvider({
  contractId,
  network = "testnet",
  children,
}: {
  contractId: string;
  network?: string;
  children: ReactNode;
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const selectorRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const modalRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actionCreatorsRef = useRef<any>(null);
  const [signedAccountId, setSignedAccountId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;
    async function init() {
      try {
        const [{ setupWalletSelector }, { setupMyNearWallet }, { setupMeteorWallet }] =
          await Promise.all([
            import("@near-wallet-selector/core"),
            import("@near-wallet-selector/my-near-wallet"),
            import("@near-wallet-selector/meteor-wallet"),
          ]);
        actionCreatorsRef.current =
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ((await import("@near-wallet-selector/core")) as any).actionCreators ??
          null;
        const selector = await setupWalletSelector({
          network: network === "mainnet" ? "mainnet" : "testnet",
          modules: [setupMyNearWallet(), setupMeteorWallet()],
        });
        if (cancelled) return;
        selectorRef.current = selector;
        // No modal-ui dependency (its hard react-18 pin duplicates React
        // in this React-19 app); connecting goes through the selected
        // wallet's own sign-in redirect.
        modalRef.current = null;
        const readAccounts = (): string | null => {
          try {
            const state =
              typeof selector.store?.getState === "function"
                ? selector.store.getState()
                : null;
            const accounts = state?.accounts;
            if (Array.isArray(accounts) && accounts.length > 0) {
              const first = accounts[0] as { accountId?: string };
              if (typeof first?.accountId === "string") return first.accountId;
            }
          } catch {
            // Fall through to wallet read below.
          }
          return null;
        };
        setSignedAccountId(readAccounts());
        try {
          const wallet = await selector.wallet();
          const accounts = await wallet.getAccounts();
          if (!cancelled && Array.isArray(accounts) && accounts.length > 0) {
            const first = accounts[0] as { accountId?: string };
            if (typeof first?.accountId === "string") {
              setSignedAccountId(first.accountId);
            }
          }
        } catch {
          // Not signed in yet.
        }
        try {
          const observable = selector.store?.observable;
          if (observable !== undefined && typeof observable.subscribe === "function") {
            observable.subscribe(() => {
              if (!cancelled) setSignedAccountId(readAccounts());
            });
          }
        } catch {
          // Subscription is best-effort.
        }
      } catch {
        // Selector unavailable (offline/SSR): wallet writes stay
        // mock-driven; the UI still renders.
      } finally {
        if (!cancelled) setConnecting(false);
      }
    }
    void init();
    return () => {
      cancelled = true;
    };
  }, [contractId, network]);

  const connect = useCallback(() => {
    try {
      if (modalRef.current !== null && modalRef.current !== undefined) {
        modalRef.current.show();
        return;
      }
      const selector = selectorRef.current;
      if (selector !== null && selector !== undefined) {
        void (async () => {
          try {
            const wallet = await selector.wallet();
            await wallet.signIn({ contractId });
          } catch {
            // Modal-less sign-in is best-effort.
          }
        })();
      }
    } catch {
      // Connecting is best-effort.
    }
  }, [contractId]);

  const disconnect = useCallback(async () => {
    try {
      const selector = selectorRef.current;
      if (selector === null || selector === undefined) {
        setSignedAccountId(null);
        return;
      }
      const wallet = await selector.wallet();
      await wallet.signOut();
      setSignedAccountId(null);
    } catch {
      setSignedAccountId(null);
    }
  }, []);

  const signAndSendOwnerTx = useCallback(
    async (methodName: string, args: Record<string, unknown>): Promise<string> => {
      const mock = readGlobalMockSigner();
      if (mock !== null) {
        const outcome = await mock.signAndSendTransaction({
          signerId: signedAccountId ?? undefined,
          receiverId: contractId,
          actions: [
            buildOwnerAction(methodName, args, actionCreatorsRef.current),
          ],
        });
        const hash = extractTxHash(outcome);
        if (hash === "") throw new Error("wallet returned no transaction hash");
        return hash;
      }
      const selector = selectorRef.current;
      if (selector === null || selector === undefined) {
        throw new Error("wallet not connected");
      }
      const wallet = await selector.wallet();
      const accounts = await wallet.getAccounts().catch(() => []);
      const signerId =
        signedAccountId ??
        (Array.isArray(accounts) && accounts.length > 0
          ? (accounts[0] as { accountId?: string }).accountId
          : undefined);
      const outcome = await wallet.signAndSendTransaction({
        ...(signerId !== undefined && signerId !== null ? { signerId } : {}),
        receiverId: contractId,
        actions: [
          buildOwnerAction(methodName, args, actionCreatorsRef.current),
        ],
      });
      const hash = extractTxHash(outcome);
      if (hash === "") throw new Error("wallet returned no transaction hash");
      return hash;
    },
    [contractId, signedAccountId],
  );

  const value = useMemo<WalletContextValue>(
    () => ({ signedAccountId, connecting, connect, disconnect, signAndSendOwnerTx }),
    [signedAccountId, connecting, connect, disconnect, signAndSendOwnerTx],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}
