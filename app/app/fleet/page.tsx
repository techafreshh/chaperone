import AgentCard from "../../components/AgentCard";
import KillButton from "../../components/KillButton";
import { formatYoctoToNear, getFleetState } from "../../lib/fleet";

export const dynamic = "force-dynamic";

// Fleet page: treasury balance, one card per agent, wallet-signed
// freeze/revive plus the fixture-tier add/edit forms. Live tier
// (`GUARD_CONTRACT_ID` set): the operator signs `set_agent_active`
// (freeze/revive), `register_agent` and `set_agent_policy` with the owner
// wallet in the browser; the server sends nothing. Fixture tier: the
// forms POST to the server fixture routes. Every agent row is visibly
// labeled `fixture` unless the state came from the chain, and `frozen`
// renders only when the chain view says `active: false` (or on a
// fixture-labeled row).
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
      <section aria-label="Treasury">
        <h2>Treasury</h2>
        <div data-testid="treasury-balance">
          {formatYoctoToNear(state.treasuryYocto)} N
        </div>
      </section>
      <section aria-label="Agents">
        <h2>Agents</h2>
        <div>
          {state.agents.map((agent) => (
            <div key={agent.agent_id}>
              <AgentCard
                agent_id={agent.agent_id}
                allowance_yocto={agent.allowance_yocto}
                cap_yocto={agent.cap_yocto}
                remaining_today_yocto={agent.remaining_today_yocto}
                active={agent.active}
              />
              {state.source !== "chain" ? <span>fixture</span> : null}
              <KillButton
                agent_id={agent.agent_id}
                active={agent.active}
                contractId={contractId}
                network={network}
              />
              <form
                data-testid={`edit-agent-${agent.agent_id}`}
                method="post"
                action="/api/agents"
              >
                <input type="hidden" name="agent_id" value={agent.agent_id} />
                <label>
                  Allowance (yocto)
                  <input name="allowance_yocto" defaultValue={agent.allowance_yocto} />
                </label>
                <label>
                  Cap (yocto)
                  <input name="cap_yocto" defaultValue={agent.cap_yocto} />
                </label>
                <label>
                  Active
                  <select
                    name="active"
                    defaultValue={agent.active ? "true" : "false"}
                  >
                    <option value="true">active</option>
                    <option value="false">frozen</option>
                  </select>
                </label>
                <button type="submit">Save</button>
              </form>
            </div>
          ))}
        </div>
      </section>
      <section aria-label="Add agent">
        <h2>Add agent</h2>
        <form data-testid="add-agent-form" method="post" action="/api/agents">
          <label>
            Agent ID
            <input name="agent_id" placeholder="agent-5" />
          </label>
          <label>
            Allowance (yocto)
            <input
              name="allowance_yocto"
              placeholder="50000000000000000000000000"
            />
          </label>
          <label>
            Cap (yocto)
            <input name="cap_yocto" placeholder="10000000000000000000000000" />
          </label>
          <button type="submit">Add agent</button>
        </form>
      </section>
    </main>
  );
}
