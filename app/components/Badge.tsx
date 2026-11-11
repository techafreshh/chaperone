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
      data-testid={
        requestId === undefined ? "badge" : `badge-${requestId}`
      }
    >
      {badgeToLabel(effective)}
    </span>
  );
}
