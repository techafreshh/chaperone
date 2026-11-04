// Structural env carrier for lib helpers. Production code only reads
// specific keys (SUPABASE_URL, GUARD_CONTRACT_ID, stub-file paths, ...)
// and must not require Next's augmented `NODE_ENV`.
export type Env = Record<string, string | undefined>;
