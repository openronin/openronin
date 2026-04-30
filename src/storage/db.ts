import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

export type Db = Database.Database;

export function initDb(dataDir: string): Db {
  const dbDir = resolve(dataDir, "db");
  mkdirSync(dbDir, { recursive: true });
  const path = resolve(dbDir, "openronin.db");
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  applyMigrations(db);
  return db;
}

function applyMigrations(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const current =
    (db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null }).v ??
    0;

  if (current < 1) {
    db.exec(`
      CREATE TABLE repos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        watched INTEGER NOT NULL DEFAULT 1,
        config_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(provider, owner, name)
      );
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        external_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        snapshot_hash TEXT,
        last_run_at TEXT,
        decision_json TEXT,
        UNIQUE(repo_id, external_id)
      );
      CREATE TABLE runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        lane TEXT NOT NULL,
        engine TEXT NOT NULL,
        model TEXT,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT,
        tokens_in INTEGER,
        tokens_out INTEGER,
        cost_usd REAL,
        status TEXT NOT NULL DEFAULT 'running',
        error TEXT,
        log_path TEXT
      );
      CREATE INDEX idx_tasks_repo_status ON tasks(repo_id, status);
      CREATE INDEX idx_runs_task ON runs(task_id);
    `);
    db.prepare(
      "INSERT INTO schema_version (version, applied_at) VALUES (1, datetime('now'))",
    ).run();
  }

  if (current < 2) {
    db.exec(`
      ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal';
      ALTER TABLE tasks ADD COLUMN next_due_at TEXT;
      ALTER TABLE tasks ADD COLUMN last_error TEXT;
      CREATE INDEX idx_tasks_due ON tasks(status, next_due_at);
      CREATE TABLE webhook_secrets (
        repo_id INTEGER PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
        secret TEXT NOT NULL,
        webhook_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.prepare(
      "INSERT INTO schema_version (version, applied_at) VALUES (2, datetime('now'))",
    ).run();
  }

  if (current < 3) {
    db.exec(`
      CREATE TABLE pr_branches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        branch TEXT NOT NULL,
        base_sha TEXT,
        head_sha TEXT,
        pr_number INTEGER,
        pr_url TEXT,
        status TEXT NOT NULL DEFAULT 'created',
        iterations INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT
      );
      CREATE UNIQUE INDEX idx_pr_branches_task_branch ON pr_branches(task_id, branch);
    `);
    db.prepare(
      "INSERT INTO schema_version (version, applied_at) VALUES (3, datetime('now'))",
    ).run();
  }

  if (current < 4) {
    db.exec(`
      CREATE TABLE deploys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        sha TEXT NOT NULL,
        branch TEXT NOT NULL,
        triggered_by TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        error TEXT,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT
      );
      CREATE INDEX idx_deploys_repo ON deploys(repo_id, started_at);
      ALTER TABLE tasks ADD COLUMN source TEXT NOT NULL DEFAULT 'vcs';
      CREATE INDEX idx_tasks_source ON tasks(source, status);
    `);
    db.prepare(
      "INSERT INTO schema_version (version, applied_at) VALUES (4, datetime('now'))",
    ).run();
  }

  if (current < 5) {
    db.exec(`ALTER TABLE runs ADD COLUMN prompt_log_path TEXT;`);
    db.prepare(
      "INSERT INTO schema_version (version, applied_at) VALUES (5, datetime('now'))",
    ).run();
  }

  if (current < 6) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at);
      CREATE INDEX IF NOT EXISTS idx_runs_lane ON runs(lane);
    `);
    db.prepare(
      "INSERT INTO schema_version (version, applied_at) VALUES (6, datetime('now'))",
    ).run();
  }

  if (current < 7) {
    db.exec(
      `ALTER TABLE pr_branches ADD COLUMN conflict_resolutions_count INTEGER NOT NULL DEFAULT 0;`,
    );
    db.prepare(
      "INSERT INTO schema_version (version, applied_at) VALUES (7, datetime('now'))",
    ).run();
  }

  if (current < 8) {
    db.exec(`ALTER TABLE pr_branches ADD COLUMN last_error TEXT;`);
    db.prepare(
      "INSERT INTO schema_version (version, applied_at) VALUES (8, datetime('now'))",
    ).run();
  }

  // v9 — repair migration. PR #26 retroactively edited the v4 block to also
  // create the `deploys` table; databases that had already passed v4 with
  // just the original `source` column never got `deploys`. Recreate it
  // idempotently here so old and new installs converge.
  if (current < 9) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS deploys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        sha TEXT NOT NULL,
        branch TEXT NOT NULL,
        triggered_by TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        error TEXT,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_deploys_repo ON deploys(repo_id, started_at);
    `);
    db.prepare(
      "INSERT INTO schema_version (version, applied_at) VALUES (9, datetime('now'))",
    ).run();
  }

  if (current < 10) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS admin_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        actor TEXT NOT NULL DEFAULT 'admin',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit(created_at);
    `);
    db.prepare(
      "INSERT INTO schema_version (version, applied_at) VALUES (10, datetime('now'))",
    ).run();
  }

  if (current < 11) {
    // Push done tasks that are overdue into the cold bucket so the reconciler
    // stops re-triaging them immediately. New code prevents this state going forward
    // by comparing snapshot_hash before enqueueing.
    db.exec(`
      UPDATE tasks
      SET next_due_at = datetime('now', '+24 hours')
      WHERE status = 'done'
        AND snapshot_hash IS NOT NULL
        AND next_due_at IS NOT NULL
        AND next_due_at < datetime('now', '+12 hours');
    `);
    db.prepare(
      "INSERT INTO schema_version (version, applied_at) VALUES (11, datetime('now'))",
    ).run();
  }
}
