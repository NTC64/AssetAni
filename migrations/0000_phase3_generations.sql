CREATE TABLE IF NOT EXISTS generations (
  id UUID PRIMARY KEY,
  idempotency_key VARCHAR(64) NOT NULL UNIQUE,
  prompt TEXT NOT NULL,
  prompt_hash CHAR(64) NOT NULL,
  parameters JSONB NOT NULL,
  status VARCHAR(32) NOT NULL CHECK (
    status IN ('QUEUED', 'AI_SUBMITTED', 'AI_RUNNING', 'PROCESSING', 'UPLOADING', 'SUCCEEDED', 'FAILED', 'CANCELED')
  ),
  progress SMALLINT NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  provider VARCHAR(32),
  provider_model VARCHAR(128),
  provider_request_id VARCHAR(128),
  seed BIGINT CHECK (seed IS NULL OR seed BETWEEN 0 AND 4294967295),
  attempt SMALLINT NOT NULL DEFAULT 0,
  raw_object_key TEXT,
  sheet_object_key TEXT,
  package_object_key TEXT,
  manifest_object_key TEXT,
  error_code VARCHAR(64),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS generations_status_created_idx
  ON generations (status, created_at);
