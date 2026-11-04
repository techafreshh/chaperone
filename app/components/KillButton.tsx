"use client";

// Owner-gated one-click kill/revive (issue #17): confirm-then-`fetch` over
// the session-cookie kill/revive routes, no wallet deps (server-only
// `near-api-js` stays out of this client component). Unauthenticated clicks
// fail closed at the route with 401; on 200 the page reloads so `GET
// /fleet` shows the flipped state.
export default function KillButton({
  agent_id,
  active,
}: {
  agent_id: string;
  active: boolean;
}) {
  const action = active ? "kill" : "revive";
  const label = active ? `Freeze ${agent_id}?` : `Revive ${agent_id}?`;
  const text = active ? "Freeze" : "Revive";
  async function onClick() {
    if (!window.confirm(label)) return;
    const res = await fetch(`/api/agents/${agent_id}/${action}`, {
      method: "POST",
    });
    if (res.ok) window.location.reload();
  }
  return (
    <button
      type="button"
      data-testid={`${action}-${agent_id}`}
      onClick={onClick}
    >
      {text}
    </button>
  );
}
