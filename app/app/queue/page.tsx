import OwnerWriteButton from "../../components/OwnerWriteButton";
import ReasonText from "../../components/ReasonText";
import StatusChip from "../../components/StatusChip";
import { getQueueState } from "../../lib/queue";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Approval queue: one held row per request with the objection text, the
// killed-agent banner, and wallet-signed decision buttons. Live tier
// (`GUARD_CONTRACT_ID` set): the operator signs `approve_hold` /
// `reject_hold` with the owner wallet in the browser; the server sends
// nothing. Fixture tier: the buttons POST to the server fixture routes.
// Every fixture/stub/overlay row is visibly labeled `sample data`
// (issue #63 — chain and mirror rows carry live evidence and show no
// tag).
export default async function QueuePage() {
  const state = await getQueueState();
  const contractId = (
    process.env.GUARD_CONTRACT_ID ??
    process.env.NEAR_CONTRACT_ID ??
    ""
  ).trim();
  const network =
    (process.env.NEAR_NETWORK ?? "").trim() === "mainnet"
      ? "mainnet"
      : "testnet";
  return (
    <main>
      <h1>Queue</h1>
      <p className="mt-1 text-sm text-slate-400">
        Held requests waiting on a human: approve to release the payment, or
        reject to close it.
      </p>
      <div className="mt-4 overflow-x-auto rounded-lg border border-slate-700">
        <table className="min-w-[720px]">
          <thead>
            <tr>
              <th>Request</th>
              <th>Agent</th>
              <th>Purpose</th>
              <th>Memo</th>
              <th>Invoice</th>
              <th>Objection</th>
              <th>Status</th>
              <th>Decision</th>
            </tr>
          </thead>
          <tbody>
            {state.requests.map((row) => (
              <tr key={row.request_id} data-testid={`queue-${row.request_id}`}>
                <td className="font-mono">{row.request_id}</td>
                <td className="font-mono">{row.agent_id}</td>
                <td>
                  <span className="font-mono">{String(row.purpose_ref ?? "")}</span>{" "}
                  <span className="text-slate-400">{String(row.vendor ?? "")}</span>
                </td>
                <td>{String(row.memo ?? "")}</td>
                <td>{String(row.description ?? "")}</td>
                <td>
                  <ReasonText
                    reason={String(row.reason ?? row.objection ?? "")}
                  />
                </td>
                <td>
                  <StatusChip status={row.status} />
                </td>
                <td>
                  {!row.active ? (
                    <p className="mb-2 rounded bg-red-950 px-2 py-1 text-xs font-semibold text-red-200">
                      agent frozen
                    </p>
                  ) : null}
                  {state.source !== "chain" && state.source !== "mirror" ? (
                    <span className="mb-2 inline-block rounded bg-slate-700 px-1.5 py-0.5 text-xs text-slate-300">
                      sample data
                    </span>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    <OwnerWriteButton
                      contractId={contractId}
                      network={network}
                      methodName="approve_hold"
                      args={{ request_id: row.request_id }}
                      label="Approve"
                      testId={`approve-${row.request_id}`}
                      confirmMessage={`Approve request ${row.request_id}?`}
                      fallbackUrl={`/api/queue/${row.request_id}/approve`}
                      fallbackMethod="POST"
                      className="rounded bg-emerald-700 px-3 py-1 text-sm font-semibold text-white hover:bg-emerald-600 disabled:opacity-50"
                    />
                    <OwnerWriteButton
                      contractId={contractId}
                      network={network}
                      methodName="reject_hold"
                      args={{ request_id: row.request_id }}
                      label="Reject"
                      testId={`reject-${row.request_id}`}
                      confirmMessage={`Reject request ${row.request_id}?`}
                      fallbackUrl={`/api/queue/${row.request_id}/reject`}
                      fallbackMethod="POST"
                      className="rounded bg-red-700 px-3 py-1 text-sm font-semibold text-white hover:bg-red-600 disabled:opacity-50"
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
