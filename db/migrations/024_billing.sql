-- Keep payment sources separate (#219). `owner_plans` stays the manual grant;
-- provider subscriptions live here, so a provider event can never overwrite a
-- manual plan or another provider's subscription. `billing_events` records each
-- provider event once so a duplicate delivery changes nothing.
CREATE TABLE owner_subscriptions (
  id bigserial PRIMARY KEY,
  owner_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  external_id text NOT NULL,
  plan text NOT NULL CHECK (plan IN ('free','pro','business')),
  status text NOT NULL,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  -- The provider event time that last changed this row. A delayed event from an
  -- older period compares against it and does not overwrite newer state.
  last_event_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_id)
);
CREATE INDEX owner_subscriptions_owner ON owner_subscriptions(owner_id);

CREATE TABLE billing_events (
  id bigserial PRIMARY KEY,
  provider text NOT NULL,
  event_id text NOT NULL,
  owner_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);
CREATE INDEX billing_events_owner ON billing_events(owner_id, occurred_at);
