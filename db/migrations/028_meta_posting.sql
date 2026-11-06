-- Worker publishing through direct Meta (#234). A posting claim now records which
-- provider it was handed to, and enough provider-side state to retry safely:
--
-- provider        'buffer' or 'meta', fixed when the claim is first submitted
-- provider_target 'instagram' or 'facebook' for Meta (NULL for Buffer)
-- container_id    the Instagram media container created before publishing; a
--                 retry resumes with this id instead of creating another post
-- idempotency_key the local latch written before the first provider call
-- next_attempt_at a bounded retry after a rate limit or a transient error
-- submit_attempts how many times the worker has started a submission
ALTER TABLE posting_slot_claims
  ADD COLUMN provider text CHECK (provider IN ('buffer','meta')),
  ADD COLUMN provider_target text CHECK (provider_target IN ('instagram','facebook')),
  ADD COLUMN container_id text,
  ADD COLUMN idempotency_key text,
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN submit_attempts integer NOT NULL DEFAULT 0;

-- One key per draft attempt. A rescheduled or edited draft gets a new claim and a
-- new key, so an old attempt can never block the next one.
CREATE UNIQUE INDEX posting_slot_claims_idempotency
  ON posting_slot_claims (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- The worker looks for queued claims whose retry time has come.
CREATE INDEX posting_slot_claims_retry
  ON posting_slot_claims (next_attempt_at) WHERE state = 'queued';
