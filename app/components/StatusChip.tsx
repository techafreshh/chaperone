import { statusMeta } from "../lib/status";

// Colored status chip: distinct color plus distinct text per state, from
// the single `STATUS_META` mapping. Unknown states fall back to the raw
// text on a neutral chip so new contract states stay visible.
export default function StatusChip({ status }: { status: string }) {
  const meta = statusMeta(status);
  return <span className={meta.chipClass}>{meta.label}</span>;
}
