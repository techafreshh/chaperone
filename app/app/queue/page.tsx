import OwnerWriteButton from "../../components/OwnerWriteButton";
import { getQueueState } from "../../lib/queue";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Approval queue: one held row per request with the objection text, the
// killed-agent banner, and wallet-signed decision buttons. Live tier
// (`GUARD_CONTRACT_ID` set): the operator signs `approve_hold` /
// `reject_hold` with the owner wallet in the browser; the server sends
// nothing. Fixture tier: the buttons POST to the server fixture routes.
// Every row is visibly labeled `fixture` unless the state came from the
// chain.
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
      <table>
        <thead>
          <tr>
            <th>Request</th>
            <th>Agent</th>
            <th>Purpose</th>
            <th>Objection</th>
            <th>Decision</th>
          </tr>
        </thead>
        <tbody>
          {state.requests.map((row) => (
            <tr key={row.request_id} data-testid={`queue-${row.request_id}`}>
              <td>{row.request_id}</td>
              <td>{row.agent_id}</td>
              <td>
                {String(row.purpose_ref ?? "")} {String(row.vendor ?? "")}
              </td>
              <td>{String(row.reason ?? row.objection ?? "")}</td>
              <td>
                {!row.active ? <p>agent frozen</p> : null}
                {state.source !== "chain" ? <span>fixture</span> : null}
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
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
