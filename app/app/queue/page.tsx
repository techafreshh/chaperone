import { getQueueState } from "../../lib/queue";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Server-rendered approval queue: one held row per request with the
// objection text, the killed-agent banner, and plain-HTML approve/reject
// forms, so every probe string is in the first HTML byte stream with zero
// client JS.
export default async function QueuePage() {
  const state = await getQueueState();
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
                <form
                  method="post"
                  action={`/api/queue/${row.request_id}/approve`}
                >
                  <button
                    type="submit"
                    data-testid={`approve-${row.request_id}`}
                  >
                    Approve
                  </button>
                </form>
                <form
                  method="post"
                  action={`/api/queue/${row.request_id}/reject`}
                >
                  <button type="submit" data-testid={`reject-${row.request_id}`}>
                    Reject
                  </button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
