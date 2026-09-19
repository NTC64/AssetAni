CREATE TABLE IF NOT EXISTS characters (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  generation_id UUID NOT NULL,
  name VARCHAR(80) NOT NULL,
  prompt TEXT NOT NULL,
  style VARCHAR(32) NOT NULL DEFAULT 'pixel_art',
  preset VARCHAR(32) NOT NULL,
  provider VARCHAR(32),
  provider_character_id VARCHAR(128),
  base_asset_key TEXT,
  frame_size SMALLINT NOT NULL CHECK (frame_size IN (128, 256)),
  status VARCHAR(16) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'READY', 'FAILED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS characters_user_created_idx ON characters(user_id, created_at);

CREATE TABLE IF NOT EXISTS generation_batches (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character_id UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  status VARCHAR(16) NOT NULL DEFAULT 'PROCESSING' CHECK (status IN ('PROCESSING', 'SUCCEEDED', 'PARTIAL', 'FAILED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS generation_batches_character_idx ON generation_batches(character_id);

ALTER TABLE generations ADD COLUMN IF NOT EXISTS character_id UUID REFERENCES characters(id);
ALTER TABLE generations ADD COLUMN IF NOT EXISTS batch_id UUID REFERENCES generation_batches(id);
ALTER TABLE generations ADD COLUMN IF NOT EXISTS generation_kind VARCHAR(16) NOT NULL DEFAULT 'animation';
ALTER TABLE generations ADD COLUMN IF NOT EXISTS animation_mode VARCHAR(16) NOT NULL DEFAULT 'standard';
ALTER TABLE generations ADD COLUMN IF NOT EXISTS qa_status VARCHAR(16) NOT NULL DEFAULT 'PENDING';
ALTER TABLE generations ADD COLUMN IF NOT EXISTS qa_warnings JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS character_animations (
  id UUID PRIMARY KEY,
  character_id UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  generation_id UUID NOT NULL UNIQUE REFERENCES generations(id) ON DELETE CASCADE,
  animation VARCHAR(16) NOT NULL,
  direction VARCHAR(24) NOT NULL,
  fps SMALLINT NOT NULL,
  frame_count SMALLINT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'QUEUED',
  qa_status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  qa_warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS character_animations_character_idx ON character_animations(character_id);
