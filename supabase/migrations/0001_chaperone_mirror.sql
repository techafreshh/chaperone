-- Chaperone Supabase mirror (issue #12).
--
-- Read-only query mirror of the on-chain guard contract. The chain stays
-- the source of truth; these tables are never authoritative for payment.
-- All yocto amounts are TEXT: u128 values exceed Postgres BIGINT.
-- `request_id` is BIGINT: the on-chain id is a u64.
--
-- Apply with the Supabase SQL editor or `supabase db push`.

CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,
  allowance_yocto TEXT NOT NULL,
  cap_yocto TEXT NOT NULL,
  active BOOLEAN NOT NULL,
  payee_allowlist JSONB NOT NULL DEFAULT '[]',
  spent_today_yocto TEXT NOT NULL DEFAULT '0',
  remaining_today_yocto TEXT NOT NULL DEFAULT '0',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS requests (
  request_id BIGINT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  payee TEXT NOT NULL,
  amount_yocto TEXT NOT NULL,
  purpose_ref TEXT NOT NULL,
  vendor TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS verdicts (
  request_id BIGINT PRIMARY KEY,
  consistent BOOLEAN NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id BIGSERIAL PRIMARY KEY,
  event TEXT NOT NULL,
  subject TEXT NOT NULL,
  request_id BIGINT,
  agent_id TEXT,
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event, subject)
);

CREATE INDEX IF NOT EXISTS idx_requests_status ON requests (status);
CREATE INDEX IF NOT EXISTS idx_audit_events_request_id ON audit_events (request_id);
