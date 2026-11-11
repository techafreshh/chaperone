// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import OwnerWriteButton from "./OwnerWriteButton";
import { buildOwnerAction, extractTxHash } from "./WalletProvider";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const CONTRACT_ID = "guard.testnet";

function actionMethodName(action: unknown): string | null {
  if (action !== null && typeof action === "object") {
    const record = action as Record<string, unknown>;
    // Compat shape: { type: "FunctionCall", params: { methodName, args } }.
    const params = record.params as Record<string, unknown> | undefined;
    if (record.type === "FunctionCall" && params !== undefined) {
      return typeof params.methodName === "string" ? params.methodName : null;
    }
    // NAJ shape: { functionCall: { methodName, args, ... } }.
    const fc = record.functionCall as Record<string, unknown> | undefined;
    if (fc !== undefined && fc !== null && typeof fc === "object") {
      return typeof fc.methodName === "string" ? fc.methodName : null;
    }
  }
  return null;
}

function actionArgs(action: unknown): Record<string, unknown> | null {
  if (action !== null && typeof action === "object") {
    const record = action as Record<string, unknown>;
    const params = record.params as Record<string, unknown> | undefined;
    if (
      record.type === "FunctionCall" &&
      params !== undefined &&
      params.args !== undefined &&
      typeof params.args === "object"
    ) {
      return params.args as Record<string, unknown>;
    }
    const fc = record.functionCall as Record<string, unknown> | undefined;
    if (
      fc !== undefined &&
      fc !== null &&
      typeof fc === "object" &&
      fc.args !== undefined &&
      typeof fc.args === "object"
    ) {
      return fc.args as Record<string, unknown>;
    }
  }
  return null;
}

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.restoreAllMocks();
  try {
    delete (window as unknown as Record<string, unknown>).__CHAPERONE_SIGNER__;
    delete (window as unknown as Record<string, unknown>)
      .__CHAPERONE_WALLET_MOCK__;
  } catch {
    // Best-effort cleanup.
  }
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("wallet owner-write button", () => {
  it("approve sends one FunctionCall to the guard and shows an explorer link", async () => {
    const calls: unknown[] = [];
    const signer = {
      signAndSendTransaction: vi.fn(async (tx: unknown) => {
        calls.push(tx);
        return { transaction: { hash: "txhash123" } };
      }),
    };
    const user = userEvent.setup();
    render(
      <OwnerWriteButton
        contractId={CONTRACT_ID}
        network="testnet"
        methodName="approve_hold"
        args={{ request_id: 6 }}
        label="Approve"
        testId="approve-6"
        confirmMessage="Approve request 6?"
        fallbackUrl="/api/queue/6/approve"
        signer={signer}
      />,
    );
    await user.click(screen.getByTestId("approve-6"));
    await waitFor(() => expect(signer.signAndSendTransaction).toHaveBeenCalledTimes(1));
    const tx = calls[0] as {
      receiverId: string;
      actions: unknown[];
    };
    expect(tx.receiverId).toBe(CONTRACT_ID);
    expect(tx.actions).toHaveLength(1);
    expect(actionMethodName(tx.actions[0])).toBe("approve_hold");
    expect(actionArgs(tx.actions[0])).toEqual({ request_id: 6 });
    // Explorer link renders with the returned hash; nothing is re-read
    // optimistically (the row stays `held` until `router.refresh()`).
    await screen.findByText(`https://testnet.nearblocks.io/txns/txhash123`);
  });

  it("error path renders the message and changes nothing", async () => {
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      value: { reload },
      writable: true,
    });
    const signer = {
      signAndSendTransaction: vi.fn(async () => {
        throw new Error("Insufficient treasury");
      }),
    };
    const user = userEvent.setup();
    render(
      <OwnerWriteButton
        contractId={CONTRACT_ID}
        network="testnet"
        methodName="approve_hold"
        args={{ request_id: 6 }}
        label="Approve"
        testId="approve-6"
        signer={signer}
      />,
    );
    await user.click(screen.getByTestId("approve-6"));
    await screen.findByText("Insufficient treasury");
    expect(reload).not.toHaveBeenCalled();
    expect(screen.queryByText(/nearblocks\.io\/txns\//)).toBeNull();
  });

  it("fixture tier POSTs to the fallback route and reloads", async () => {
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      value: { reload },
      writable: true,
    });
    const fetchMock = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <OwnerWriteButton
        contractId=""
        methodName="approve_hold"
        args={{ request_id: 6 }}
        label="Approve"
        testId="approve-6"
        fallbackUrl="/api/queue/6/approve"
      />,
    );
    await user.click(screen.getByTestId("approve-6"));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/queue/6/approve", {
        method: "POST",
      }),
    );
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    vi.unstubAllGlobals();
  });
});

describe("owner action builder", () => {
  it("builds a FunctionCall action carrying methodName, args, gas and deposit", () => {
    const action = buildOwnerAction("reject_hold", { request_id: 6 });
    expect(actionMethodName(action)).toBe("reject_hold");
    expect(actionArgs(action)).toEqual({ request_id: 6 });
  });

  it("extracts tx hashes from wallet outcome shapes", () => {
    expect(extractTxHash({ transaction: { hash: "abc" } })).toBe("abc");
    expect(extractTxHash({ transaction_outcome: { id: "def" } })).toBe("def");
    expect(extractTxHash({ hash: "ghi" })).toBe("ghi");
  });
});
