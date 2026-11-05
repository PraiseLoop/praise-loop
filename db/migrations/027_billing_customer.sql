-- Store the provider's customer id for a subscription (#223) so the owner can
-- open the Stripe billing portal. Nullable: the fake adapter and rows created
-- before this migration have none, and an event without a customer id must never
-- wipe a stored one (the upsert uses COALESCE).
ALTER TABLE owner_subscriptions ADD COLUMN customer_id text;
