ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS brand_voice TEXT,
  ADD COLUMN IF NOT EXISTS brand_voice_source_url TEXT,
  ADD COLUMN IF NOT EXISTS brand_voice_updated_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'businesses_brand_voice_length'
  ) THEN
    ALTER TABLE businesses
      ADD CONSTRAINT businesses_brand_voice_length
      CHECK (brand_voice IS NULL OR char_length(brand_voice) <= 1200);
  END IF;
END $$;
