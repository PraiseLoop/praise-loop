-- Posting through Buffer (#29 part 3). The schedule lives here; the worker submits an
-- approved post to Buffer at its due time. posting_slot_claims becomes the single
-- record of that submission, so its states widen.
--
-- queued     slot reserved in PraiseLoop, waiting for the due time (nothing sent)
-- submitting committed BEFORE the network call; a crash here leaves it as-is and the
--            worker marks it `unknown` (Buffer does not deduplicate, never resubmit)
-- submitted  Buffer accepted the post; we poll its status
-- sent       Buffer reports it was published (the only state shown as published)
-- drafted    posting mode `draft`: saved as a draft in Buffer, nothing published
-- error      Buffer reported a failure, or rejected the post
-- missed     the due time passed by more than the lateness window while we were down
-- unknown    outcome cannot be proven either way; the owner resolves it
ALTER TABLE posting_slot_claims DROP CONSTRAINT posting_slot_claims_state_check;
UPDATE posting_slot_claims SET state='queued' WHERE state='pending';
UPDATE posting_slot_claims SET state='submitted' WHERE state='confirmed';
ALTER TABLE posting_slot_claims ALTER COLUMN state SET DEFAULT 'queued';
ALTER TABLE posting_slot_claims ADD CONSTRAINT posting_slot_claims_state_check
  CHECK (state IN ('queued','submitting','submitted','sent','drafted','error','missed','unknown'));

ALTER TABLE posting_slot_claims
  ADD COLUMN mode text CHECK (mode IN ('draft','live')),
  -- Only the SHA-256 hash of the public image token is stored; the token itself
  -- exists only inside the URL handed to Buffer.
  ADD COLUMN image_token_hash text UNIQUE,
  ADD COLUMN image_expires_at timestamptz,
  ADD COLUMN submitted_at timestamptz,
  ADD COLUMN next_check_at timestamptz,
  ADD COLUMN check_count integer NOT NULL DEFAULT 0,
  ADD COLUMN buffer_status text,
  ADD COLUMN external_link text,
  ADD COLUMN sent_at timestamptz,
  ADD COLUMN error_code text,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- The worker looks for due queued claims and for submitted claims due a status check.
CREATE INDEX posting_slot_claims_due ON posting_slot_claims (instant) WHERE state = 'queued';
CREATE INDEX posting_slot_claims_check ON posting_slot_claims (next_check_at) WHERE state = 'submitted';

-- A personal Instagram channel is notification-only in Buffer and can never post by
-- itself, so the saved selection remembers the channel type to refuse it up front.
ALTER TABLE business_buffer_channels ADD COLUMN channel_type text NOT NULL DEFAULT '';
