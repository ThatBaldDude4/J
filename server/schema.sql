CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  name VARCHAR(60) NOT NULL,
  email VARCHAR(254) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash CHAR(64) PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  csrf_token CHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS reservations (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  experience_id TEXT NOT NULL,
  day DATE NOT NULL,
  time CHAR(5) NOT NULL,
  guests SMALLINT NOT NULL CHECK (guests BETWEEN 1 AND 4),
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS reservations_slot ON reservations(day, time, status);
CREATE INDEX IF NOT EXISTS reservations_user ON reservations(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_slot_per_user ON reservations(user_id, day, time) WHERE status = 'confirmed';
CREATE TABLE IF NOT EXISTS rate_limits (
  key CHAR(64) PRIMARY KEY,
  hits INTEGER NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
