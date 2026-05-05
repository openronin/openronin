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

// All migrations run inside a single IMMEDIATE transaction so:
//   1. Two services starting at the same time (openronin + openronin-director
//      share the data dir) serialize cleanly. SQLite's IMMEDIATE lock makes
//      the second arrival wait until the first commits or rolls back.
//   2. A migration that fails partway through doesn't leave a half-applied
//      schema. The next startup retries from a known-good state.
//
// Production hit case (1) hard during the v14/v15 rollout: each `db.exec`
// auto-commits per-statement, so a CREATE TABLE could succeed while the
// matching INSERT INTO schema_version never ran, leaving sqlite_master and
// schema_version disagreeing. Wrapping with `db.transaction()` makes that
// impossible. better-sqlite3's transaction wrapper uses BEGIN IMMEDIATE
// when called eagerly — exactly what we want.
function applyMigrations(db: Db): void {
  // schema_version itself must exist before the transaction starts so the
  // SELECT MAX inside the body has something to read. This is idempotent
  // and so cheap to do outside the tx.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const tx = db.transaction(() => applyMigrationsInner(db));
  // .immediate() acquires a write lock immediately, blocking any sibling
  // applyMigrations call until we commit or roll back.
  tx.immediate();
}

function applyMigrationsInner(db: Db): void {
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

  // v12 — Director (autonomous PM layer). Adds:
  //   • director_messages   — chat thread (director ↔ user) per repo
  //   • director_decisions  — every decision the director made, with rationale
  //   • director_charter_versions — versioned charter snapshots per repo
  //   • director_budget_state — adaptive budget + failure-streak per repo
  // None of this affects the existing scheduler/lanes; the director runs as a
  // separate systemd unit that shares this DB. See src/director/.
  if (current < 12) {
    db.exec(`
      CREATE TABLE director_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        ts TEXT NOT NULL DEFAULT (datetime('now')),
        role TEXT NOT NULL CHECK (role IN ('director','user','system')),
        type TEXT NOT NULL CHECK (type IN (
          'status','proposal','question','directive','answer','veto','report','tick_log','error'
        )),
        body TEXT NOT NULL,
        metadata TEXT,
        parent_id INTEGER REFERENCES director_messages(id) ON DELETE SET NULL,
        decision_id INTEGER
      );
      CREATE INDEX idx_director_messages_repo_ts ON director_messages(repo_id, ts DESC);

      CREATE TABLE director_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        ts TEXT NOT NULL DEFAULT (datetime('now')),
        decision_type TEXT NOT NULL,
        rationale TEXT NOT NULL,
        charter_version INTEGER,
        state_snapshot TEXT,
        payload TEXT,
        outcome TEXT NOT NULL DEFAULT 'pending',
        outcome_ts TEXT,
        outcome_details TEXT,
        cost_usd REAL NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_director_decisions_repo_ts ON director_decisions(repo_id, ts DESC);
      CREATE INDEX idx_director_decisions_pending ON director_decisions(outcome) WHERE outcome = 'pending';

      CREATE TABLE director_charter_versions (
        repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        charter_yaml TEXT NOT NULL,
        effective_from TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (repo_id, version)
      );

      CREATE TABLE director_budget_state (
        repo_id INTEGER PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
        daily_cap_usd REAL NOT NULL DEFAULT 2.0,
        weekly_cap_usd REAL NOT NULL DEFAULT 10.0,
        spent_today_usd REAL NOT NULL DEFAULT 0,
        spent_week_usd REAL NOT NULL DEFAULT 0,
        spent_today_think_usd REAL NOT NULL DEFAULT 0,
        failure_streak INTEGER NOT NULL DEFAULT 0,
        last_tick_at TEXT,
        last_reset_day TEXT,
        paused INTEGER NOT NULL DEFAULT 0,
        pause_reason TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.prepare(
      "INSERT INTO schema_version (version, applied_at) VALUES (12, datetime('now'))",
    ).run();
  }

  // v13 — Director adaptive-budget retrospective. Each adjustment to a
  // repo's daily/weekly cap is logged here so the operator sees the
  // trajectory in the admin UI and the LLM can read it back as part of
  // state on subsequent ticks.
  if (current < 13) {
    db.exec(`
      CREATE TABLE director_budget_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        ts TEXT NOT NULL DEFAULT (datetime('now')),
        old_daily_cap REAL NOT NULL,
        new_daily_cap REAL NOT NULL,
        old_weekly_cap REAL NOT NULL,
        new_weekly_cap REAL NOT NULL,
        success_rate REAL,
        sample_size INTEGER,
        reason TEXT NOT NULL
      );
      CREATE INDEX idx_director_budget_history_repo_ts
        ON director_budget_history(repo_id, ts DESC);
    `);
    db.prepare(
      "INSERT INTO schema_version (version, applied_at) VALUES (13, datetime('now'))",
    ).run();
  }

  // v14 — Director per-repo lock + in-flight indicator. Doubles as the
  // backing store for the chat "typing…" indicator: while a row exists for
  // a repo, the admin UI shows the persona is thinking. Auto-stale via
  // ttl_s so a crashed tick doesn't wedge the lock forever. PRIMARY KEY
  // on repo_id ⇒ a single active tick per repo is structurally enforced.
  if (current < 14) {
    db.exec(`
      CREATE TABLE director_active_ticks (
        repo_id INTEGER PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        holder_pid INTEGER NOT NULL,
        reason TEXT NOT NULL,
        ttl_s INTEGER NOT NULL DEFAULT 300
      );
    `);
    db.prepare(
      "INSERT INTO schema_version (version, applied_at) VALUES (14, datetime('now'))",
    ).run();
  }

  // v15 — Director decision dedup. payload_hash is a 16-char SHA-256
  // prefix over a normalised canonical form of (decision_type, payload).
  // recordDecision computes it on insert; an indexed lookup on
  // (repo_id, payload_hash, outcome, ts) implements the 7-day duplicate
  // gate with an actual index instead of a table scan.
  if (current < 15) {
    db.exec(`
      ALTER TABLE director_decisions ADD COLUMN payload_hash TEXT;
      CREATE INDEX idx_director_decisions_dedup
        ON director_decisions(repo_id, payload_hash, outcome, ts);
    `);
    db.prepare(
      "INSERT INTO schema_version (version, applied_at) VALUES (15, datetime('now'))",
    ).run();
  }

  // v16 — Daily digest dedup. Records the local-TZ date of the most
  // recent digest run so we fire at most one per calendar day per repo,
  // independent of how often the service loop wakes up. Stored as plain
  // ISO date (YYYY-MM-DD) in the configured digest timezone — the
  // service-loop predicate compares strings, no time math.
  if (current < 16) {
    db.exec(`ALTER TABLE director_budget_state ADD COLUMN last_digest_date TEXT`);
    db.prepare(
      "INSERT INTO schema_version (version, applied_at) VALUES (16, datetime('now'))",
    ).run();
  }

  // v17 — Standing operator notes. Long-term memory of "this is how I
  // want you to behave" that survives the recent_chat windowing. The
  // director can emit a `remember_preference` decision; the executor
  // inserts here. Operator can edit/delete via /admin/director.
  if (current < 17) {
    db.exec(`
      CREATE TABLE director_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        ts TEXT NOT NULL DEFAULT (datetime('now')),
        kind TEXT NOT NULL,
        body TEXT NOT NULL,
        source_message_id INTEGER REFERENCES director_messages(id) ON DELETE SET NULL
      );
      CREATE INDEX idx_director_notes_repo_ts ON director_notes(repo_id, ts DESC);
    `);
    db.prepare(
      "INSERT INTO schema_version (version, applied_at) VALUES (17, datetime('now'))",
    ).run();
  }

  // v19 — Outcome follow-up. After a director-emitted create_issue
  // (etc.) lands as `executed`, we want to look at the resulting issue/PR
  // a day, three days, a week later: did it get closed without resolution?
  // Was a PR merged for it? Was that PR reverted? Each observation is
  // appended as a row here (multiple rows per decision is normal — one
  // per sweep). Feeds the per-decision trace UI; doesn't yet change the
  // adaptive-budget retrospective (that uses immediate decision outcomes).
  if (current < 19) {
    db.exec(`
      CREATE TABLE director_outcome_followups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        decision_id INTEGER NOT NULL REFERENCES director_decisions(id) ON DELETE CASCADE,
        observed_at TEXT NOT NULL DEFAULT (datetime('now')),
        kind TEXT NOT NULL,
        detail TEXT,
        ref_number INTEGER,
        ref_url TEXT
      );
      CREATE INDEX idx_director_outcome_followups_decision
        ON director_outcome_followups(decision_id, observed_at DESC);
    `);
    db.prepare(
      "INSERT INTO schema_version (version, applied_at) VALUES (19, datetime('now'))",
    ).run();
  }

  // v18 — Per-decision LLM trace. Adds prompt_text + response_text + a
  // pair of token/duration columns directly on director_decisions so the
  // /admin/director/<slug>/decisions/<id> page can show the full prompt
  // and raw LLM output without a separate table. Capped at 32 KB each
  // by the writer (truncated with a marker) so a runaway prompt can't
  // bloat the row.
  if (current < 18) {
    db.exec(`
      ALTER TABLE director_decisions ADD COLUMN prompt_text TEXT;
      ALTER TABLE director_decisions ADD COLUMN response_text TEXT;
      ALTER TABLE director_decisions ADD COLUMN tokens_in INTEGER;
      ALTER TABLE director_decisions ADD COLUMN tokens_out INTEGER;
      ALTER TABLE director_decisions ADD COLUMN duration_ms INTEGER;
      ALTER TABLE director_decisions ADD COLUMN engine_id TEXT;
      ALTER TABLE director_decisions ADD COLUMN model TEXT;
    `);
    db.prepare(
      "INSERT INTO schema_version (version, applied_at) VALUES (18, datetime('now'))",
    ).run();
  }
}
