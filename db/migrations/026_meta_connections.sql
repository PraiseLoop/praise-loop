-- Direct Meta publishing (#234). Connect stores the Pages a Facebook user
-- manages and a long-lived Page token for each, encrypted with
-- CREDENTIAL_ENCRYPTION_KEY and bound to the owner and Page. The long-lived User
-- token is used only during the callback and is never stored.
CREATE TABLE meta_connections (
  id bigserial PRIMARY KEY,
  owner_id text NOT NULL UNIQUE REFERENCES auth_users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','needs_reconnect')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Short-lived, single-use OAuth state. Only the SHA-256 hash is stored, so a
-- database read cannot replay the browser's state.
CREATE TABLE meta_oauth_states (
  state_hash text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One row per Facebook Page the owner can publish from. `page_id` is Meta's Page
-- id; `id` is the local key a business selects. A Page without a linked Instagram
-- professional account has a NULL instagram_business_account_id and can only
-- publish to Facebook.
CREATE TABLE meta_pages (
  id bigserial PRIMARY KEY,
  connection_id bigint NOT NULL REFERENCES meta_connections(id) ON DELETE CASCADE,
  page_id text NOT NULL,
  name text NOT NULL,
  encrypted_page_token text NOT NULL,
  instagram_business_account_id text,
  tasks text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','needs_reconnect')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, page_id)
);
CREATE INDEX meta_pages_connection ON meta_pages(connection_id);

-- One target per business: publish to the linked Instagram account or to the
-- Facebook Page. Deleting the Page (reconnect) or the business removes the choice.
CREATE TABLE business_meta_targets (
  business_id bigint PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  meta_page_id bigint NOT NULL REFERENCES meta_pages(id) ON DELETE CASCADE,
  target text NOT NULL CHECK (target IN ('instagram','facebook')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX business_meta_targets_page ON business_meta_targets(meta_page_id);
