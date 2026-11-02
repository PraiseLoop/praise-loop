-- Buffer OAuth connect (#29). Tokens are AES-256-GCM envelopes bound to the owner
-- (lib/integrations/credentials.ts); no plaintext credential is stored.
CREATE TABLE buffer_connections (
  id bigserial PRIMARY KEY,
  owner_id text NOT NULL UNIQUE REFERENCES auth_users(id) ON DELETE CASCADE,
  organization_id text NOT NULL,
  encrypted_access_token text NOT NULL,
  encrypted_refresh_token text NOT NULL,
  access_expires_at timestamptz NOT NULL,
  scope text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','needs_reconnect')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Short-lived, single-use OAuth state. Only the SHA-256 hash is stored, so reading
-- the table cannot replay the browser's state; the PKCE verifier stays encrypted.
CREATE TABLE buffer_oauth_states (
  state_hash text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  encrypted_code_verifier text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The channel a business posts to. Deleting the owner's connection (or the
-- business, or the owner) cascades this selection away.
CREATE TABLE business_buffer_channels (
  business_id bigint PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  connection_id bigint NOT NULL REFERENCES buffer_connections(id) ON DELETE CASCADE,
  channel_id text NOT NULL,
  channel_name text NOT NULL,
  service text NOT NULL CHECK (service IN ('instagram','facebook')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
