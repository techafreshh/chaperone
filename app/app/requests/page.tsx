import Badge from "../../components/Badge";
import { getMergedRequests } from "../../lib/supabase";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Server-rendered request feed (issue #63 sample-data honesty): every
// merged request with purpose, status, reason, attestation badge, and an
// explicit `source`. Fixture and stub rows render a visible `sample data`
// tag and never render `TEE-verified` (only backed chain/mirror rows do),
// so every probe string is in the first HTML byte stream with zero
// client JS.
export default async function RequestsPage() {
  const requests = await getMergedRequests();
  return (
    <main>
      <h1>Requests</h1>
      <table>
        <thead>
          <tr>
            <th>Request</th>
            <th>Purpose</th>
            <th>Status</th>
            <th>Reason</th>
            <th>Badge</th>
          </tr>
        </thead>
        <tbody>
          {requests.map((row) => (
            <tr key={row.request_id} data-testid={`request-${row.request_id}`}>
              <td>{row.request_id}</td>
              <td>
                {String(row.purpose_ref ?? "")} {String(row.vendor ?? "")}
              </td>
              <td>{row.status}</td>
              <td>{typeof row.reason === "string" ? row.reason : ""}</td>
              <td>
                <Badge
                  badge={row.badge}
                  requestId={row.request_id}
                  source={row.source}
                />
                {row.source !== "chain" && row.source !== "mirror" ? (
                  <span>sample data</span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
