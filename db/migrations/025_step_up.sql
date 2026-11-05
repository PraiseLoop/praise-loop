-- Step-up confirmation before sensitive steps (#221).
-- Sign-in and step-up codes share email_sign_in_codes; the purpose column keeps
-- them apart, so a code issued for one can never be consumed by the other and a
-- new request only supersedes an earlier code of its own purpose.
ALTER TABLE email_sign_in_codes ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'sign_in';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_sign_in_codes_purpose_check') THEN
    ALTER TABLE email_sign_in_codes
      ADD CONSTRAINT email_sign_in_codes_purpose_check CHECK (purpose IN ('sign_in','step_up'));
  END IF;
END
$$;
DROP INDEX IF EXISTS email_sign_in_codes_active;
CREATE INDEX email_sign_in_codes_active ON email_sign_in_codes(email, purpose, created_at DESC)
  WHERE consumed_at IS NULL AND superseded_at IS NULL;

-- A successful step-up marks only the session that verified it. auth_sessions
-- already has created_at (migration 012), so owners without an address can be
-- judged by how recently they signed in. Every existing row has step_up_at NULL,
-- which means "no step-up yet"; a step-up never carries over to a new session.
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS step_up_at timestamptz;
