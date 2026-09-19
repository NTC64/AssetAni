CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  email VARCHAR(320) NOT NULL UNIQUE,
  paddle_customer_id VARCHAR(64) UNIQUE,
  plan VARCHAR(32) NOT NULL DEFAULT 'free',
  subscription_status VARCHAR(32) NOT NULL DEFAULT 'none',
  credit_balance INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT users_credit_balance_nonnegative CHECK (credit_balance >= 0)
);

CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100),
  key_prefix VARCHAR(16) NOT NULL,
  key_hash CHAR(64) NOT NULL UNIQUE,
  scopes JSONB NOT NULL,
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS api_keys_user_idx ON api_keys (user_id);

INSERT INTO users (id, email, plan, subscription_status, credit_balance)
VALUES ('00000000-0000-4000-8000-000000000000', 'legacy@local.invalid', 'free', 'none', 0)
ON CONFLICT (email) DO NOTHING;

ALTER TABLE generations ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE generations ADD COLUMN IF NOT EXISTS api_key_id UUID;
ALTER TABLE generations ADD COLUMN IF NOT EXISTS credit_cost INTEGER NOT NULL DEFAULT 1;
ALTER TABLE generations ADD COLUMN IF NOT EXISTS provider_cost_usd NUMERIC(10,6);
ALTER TABLE generations ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

UPDATE generations
SET user_id = '00000000-0000-4000-8000-000000000000'
WHERE user_id IS NULL;

ALTER TABLE generations ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE generations
  ADD CONSTRAINT generations_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);
ALTER TABLE generations
  ADD CONSTRAINT generations_api_key_id_fkey FOREIGN KEY (api_key_id) REFERENCES api_keys(id);
ALTER TABLE generations DROP CONSTRAINT IF EXISTS generations_idempotency_key_key;
ALTER TABLE generations
  ADD CONSTRAINT generations_user_idempotency_unique UNIQUE (user_id, idempotency_key);

CREATE INDEX IF NOT EXISTS generations_user_status_idx
  ON generations (user_id, status);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  generation_id UUID REFERENCES generations(id),
  delta INTEGER NOT NULL,
  reason VARCHAR(32) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL UNIQUE,
  paddle_transaction_id VARCHAR(64),
  balance_after INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT credit_ledger_balance_after_nonnegative CHECK (balance_after >= 0)
);

CREATE INDEX IF NOT EXISTS credit_ledger_user_created_idx
  ON credit_ledger (user_id, created_at);
