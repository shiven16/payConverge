CREATE TABLE IF NOT EXISTS webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  payment_id TEXT,
  provider_updated_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_body TEXT NOT NULL,
  payload JSONB NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'stored',
  duplicate_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payments (
  payment_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  provider_updated_at TIMESTAMPTZ,
  terminal BOOLEAN NOT NULL DEFAULT false,
  conflict_pending BOOLEAN NOT NULL DEFAULT false,
  authority_status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payment_decisions (
  id BIGSERIAL PRIMARY KEY,
  payment_id TEXT NOT NULL,
  event_id TEXT,
  kind TEXT NOT NULL,
  reason TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conflicts (
  id BIGSERIAL PRIMARY KEY,
  payment_id TEXT NOT NULL,
  event_id TEXT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  authority_status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS outbox_commands (
  id BIGSERIAL PRIMARY KEY,
  payment_id TEXT NOT NULL,
  command_type TEXT NOT NULL,
  target TEXT NOT NULL,
  payload JSONB NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS merchant_effects (
  id BIGSERIAL PRIMARY KEY,
  target TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  command_type TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS authority_payments (
  payment_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  provider_updated_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS metrics_counters (
  name TEXT PRIMARY KEY,
  value BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS convergence_lags (
  id BIGSERIAL PRIMARY KEY,
  payment_id TEXT NOT NULL,
  milliseconds BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS runtime_controls (
  control_name TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL
);

INSERT INTO runtime_controls(control_name, enabled)
VALUES('webhook_ingestion', true), ('recovery_sweeper', true)
ON CONFLICT(control_name) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_webhook_events_payment ON webhook_events(payment_id);
CREATE INDEX IF NOT EXISTS idx_outbox_ready ON outbox_commands(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_decisions_payment ON payment_decisions(payment_id, created_at);
