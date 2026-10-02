import type { Db } from "../storage/db.js";

export type TaskPriority = "high" | "normal" | "low";
export type TaskStatus = "pending" | "running" | "done" | "error";

export interface QueuedTask {
  id: number;
  repo_id: number;
  external_id: string;
  kind: string;
  status: TaskStatus;
  priority: TaskPriority;
  next_due_at: string | null;
  last_run_at: string | null;
  snapshot_hash: string | null;
  decision_json: string | null;
  last_error: string | null;
  // joined from repos
  provider: string;
  owner: string;
  repo_name: string;
}

const PRIORITY_RANK: Record<TaskPriority, number> = { high: 0, normal: 1, low: 2 };

// Put a task (back) on the queue. A task that is RUNNING right now is not
// flipped to pending: with several drain slots per repo another slot would
// dequeue it and run the same task twice in parallel (two agents pushing to
// one PR branch). Instead it gets `rerun_requested`, and markDone() re-queues
// it once the current run finishes — so feedback that arrived mid-run is
// still acted on, just after the run instead of alongside it.
export function enqueue(
  db: Db,
  taskId: number,
  priority: TaskPriority = "normal",
  nextDueAt: string | null = null,
): void {
  db.prepare(
    `UPDATE tasks SET
       rerun_requested = CASE WHEN status = 'running' THEN 1 ELSE rerun_requested END,
       next_due_at = CASE WHEN status = 'running' THEN next_due_at ELSE ? END,
       priority = ?,
       status = CASE WHEN status = 'running' THEN 'running' ELSE 'pending' END
     WHERE id = ?`,
  ).run(nextDueAt, priority, taskId);
}

// Pop one due task, atomically marking it 'running'. When `opts.repoId`
// is set, only dequeues tasks belonging to that repo — used by the per-repo
// drain workers so a long-running task in one repo doesn't block another.
export function dequeue(
  db: Db,
  now = new Date(),
  opts: { repoId?: number } = {},
): QueuedTask | undefined {
  const baseWhere = "t.status = 'pending' AND (t.next_due_at IS NULL OR t.next_due_at <= ?)";
  const where = opts.repoId !== undefined ? `${baseWhere} AND t.repo_id = ?` : baseWhere;
  const params: unknown[] = [now.toISOString()];
  if (opts.repoId !== undefined) params.push(opts.repoId);
  const tx = db.transaction(() => {
    const row = db
      .prepare(
        `SELECT t.*, r.provider AS provider, r.owner AS owner, r.name AS repo_name
         FROM tasks t
         JOIN repos r ON r.id = t.repo_id
         WHERE ${where}
         ORDER BY
           CASE t.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
           CASE WHEN t.next_due_at IS NULL THEN 0 ELSE 1 END,
           t.next_due_at,
           t.id
         LIMIT 1`,
      )
      .get(...(params as [string])) as QueuedTask | undefined;
    if (!row) return undefined;
    db.prepare("UPDATE tasks SET status = 'running', rerun_requested = 0 WHERE id = ?").run(row.id);
    row.status = "running";
    return row;
  });
  return tx();
}

// Number of due pending tasks for one repo — lets the scheduler start only
// as many parallel drain slots as there is work for.
export function countDue(db: Db, repoId: number, now = new Date()): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM tasks
        WHERE status = 'pending'
          AND (next_due_at IS NULL OR next_due_at <= ?)
          AND repo_id = ?`,
    )
    .get(now.toISOString(), repoId) as { n: number };
  return row.n;
}

// Finish a run. If something asked to re-run the task while it was running
// (see enqueue()), it goes straight back to the head of the queue instead.
export function markDone(db: Db, taskId: number, nextDueAt: string | null): void {
  db.prepare(
    `UPDATE tasks SET
       last_run_at = datetime('now'),
       last_error = NULL,
       next_due_at = CASE WHEN rerun_requested = 1 THEN NULL ELSE ? END,
       priority = CASE WHEN rerun_requested = 1 THEN 'high' ELSE priority END,
       status = CASE WHEN rerun_requested = 1 THEN 'pending' ELSE 'done' END,
       rerun_requested = 0
     WHERE id = ?`,
  ).run(nextDueAt, taskId);
}

// Restore a task to pending without changing next_due_at (used when paused).
export function requeuePaused(db: Db, taskId: number): void {
  db.prepare("UPDATE tasks SET status = 'pending', rerun_requested = 0 WHERE id = ?").run(taskId);
}

// A failed run keeps its retry delay even if a re-run was requested mid-run:
// the delay may be a rate-limit cooldown that must not be skipped.
export function markError(db: Db, taskId: number, error: string, retryInMs = 60 * 60 * 1000): void {
  const next = new Date(Date.now() + retryInMs).toISOString();
  db.prepare(
    "UPDATE tasks SET status = 'pending', last_error = ?, next_due_at = ?, rerun_requested = 0 WHERE id = ?",
  ).run(error, next, taskId);
}

export interface QueueStats {
  pending: number;
  due: number;
  running: number;
  done: number;
  error: number;
}

export function queueStats(db: Db, now = new Date()): QueueStats {
  const counts = db
    .prepare(
      `SELECT
        COUNT(*) FILTER (WHERE status = 'pending') AS pending,
        COUNT(*) FILTER (WHERE status = 'pending' AND (next_due_at IS NULL OR next_due_at <= ?)) AS due,
        COUNT(*) FILTER (WHERE status = 'running') AS running,
        COUNT(*) FILTER (WHERE status = 'done') AS done,
        COUNT(*) FILTER (WHERE last_error IS NOT NULL) AS error
       FROM tasks`,
    )
    .get(now.toISOString()) as QueueStats;
  return counts;
}
