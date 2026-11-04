import { badgeToLabel, type RequestBadge } from "../lib/supabase";

export interface BadgeProps {
  badge: RequestBadge;
  requestId?: string | number;
}

// Presentational attestation badge: short badge in, literal honest label
// out (`verified` -> `TEE-verified`, `unverifiable` ->
// `attestation unverifiable`, `deterministic-only` -> `deterministic-only`).
// Binary-honest states only: never renders `TEE-verified` unless verified.
// No data fetching inside.
export default function Badge({ badge, requestId }: BadgeProps) {
  return (
    <span
      data-testid={
        requestId === undefined ? "badge" : `badge-${requestId}`
      }
    >
      {badgeToLabel(badge)}
    </span>
  );
}
