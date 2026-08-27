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
  -- no_shot_idea | queued | generating | generated | awaiting_approval | approved | needs_redo | error
  -- 'generated' = images made, held for the next work-hours window before Ellie is pinged (see notifier.ts).
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
  -- NULL until the notifier actually sends it (gated by work hours).
  posted_to_chat_at   TIMESTAMPTZ,
  -- pending | approved | rejected
  decision            TEXT NOT NULL DEFAULT 'pending',
  -- Only set on rejection; see decideGeneration. Feeds the negative guidance
  -- appended to the prompt on the next /redo, so a reject actually teaches
  -- the next attempt instead of repeating blindly.
  reject_reason        TEXT,
  -- Who decided, for accountability/audit in a shared group chat (Ellie's
  -- pick is the decision, but Maya or others are in the same chat).
  decided_by_user_id   BIGINT,
  decided_by_username  TEXT,
  -- Set the first time this generation is included in a built /export.
  -- Once set, undo is refused — the CSV may already be in the web team's
  -- hands, so reopening it after that point would silently desync what
  -- they have from what we think is true. See undecideGeneration.
  exported_at          TIMESTAMPTZ,
  -- Automated pre-screen verdict (src/quality/screen.ts), before Ellie ever
  -- sees it. NULL = not screened (feature off). FALSE = flagged but still
  -- shown after one retry, so a paid-for variant isn't silently dropped.
  quality_passed       BOOLEAN,
  quality_reason       TEXT,
  cost_usd            NUMERIC(10, 4),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_generations_sku ON generations(sku);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);

-- Additive, idempotent migrations for columns added after the first deploy.
ALTER TABLE generations ADD COLUMN IF NOT EXISTS reject_reason TEXT;
ALTER TABLE generations ADD COLUMN IF NOT EXISTS decided_by_user_id BIGINT;
ALTER TABLE generations ADD COLUMN IF NOT EXISTS decided_by_username TEXT;
ALTER TABLE generations ADD COLUMN IF NOT EXISTS posted_to_chat_at TIMESTAMPTZ;
ALTER TABLE generations ADD COLUMN IF NOT EXISTS exported_at TIMESTAMPTZ;
ALTER TABLE generations ADD COLUMN IF NOT EXISTS quality_passed BOOLEAN;
ALTER TABLE generations ADD COLUMN IF NOT EXISTS quality_reason TEXT;
