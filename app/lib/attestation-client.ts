// Client-side fetch helper for `/attestation/status` with an honest
// degradation: any transport failure (verifier process down, unreachable
// route, malformed body) falls back to `deterministic-only` instead of
// throwing.

export type AttestationBadge =
  | "verified"
  | "unverifiable"
  | "deterministic-only";

export interface AttestationStatus {
  badge: AttestationBadge;
  details?: unknown;
}

function isStatusBadge(value: unknown): value is AttestationBadge {
  return (
    value === "verified" ||
    value === "unverifiable" ||
    value === "deterministic-only"
  );
}

export async function fetchAttestationStatus(
  fetchImpl: typeof fetch = fetch,
  url = "/attestation/status",
): Promise<AttestationStatus> {
  try {
    const response = await fetchImpl(url);
    if (!response.ok) return { badge: "deterministic-only" };
    const body = (await response.json()) as { badge?: unknown };
    if (body !== null && typeof body === "object" && isStatusBadge(body.badge))
      return body as AttestationStatus;
    return { badge: "deterministic-only" };
  } catch {
    return { badge: "deterministic-only" };
  }
}
