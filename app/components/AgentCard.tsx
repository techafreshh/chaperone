import { formatYoctoToNear } from "../lib/fleet";

export interface AgentCardProps {
  agent_id: string;
  allowance_yocto: string;
  cap_yocto: string;
  remaining_today_yocto: string;
  active: boolean;
}

// Presentational fleet card: id text, allowance/cap lines, a literal
// `Remaining today` line, and the lowercase state word (`frozen` when
// inactive, else `active`). No data fetching inside.
export default function AgentCard(props: AgentCardProps) {
  const state = props.active ? "active" : "frozen";
  return (
    <article data-testid={`agent-card-${props.agent_id}`}>
      <h3>{props.agent_id}</h3>
      <p>Allowance: {formatYoctoToNear(props.allowance_yocto)} N</p>
      <p>Cap: {formatYoctoToNear(props.cap_yocto)} N</p>
      <p>Remaining today: {formatYoctoToNear(props.remaining_today_yocto)} N</p>
      <p>State: {state}</p>
    </article>
  );
}
