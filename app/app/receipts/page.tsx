import StatusChip from "../../components/StatusChip";
import TxLink from "../../components/TxLink";
import { getReceipts } from "../../lib/receipts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Server-rendered receipts waterfall (issue #63 sample-data honesty):
// one per-agent section per `agent_id` with every paid receipt as a
// `receipt-row`, plus plain-HTML audit-pack download links, so every
// probe string is in the first HTML byte stream with zero client JS.
// Fixture rows carry no signature strings: their signature/tx cells show
// `sample data`, and every fixture/stub row carries a visible
// `sample data` tag with its `source`. Non-fixture `chain_tx` values
// link to the explorer.
export default async function ReceiptsPage() {
  const receipts = await getReceipts();
  const network =
    (process.env.NEAR_NETWORK ?? "").trim() === "mainnet"
      ? "mainnet"
      : "testnet";
  const agentIds = [...new Set(receipts.map((row) => row.agent_id))].sort();
  const byAgent = new Map<string, typeof receipts>();
  for (const agent_id of agentIds) {
    byAgent.set(
      agent_id,
      receipts.filter((row) => row.agent_id === agent_id),
    );
  }
  return (
    <main>
      <h1>Receipts</h1>
      <p className="mt-1 text-sm text-slate-400">
        Paid receipts with their verdict signatures and chain transactions.
      </p>
      <div className="mt-2 flex flex-wrap gap-4 text-sm">
        <a href="/api/audit/export?format=json" className="underline">
          Download audit pack (JSON)
        </a>{" "}
        <a href="/api/audit/export?format=csv" className="underline">
          Download audit pack (CSV)
        </a>
      </div>
      {agentIds.map((agent_id) => (
        <section
          key={agent_id}
          aria-label={`Receipts for ${agent_id}`}
          className="mt-6"
        >
          <h2>{agent_id}</h2>
          <div className="mt-2 overflow-x-auto rounded-lg border border-slate-700">
            <table className="min-w-[720px]">
              <thead>
                <tr>
                  <th>Request</th>
                  <th>Payee</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Verdict signature</th>
                  <th>Chain tx</th>
                </tr>
              </thead>
              <tbody>
                {(byAgent.get(agent_id) ?? []).map((row) => (
                  <tr key={row.request_id} data-testid="receipt-row">
                    <td className="font-mono">{row.request_id}</td>
                    <td className="font-mono">{row.payee}</td>
                    <td className="font-mono">{row.amount_yocto}</td>
                    <td>
                      <StatusChip status={row.status} />{" "}
                      {row.source === "fixture" || row.source === "stub" ? (
                        <span className="ml-1 rounded bg-slate-700 px-1.5 py-0.5 text-xs text-slate-300">
                          sample data
                        </span>
                      ) : null}
                    </td>
                    <td className="break-all font-mono text-xs">
                      {row.source === "fixture" ? (
                        "sample data"
                      ) : row.verdict_signature !== "" ? (
                        row.verdict_signature
                      ) : (
                        <span className="font-sans text-slate-500">—</span>
                      )}
                    </td>
                    <td className="text-xs">
                      {row.source === "fixture" ? (
                        "sample data"
                      ) : row.chain_tx !== "" ? (
                        <TxLink hash={row.chain_tx} network={network} />
                      ) : (
                        <span className="text-slate-500">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </main>
  );
}
