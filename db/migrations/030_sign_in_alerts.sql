-- Best-effort new-sign-in alerts (#260). One row per owner and method records
-- when the last alert was sent, so a burst of sessions cannot flood the mailbox.
-- The owner row's cascade removes it with the account.
CREATE TABLE sign_in_alerts (
  owner_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  method text NOT NULL,
  last_sent_at timestamptz NOT NULL,
  PRIMARY KEY (owner_id, method)
);
