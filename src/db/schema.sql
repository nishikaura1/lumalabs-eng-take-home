-- Idempotent: safe to run on every boot.

CREATE TABLE IF NOT EXISTS products (
  sku            TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  category       TEXT,
  color          TEXT,
  material       TEXT,
  price          TEXT,
  photo_url      TEXT NOT NULL,
  shot_idea      TEXT NOT NULL DEFAULT '',
  notes          TEXT,
  -- no_shot_idea | queued | generating | awaiting_approval | approved | needs_redo | error
  status         TEXT NOT NULL DEFAULT 'no_shot_idea',
  error_message  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS generations (
  id                  SERIAL PRIMARY KEY,
  sku                 TEXT NOT NULL REFERENCES products(sku) ON DELETE CASCADE,
  variant_index       INT NOT NULL,
  luma_generation_id  TEXT,
  s3_key              TEXT,
  telegram_message_id BIGINT,
  -- pending | approved | rejected
  decision            TEXT NOT NULL DEFAULT 'pending',
  -- Only set on rejection; see decideGeneration. Feeds the negative guidance
  -- appended to the prompt on the next /redo, so a reject actually teaches
  -- the next attempt instead of repeating blindly.
  reject_reason        TEXT,
  cost_usd            NUMERIC(10, 4),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_generations_sku ON generations(sku);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);

-- Additive, idempotent migrations for columns added after the first deploy.
ALTER TABLE generations ADD COLUMN IF NOT EXISTS reject_reason TEXT;
