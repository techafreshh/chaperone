import { formatYoctoToNear } from "../lib/fleet";

export interface AgentCardProps {
  agent_id: string;
  allowance_yocto: string;
  cap_yocto: string;
  remaining_today_yocto: string;
  active: boolean;
}

function usagePercent(allowanceYocto: string, remainingYocto: string): number {
  try {
    const allowance = BigInt(allowanceYocto);
    if (allowance <= BigInt(0)) return 0;
    const remaining = BigInt(remainingYocto);
    const used = allowance >= remaining ? allowance - remaining : BigInt(0);
    return Number((used * BigInt(100)) / allowance);
  } catch {
    return 0;
  }
}

// Presentational fleet card: id text, allowance/cap lines, a literal
// `Remaining today` line, the allowance used-vs-remaining bar, and the
// lowercase state word (`frozen` when inactive, else `active`). Frozen
// cards render visibly distinct. No data fetching inside.
export default function AgentCard(props: AgentCardProps) {
  const state = props.active ? "active" : "frozen";
  const used = usagePercent(props.allowance_yocto, props.remaining_today_yocto);
  return (
    <article
      data-testid={`agent-card-${props.agent_id}`}
      className={
        props.active
          ? "rounded-lg border border-slate-700 bg-slate-900 p-4"
          : "rounded-lg border-2 border-red-700 bg-red-950/40 p-4"
      }
    >
      <h3 className="text-lg font-semibold text-white">{props.agent_id}</h3>
      <p className="text-slate-300">
        Allowance: {formatYoctoToNear(props.allowance_yocto)} N
      </p>
      <p className="text-slate-300">Cap: {formatYoctoToNear(props.cap_yocto)} N</p>
      <p className="text-slate-300">
        Remaining today: {formatYoctoToNear(props.remaining_today_yocto)} N
      </p>
      <div
        role="progressbar"
        aria-label={`Allowance used for ${props.agent_id}`}
        aria-valuenow={used}
        aria-valuemin={0}
        aria-valuemax={100}
        className="mt-2 h-2 w-full overflow-hidden rounded bg-slate-700"
      >
        <div
          className={props.active ? "h-full bg-sky-500" : "h-full bg-red-500"}
          style={{ width: `${used}%` }}
        />
      </div>
      <p className={props.active ? "text-slate-300" : "font-semibold text-red-300"}>
        State: {state}
      </p>
    </article>
  );
}
