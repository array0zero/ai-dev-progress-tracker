PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  local_path TEXT NOT NULL UNIQUE,
  repo_node_id TEXT NOT NULL UNIQUE,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'local_missing')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE commits (
  project_id TEXT NOT NULL,
  sha TEXT NOT NULL,
  parent_sha TEXT,
  message TEXT NOT NULL,
  authored_at TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  PRIMARY KEY(project_id, sha),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('commit', 'issue', 'pull_request')),
  external_key TEXT NOT NULL,
  source_version TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  captured_at TEXT NOT NULL,
  UNIQUE(project_id, kind, external_key, source_version),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE generation_runs (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('generation', 'recovery')),
  trigger TEXT NOT NULL CHECK(trigger IN ('post_commit', 'registration', 'manual_recovery')),
  status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'succeeded', 'partial', 'unrecoverable', 'failed')),
  detected_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  ai_provider TEXT NOT NULL DEFAULT 'codex_cli',
  ai_cli_version TEXT,
  ai_model TEXT NOT NULL DEFAULT 'gpt-5.6-terra',
  error_code TEXT,
  error_message TEXT,
  FOREIGN KEY(project_id, commit_sha) REFERENCES commits(project_id, sha) ON DELETE CASCADE
) STRICT;

CREATE TABLE run_evidence (
  run_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  PRIMARY KEY(run_id, evidence_id),
  FOREIGN KEY(run_id) REFERENCES generation_runs(id) ON DELETE CASCADE,
  FOREIGN KEY(evidence_id) REFERENCES evidence(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE progress_snapshots (
  id TEXT PRIMARY KEY,
  generation_run_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  recovery_status TEXT NOT NULL CHECK(recovery_status IN ('complete', 'partial', 'unrecoverable')),
  current_position_json TEXT NOT NULL CHECK(json_valid(current_position_json)),
  completed_items_json TEXT NOT NULL CHECK(json_valid(completed_items_json)),
  next_actions_json TEXT NOT NULL CHECK(json_valid(next_actions_json)),
  decisions_json TEXT NOT NULL CHECK(json_valid(decisions_json)),
  created_at TEXT NOT NULL,
  FOREIGN KEY(generation_run_id) REFERENCES generation_runs(id) ON DELETE CASCADE,
  FOREIGN KEY(project_id, commit_sha) REFERENCES commits(project_id, sha) ON DELETE CASCADE
) STRICT;

CREATE TABLE backup_runs (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL CHECK(trigger IN ('registration', 'pre_push', 'manual')),
  project_id TEXT,
  source_commit_sha TEXT,
  status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'succeeded', 'failed')),
  backup_repo TEXT NOT NULL,
  backup_commit_sha TEXT,
  queued_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  error_code TEXT,
  error_message TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL
) STRICT;

CREATE TABLE worker_leases (
  scope TEXT PRIMARY KEY,
  owner_token TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_generation_runs_project_status
  ON generation_runs(project_id, status, detected_at DESC);

CREATE INDEX idx_progress_snapshots_project_created
  ON progress_snapshots(project_id, created_at DESC);

CREATE INDEX idx_evidence_project_kind
  ON evidence(project_id, kind, captured_at DESC);

CREATE INDEX idx_backup_runs_status_queued
  ON backup_runs(status, queued_at DESC);

INSERT INTO schema_migrations(version, applied_at)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
