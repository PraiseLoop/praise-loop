-- Google Takeout review import (#233). The file is the owner's own Business Profile
-- export, not an API or scraping source, so its rows stay separately identifiable
-- from `manual`, `google` and `apify_google` rows.
ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_source_check;
ALTER TABLE reviews ADD CONSTRAINT reviews_source_check
  CHECK (source IN ('manual', 'google', 'apify_google', 'google_takeout'));
