-- Weekly "your posts are ready" email (#275). It is on by default and can be
-- turned off on the account page.
ALTER TABLE auth_users ADD COLUMN weekly_email_enabled boolean NOT NULL DEFAULT true;

-- At most one email attempt per business per weekly period, even across a
-- restarted or duplicated worker. The row is claimed before the transport is
-- called and is never released, so a retry cannot send twice. `state='failed'`
-- records a best-effort attempt that the provider rejected; the batch itself is
-- unaffected. The provider also receives a deterministic idempotency key.
CREATE TABLE weekly_email_deliveries (
  business_id bigint NOT NULL,
  period_start date NOT NULL,
  state text NOT NULL DEFAULT 'sending' CHECK (state IN ('sending','sent','failed')),
  attempted_at timestamptz NOT NULL DEFAULT now(),
  message_id text,
  PRIMARY KEY (business_id, period_start),
  FOREIGN KEY (business_id, period_start)
    REFERENCES generation_periods (business_id, period_start) ON DELETE CASCADE
);
