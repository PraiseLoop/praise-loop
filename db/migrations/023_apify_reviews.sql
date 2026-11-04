-- Stopgap Google review fetch through Apify (#232). The source is deliberately
-- separate from the official sync (#46): these rows stay identifiable and can be
-- removed or reconciled without touching `google` rows. Google's terms prohibit
-- bulk scraping; this exists only until #46 is available.
ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_source_check;
ALTER TABLE reviews ADD CONSTRAINT reviews_source_check
  CHECK (source IN ('manual', 'google', 'apify_google'));

-- One confirmed place per business, recorded with who accepted that it is their
-- own business and when. The owner cannot be verified here, so the confirmation
-- is stored rather than assumed.
CREATE TABLE apify_review_places (
  business_id bigint PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  place_input text NOT NULL,
  place_kind text NOT NULL CHECK (place_kind IN ('place_id', 'place_url', 'short_url')),
  confirmed_by text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One row per Apify run. The provider's status is kept verbatim; `imported_at`
-- is the conditional claim that makes a successful dataset import happen once.
CREATE TABLE apify_review_runs (
  id bigserial PRIMARY KEY,
  business_id bigint NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  run_id text NOT NULL UNIQUE,
  dataset_id text,
  status text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  imported_at timestamptz,
  imported integer NOT NULL DEFAULT 0,
  duplicates integer NOT NULL DEFAULT 0,
  rejected integer NOT NULL DEFAULT 0,
  skipped integer NOT NULL DEFAULT 0,
  failed_rows integer NOT NULL DEFAULT 0,
  error_code text
);
CREATE INDEX apify_review_runs_business ON apify_review_runs(business_id, started_at DESC);
