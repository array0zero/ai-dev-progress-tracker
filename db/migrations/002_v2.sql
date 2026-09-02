PRAGMA foreign_keys = ON;

ALTER TABLE projects
  ADD COLUMN summary TEXT NOT NULL DEFAULT ''
  CHECK(length(summary) <= 240);

ALTER TABLE projects
  ADD COLUMN registration_source TEXT NOT NULL DEFAULT 'manual'
  CHECK(registration_source IN ('manual', 'codex', 'claude'));

ALTER TABLE projects
  ADD COLUMN review_required INTEGER NOT NULL DEFAULT 0
  CHECK(review_required IN (0, 1));

ALTER TABLE projects
  ADD COLUMN review_required_at TEXT;

UPDATE projects
SET summary = name
WHERE summary = '';

CREATE TABLE registration_candidates (
  id TEXT PRIMARY KEY,
  local_path TEXT NOT NULL UNIQUE,
  agent TEXT NOT NULL CHECK(agent IN ('codex', 'claude')),
  status TEXT NOT NULL
    CHECK(status IN ('detected', 'prompted', 'declined', 'registering', 'failed', 'registered')),
  suggested_name TEXT NOT NULL CHECK(length(suggested_name) BETWEEN 1 AND 120),
  detected_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  prompted_at TEXT,
  decision_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK(attempt_count BETWEEN 0 AND 2),
  last_error_code TEXT CHECK(last_error_code IS NULL OR length(last_error_code) <= 64),
  last_error_message TEXT CHECK(last_error_message IS NULL OR length(last_error_message) <= 500),
  project_id TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL
) STRICT;

CREATE INDEX idx_registration_candidates_status_seen
  ON registration_candidates(status, last_seen_at DESC);

INSERT INTO schema_migrations(version, applied_at)
VALUES (2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
