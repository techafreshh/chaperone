import {
  badgeToLabel,
  type RequestBadge,
  type RequestSource,
} from "../lib/supabase";

export interface BadgeProps {
  badge: RequestBadge;
  requestId?: string | number;
  source?: RequestSource | string;
}

function badgeClass(badge: RequestBadge): string {
  const base =
    "inline-block rounded-full border px-2 py-0.5 text-xs font-semibold whitespace-nowrap";
  if (badge === "verified") {
    return `${base} border-emerald-500 bg-emerald-950 text-emerald-200`;
  }
  if (badge === "unverifiable") {
    return `${base} border-amber-500 bg-amber-950 text-amber-200`;
  }
  return `${base} border-slate-500 bg-slate-800 text-slate-300`;
}

// Presentational attestation badge: short badge in, literal honest label
// out (`verified` -> `TEE-verified`, `unverifiable` ->
// `attestation unverifiable`, `deterministic-only` -> `deterministic-only`).
// Binary-honest states only: never renders `TEE-verified` for fixture or
// stub rows (issue #63 defense in depth — `resolveRequestBadge` already
// forces those to `deterministic-only`). No data fetching inside.
export default function Badge({ badge, requestId, source }: BadgeProps) {
  const effective: RequestBadge =
    (source === "fixture" || source === "stub") && badge === "verified"
      ? "deterministic-only"
      : badge;
  return (
    <span
      className={badgeClass(effective)}
      data-testid={
        requestId === undefined ? "badge" : `badge-${requestId}`
      }
    >
      {badgeToLabel(effective)}
    </span>
  );
}
