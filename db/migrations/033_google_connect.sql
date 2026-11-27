-- Google Business Profile connect (#46 part 2). The OAuth state is single-use and
-- bound to both the owner and the business; only its SHA-256 hash is stored. A
-- pending grant holds the encrypted refresh token between the callback and the
-- owner choosing one of the locations Google returned.
ALTER TABLE google_connections ADD COLUMN location_title text;

CREATE TABLE google_oauth_states (
  state_hash text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  business_id bigint NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX google_oauth_states_owner ON google_oauth_states(owner_id, business_id);

-- One pending choice per business: a new callback replaces the previous grant.
-- `locations` holds only name/title/address from listLocations, never a token.
CREATE TABLE google_pending_grants (
  id bigserial PRIMARY KEY,
  owner_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  business_id bigint NOT NULL UNIQUE REFERENCES businesses(id) ON DELETE CASCADE,
  encrypted_refresh_token text NOT NULL,
  locations jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
