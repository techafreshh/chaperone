import { getReceipts } from "../../lib/receipts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Server-rendered receipts waterfall (issue #63 sample-data honesty):
// one per-agent section per `agent_id` with every paid receipt as a
// `receipt-row`, plus plain-HTML audit-pack download links, so every
// probe string is in the first HTML byte stream with zero client JS.
// Fixture rows carry no signature strings: their signature/tx cells show
// `sample data`, and every fixture/stub row carries a visible
// `sample data` tag with its `source`.
export default async function ReceiptsPage() {
  const receipts = await getReceipts();
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
      <div>
        <a href="/api/audit/export?format=json">Download audit pack (JSON)</a>{" "}
        <a href="/api/audit/export?format=csv">Download audit pack (CSV)</a>
      </div>
      {agentIds.map((agent_id) => (
        <section key={agent_id} aria-label={`Receipts for ${agent_id}`}>
          <h2>{agent_id}</h2>
          <table>
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
                  <td>{row.request_id}</td>
                  <td>{row.payee}</td>
                  <td>{row.amount_yocto}</td>
                  <td>{row.status}</td>
                  <td>
                    {row.source === "fixture"
                      ? "sample data"
                      : row.verdict_signature}
                  </td>
                  <td>
                    {row.source === "fixture" ? "sample data" : row.chain_tx}
                  </td>
                  {row.source === "fixture" || row.source === "stub" ? (
                    <td>
                      <span>sample data</span>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </main>
  );
}
