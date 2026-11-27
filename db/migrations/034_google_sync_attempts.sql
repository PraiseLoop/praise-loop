-- Google Business Profile scheduled review sync (#46 part 3). The worker claims a
-- due connection by setting last_attempt_at before calling the provider, so two
-- workers cannot sync the same location and a failure backs off until the next
-- interval instead of retrying on every worker tick. NULL means never attempted:
-- a newly connected (or reconnected) location is due on the next tick.
ALTER TABLE google_connections ADD COLUMN last_attempt_at timestamptz;
