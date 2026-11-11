import AgentCard from "../../components/AgentCard";
import KillButton from "../../components/KillButton";
import { formatYoctoToNear, getFleetState } from "../../lib/fleet";

export const dynamic = "force-dynamic";

// Fleet page (issue #63 sample-data honesty): treasury balance, one card
// per agent, wallet-signed freeze/revive plus the fixture-tier add/edit
// forms. Live tier (`GUARD_CONTRACT_ID` set): the operator signs
// `set_agent_active` (freeze/revive), `register_agent` and
// `set_agent_policy` with the owner wallet in the browser; the server
// sends nothing. Fixture tier: the forms POST to the server fixture
// routes. Every fixture/stub/overlay row is visibly labeled `sample data`
// (chain and mirror rows carry live evidence and show no tag), and
// `frozen` renders only when the chain view says `active: false` (or on a
// sample-data row).
export default async function FleetPage() {
  const state = await getFleetState();
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
      <h1>Fleet</h1>
      <section
        aria-label="Treasury"
        className="mt-4 rounded-lg border border-slate-700 bg-slate-900 p-4"
      >
        <h2>Treasury</h2>
        <div data-testid="treasury-balance" className="font-mono text-xl text-white">
          {formatYoctoToNear(state.treasuryYocto)} N
        </div>
      </section>
      <section aria-label="Agents" className="mt-6">
        <h2>Agents</h2>
        <div className="mt-2 grid gap-4 sm:grid-cols-2">
          {state.agents.map((agent) => (
            <div key={agent.agent_id} className="space-y-2">
              <AgentCard
                agent_id={agent.agent_id}
                allowance_yocto={agent.allowance_yocto}
                cap_yocto={agent.cap_yocto}
                remaining_today_yocto={agent.remaining_today_yocto}
                active={agent.active}
              />
              {agent.source !== "chain" && agent.source !== "mirror" ? (
                <span className="inline-block rounded bg-slate-700 px-1.5 py-0.5 text-xs text-slate-300">
                  sample data
                </span>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                <KillButton
                  agent_id={agent.agent_id}
                  active={agent.active}
                  contractId={contractId}
                  network={network}
                />
              </div>
              <form
                data-testid={`edit-agent-${agent.agent_id}`}
                method="post"
                action="/api/agents"
                className="space-y-2 rounded-lg border border-slate-700 bg-slate-900 p-3 text-sm"
              >
                <input type="hidden" name="agent_id" value={agent.agent_id} />
                <label className="block">
                  <span className="text-slate-300">Allowance (yocto)</span>
                  <input
                    name="allowance_yocto"
                    defaultValue={agent.allowance_yocto}
                    className="mt-1 block w-full rounded border border-slate-600 bg-slate-800 px-2 py-1 font-mono text-slate-100"
                  />
                </label>
                <label className="block">
                  <span className="text-slate-300">Cap (yocto)</span>
                  <input
                    name="cap_yocto"
                    defaultValue={agent.cap_yocto}
                    className="mt-1 block w-full rounded border border-slate-600 bg-slate-800 px-2 py-1 font-mono text-slate-100"
                  />
                </label>
                <label className="block">
                  <span className="text-slate-300">Active</span>
                  <select
                    name="active"
                    defaultValue={agent.active ? "true" : "false"}
                    className="mt-1 block rounded border border-slate-600 bg-slate-800 px-2 py-1 text-slate-100"
                  >
                    <option value="true">active</option>
                    <option value="false">frozen</option>
                  </select>
                </label>
                <button
                  type="submit"
                  className="rounded bg-sky-700 px-3 py-1 text-sm font-semibold text-white hover:bg-sky-600"
                >
                  Save
                </button>
              </form>
            </div>
          ))}
        </div>
      </section>
      <section
        aria-label="Add agent"
        className="mt-6 rounded-lg border border-slate-700 bg-slate-900 p-4"
      >
        <h2>Add agent</h2>
        <form
          data-testid="add-agent-form"
          method="post"
          action="/api/agents"
          className="mt-2 space-y-2 text-sm"
        >
          <label className="block">
            <span className="text-slate-300">Agent ID</span>
            <input
              name="agent_id"
              placeholder="agent-5"
              className="mt-1 block w-full rounded border border-slate-600 bg-slate-800 px-2 py-1 font-mono text-slate-100"
            />
          </label>
          <label className="block">
            <span className="text-slate-300">Allowance (yocto)</span>
            <input
              name="allowance_yocto"
              placeholder="50000000000000000000000000"
              className="mt-1 block w-full rounded border border-slate-600 bg-slate-800 px-2 py-1 font-mono text-slate-100"
            />
          </label>
          <label className="block">
            <span className="text-slate-300">Cap (yocto)</span>
            <input
              name="cap_yocto"
              placeholder="10000000000000000000000000"
              className="mt-1 block w-full rounded border border-slate-600 bg-slate-800 px-2 py-1 font-mono text-slate-100"
            />
          </label>
          <button
            type="submit"
            className="rounded bg-sky-700 px-3 py-1 text-sm font-semibold text-white hover:bg-sky-600"
          >
            Add agent
          </button>
        </form>
      </section>
    </main>
  );
}
