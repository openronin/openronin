import type { Db } from "./db.js";

export interface TaskRow {
  id: number;
  repo_id: number;
  external_id: string;
  kind: string;
  status: string;
  snapshot_hash: string | null;
  last_run_at: string | null;
  decision_json: string | null;
}

export function getRepoId(
  db: Db,
  ref: { provider: string; owner: string; name: string },
): number | undefined {
  const row = db
    .prepare("SELECT id FROM repos WHERE provider = ? AND owner = ? AND name = ?")
    .get(ref.provider, ref.owner, ref.name) as { id: number } | undefined;
  return row?.id;
}

export function ensureRepo(db: Db, ref: { provider: string; owner: string; name: string }): number {
  const existing = getRepoId(db, ref);
  if (existing !== undefined) return existing;
  const result = db
    .prepare(
      "INSERT INTO repos (provider, owner, name, watched, config_json) VALUES (?, ?, ?, 0, '{}')",
    )
    .run(ref.provider, ref.owner, ref.name);
  return Number(result.lastInsertRowid);
}

export function upsertTask(db: Db, repoId: number, externalId: string, kind: string): number {
  const existing = db
    .prepare("SELECT id FROM tasks WHERE repo_id = ? AND external_id = ?")
    .get(repoId, externalId) as { id: number } | undefined;
  if (existing) return existing.id;
  const result = db
    .prepare("INSERT INTO tasks (repo_id, external_id, kind) VALUES (?, ?, ?)")
    .run(repoId, externalId, kind);
  return Number(result.lastInsertRowid);
}

export function upsertJiraTask(db: Db, repoId: number, externalId: string): number {
  const existing = db
    .prepare("SELECT id FROM tasks WHERE repo_id = ? AND external_id = ?")
    .get(repoId, externalId) as { id: number } | undefined;
  if (existing) return existing.id;
  const result = db
    .prepare(
      "INSERT INTO tasks (repo_id, external_id, kind, source) VALUES (?, ?, 'issue', 'jira')",
    )
    .run(repoId, externalId);
  return Number(result.lastInsertRowid);
}

export interface JiraTaskRow {
  id: number;
  repo_id: number;
  external_id: string;
  status: string;
  priority: string;
  last_run_at: string | null;
  last_error: string | null;
  provider: string;
  owner: string;
  repo_name: string;
}

export function listPendingJiraTasks(db: Db, limit = 50): JiraTaskRow[] {
  return db
    .prepare(
      `SELECT t.id, t.repo_id, t.external_id, t.status, t.priority, t.last_run_at, t.last_error,
              r.provider, r.owner, r.name AS repo_name
       FROM tasks t JOIN repos r ON r.id = t.repo_id
       WHERE t.source = 'jira' AND t.status NOT IN ('done')
       ORDER BY t.id DESC LIMIT ?`,
    )
    .all(limit) as JiraTaskRow[];
}

export function upsertTodoistTask(db: Db, repoId: number, externalId: string): number {
  const existing = db
    .prepare("SELECT id FROM tasks WHERE repo_id = ? AND external_id = ?")
    .get(repoId, externalId) as { id: number } | undefined;
  if (existing) return existing.id;
  const result = db
    .prepare(
      "INSERT INTO tasks (repo_id, external_id, kind, source) VALUES (?, ?, 'issue', 'todoist')",
    )
    .run(repoId, externalId);
  return Number(result.lastInsertRowid);
}

export interface TodoistTaskRow {
  id: number;
  repo_id: number;
  external_id: string;
  status: string;
  priority: string;
  last_run_at: string | null;
  last_error: string | null;
  provider: string;
  owner: string;
  repo_name: string;
}

export function listPendingTodoistTasks(db: Db, limit = 50): TodoistTaskRow[] {
  return db
    .prepare(
      `SELECT t.id, t.repo_id, t.external_id, t.status, t.priority, t.last_run_at, t.last_error,
              r.provider, r.owner, r.name AS repo_name
       FROM tasks t JOIN repos r ON r.id = t.repo_id
       WHERE t.source = 'todoist' AND t.status NOT IN ('done')
       ORDER BY t.id DESC LIMIT ?`,
    )
    .all(limit) as TodoistTaskRow[];
}

export function recordTaskDecision(
  db: Db,
  taskId: number,
  snapshotHash: string,
  decisionJson: string,
): void {
  db.prepare(
    "UPDATE tasks SET snapshot_hash = ?, last_run_at = datetime('now'), decision_json = ? WHERE id = ?",
  ).run(snapshotHash, decisionJson, taskId);
}
