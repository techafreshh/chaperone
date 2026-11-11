import Badge from "../../components/Badge";
import ReasonText from "../../components/ReasonText";
import StatusChip from "../../components/StatusChip";
import TxLink from "../../components/TxLink";
import { getMergedRequests } from "../../lib/supabase";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Server-rendered request feed (issue #63 sample-data honesty): every
// merged request with purpose, status chip, reason code plus sentence,
// attestation badge, chain-tx explorer link, and an explicit `source`.
// Fixture and stub rows render a visible `sample data` tag and never
// render `TEE-verified` (only backed chain/mirror rows do), so every
// probe string is in the first HTML byte stream with zero client JS.
export default async function RequestsPage() {
  const requests = await getMergedRequests();
  const network =
    (process.env.NEAR_NETWORK ?? "").trim() === "mainnet"
      ? "mainnet"
      : "testnet";
  return (
    <main>
      <h1>Requests</h1>
      <p className="mt-1 text-sm text-slate-400">
        Every payment request the guard has seen, newest first. Blocked
        payments show their reason code and what it means.
      </p>
      <div className="mt-4 overflow-x-auto rounded-lg border border-slate-700">
        <table className="min-w-[640px]">
          <thead>
            <tr>
              <th>Request</th>
              <th>Purpose</th>
              <th>Status</th>
              <th>Reason</th>
              <th>Chain tx</th>
              <th>Badge</th>
              <th>Evidence</th>
            </tr>
          </thead>
          <tbody>
            {requests.map((row) => {
              const record = row as unknown as Record<string, unknown>;
              const chainTx =
                typeof record.chain_tx === "string"
                  ? (record.chain_tx as string)
                  : typeof record.tx_hash === "string"
                    ? (record.tx_hash as string)
                    : typeof record.transaction_hash === "string"
                      ? (record.transaction_hash as string)
                      : typeof record.txHash === "string"
                        ? (record.txHash as string)
                        : "";
              return (
                <tr
                  key={row.request_id}
                  id={`request-${row.request_id}`}
                  data-testid={`request-${row.request_id}`}
                >
                  <td className="font-mono">{row.request_id}</td>
                  <td>
                    <span className="font-mono">{String(row.purpose_ref ?? "")}</span>{" "}
                    <span className="text-slate-400">{String(row.vendor ?? "")}</span>
                  </td>
                  <td>
                    <StatusChip status={row.status} />
                  </td>
                  <td>
                    <ReasonText
                      reason={
                        typeof row.reason === "string" ? row.reason : null
                      }
                    />
                  </td>
                  <td>
                    {chainTx !== "" ? (
                      <TxLink hash={chainTx} network={network} />
                    ) : (
                      <span className="text-slate-500">—</span>
                    )}
                  </td>
                  <td>
                    <Badge
                      badge={row.badge}
                      requestId={row.request_id}
                      source={row.source}
                    />{" "}
                    {row.source !== "chain" && row.source !== "mirror" ? (
                      <span className="ml-1 rounded bg-slate-700 px-1.5 py-0.5 text-xs text-slate-300">
                        sample data
                      </span>
                    ) : null}
                  </td>
                  <td>
                    <a
                      href={`/api/evidence/${row.request_id}`}
                      data-testid={`evidence-${row.request_id}`}
                    >
                      evidence
                    </a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </main>
  );
}
