-- Email and password sign-in (#159). Credentials are deliberately separate from
-- auth_users/auth_accounts and keyed by owner. Only a salted scrypt hash is kept;
-- the parameters are stored with each hash so they can be raised later without
-- invalidating existing rows. The row cascades away with the owner.
CREATE TABLE password_credentials (
  owner_id text PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
  email text NOT NULL,
  password_hash text NOT NULL,
  scrypt_n integer NOT NULL CHECK (scrypt_n BETWEEN 2 AND 1048576),
  scrypt_r integer NOT NULL CHECK (scrypt_r BETWEEN 1 AND 32),
  scrypt_p integer NOT NULL CHECK (scrypt_p BETWEEN 1 AND 16),
  salt text NOT NULL,
  key_length integer NOT NULL CHECK (key_length BETWEEN 16 AND 128),
  verified_at timestamptz NOT NULL,
  failed_attempts integer NOT NULL DEFAULT 0,
  failure_window_started_at timestamptz,
  lock_count integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One address can never have two password owners. Addresses are normalised
-- (trimmed, lower-cased) before they reach this table.
CREATE UNIQUE INDEX password_credentials_email ON password_credentials(lower(email));

-- Single-use reset tokens. Only a SHA-256 hash is stored; a newer request
-- supersedes older unconsumed tokens for the same owner.
CREATE TABLE password_reset_tokens (
  id bigserial PRIMARY KEY,
  owner_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  superseded_at timestamptz
);

CREATE INDEX password_reset_tokens_active ON password_reset_tokens(owner_id, created_at DESC)
  WHERE consumed_at IS NULL AND superseded_at IS NULL;

-- DB-backed sign-in and reset throttles so a restart or a second replica does
-- not reset the budget. Buckets are opaque keys such as `signin:ip:<address>`
-- or `reset:email:<sha256 prefix>`; the owner's account counter lives on
-- password_credentials so the account lock and its backoff are atomic with it.
CREATE TABLE password_throttle (
  bucket text PRIMARY KEY,
  failures integer NOT NULL DEFAULT 0,
  window_started_at timestamptz NOT NULL,
  blocked_until timestamptz,
  block_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX password_throttle_blocked ON password_throttle(blocked_until)
  WHERE blocked_until IS NOT NULL;
