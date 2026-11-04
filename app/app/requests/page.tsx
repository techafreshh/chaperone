import Badge from "../../components/Badge";
import { getMergedRequests } from "../../lib/supabase";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Server-rendered request feed: every merged request with purpose chip,
// status, reason, and attestation badge, so every probe string is in the
// first HTML byte stream with zero client JS.
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
                <Badge badge={row.badge} requestId={row.request_id} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
