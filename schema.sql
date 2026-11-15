-- Re-running this wipes everything. Rules live in the database, not only in app code.
DROP TABLE IF EXISTS idempotency_keys, audit_log, join_requests, team_members, teams, users CASCADE;

CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  skills TEXT[] NOT NULL DEFAULT '{}',
  utc_offset_minutes INT NOT NULL DEFAULT 0
);

CREATE TABLE teams (
  id BIGSERIAL PRIMARY KEY,
  hackathon_id INT NOT NULL,
  name TEXT NOT NULL,
  leader_id BIGINT NOT NULL REFERENCES users(id),
  min_size INT NOT NULL DEFAULT 2,
  max_size INT NOT NULL DEFAULT 4,
  member_count INT NOT NULL DEFAULT 0,
  looking BOOLEAN NOT NULL DEFAULT true,
  needs TEXT[] NOT NULL DEFAULT '{}',
  invite_code TEXT UNIQUE NOT NULL,
  invite_expires TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (min_size >= 1 AND max_size >= min_size AND max_size <= 10),
  CHECK (member_count <= max_size)           -- second safety net behind the row lock
);
CREATE INDEX board_idx ON teams (created_at DESC, id DESC) WHERE looking;

CREATE TABLE team_members (
  team_id BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id),
  hackathon_id INT NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id),
  UNIQUE (hackathon_id, user_id)             -- one team per person, enforced by the DB
);

CREATE TABLE join_requests (
  id BIGSERIAL PRIMARY KEY,
  team_id BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id),
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_pending_request ON join_requests (team_id, user_id) WHERE status = 'pending';

-- No foreign key on team_id: the history must survive a deleted team.
CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  team_id BIGINT,
  actor_id BIGINT,
  action TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}',
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_team_idx ON audit_log (team_id, id);

CREATE TABLE idempotency_keys (
  user_id BIGINT NOT NULL,
  key TEXT NOT NULL,
  response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
