// Per-repo tick lock + chat "typing…" indicator.
//
// Two responsibilities, one row:
//   1. Concurrency guard — only one tick at a time per repo. tryAcquire()
//      returns false if a fresh entry exists (lock held); release() drops
//      the row when the tick is done. Stale-but-not-expired locks are
//      respected; expired ones are reclaimed.
//   2. Surfacing — the admin chat polls `getActiveTick()` to decide
//      whether to render the persona's "thinking" bubble.
//
// PRIMARY KEY on repo_id makes "one row at most" structurally true. We
// handle SQLite's ON CONFLICT in the acquire path so two callers racing
// to start a tick get clean true/false answers, no exception throws.

import type { Db } from "../storage/db.js";

export type ActiveTick = {
  repoId: number;
  startedAt: string;
  holderPid: number;
  reason: string;
  ttlS: number;
};

const DEFAULT_TTL_S = 300;

type Row = {
  repo_id: number;
  started_at: string;
  holder_pid: number;
  reason: string;
  ttl_s: number;
};

function rowToActive(row: Row): ActiveTick {
  return {
    repoId: row.repo_id,
    startedAt: row.started_at,
    holderPid: row.holder_pid,
    reason: row.reason,
    ttlS: row.ttl_s,
  };
}

// Returns the active row only if it's still within ttl. Anything older
// is treated as a crashed tick — neither shown to the user nor honoured
// as a lock.
export function getActiveTick(db: Db, repoId: number): ActiveTick | null {
  const row = db
    .prepare(
      `SELECT repo_id, started_at, holder_pid, reason, ttl_s
       FROM director_active_ticks
       WHERE repo_id = ?
         AND datetime(started_at, '+' || ttl_s || ' seconds') > datetime('now')`,
    )
    .get(repoId) as Row | undefined;
  return row ? rowToActive(row) : null;
}

// Try to acquire the lock. Returns true if we now hold it, false if
// someone else does (and their lock is still fresh).
//
// Implementation: INSERT OR IGNORE first; if it didn't insert, check
// freshness and either reclaim a stale slot or bail out.
export function tryAcquireTick(
  db: Db,
  repoId: number,
  reason: string,
  ttlS: number = DEFAULT_TTL_S,
): boolean {
  const inserted = db
    .prepare(
      `INSERT OR IGNORE INTO director_active_ticks (repo_id, holder_pid, reason, ttl_s)
       VALUES (?, ?, ?, ?)`,
    )
    .run(repoId, process.pid, reason, ttlS);
  if (inserted.changes > 0) return true;

  // A row is already there. Reclaim if it's expired.
  const result = db
    .prepare(
      `UPDATE director_active_ticks
       SET started_at = datetime('now'),
           holder_pid = ?,
           reason = ?,
           ttl_s = ?
       WHERE repo_id = ?
         AND datetime(started_at, '+' || ttl_s || ' seconds') <= datetime('now')`,
    )
    .run(process.pid, reason, ttlS, repoId);
  return result.changes > 0;
}

export function releaseTick(db: Db, repoId: number): void {
  db.prepare(`DELETE FROM director_active_ticks WHERE repo_id = ?`).run(repoId);
}

// Convenience: run the body inside the lock. Auto-release on success or
// throw. If the lock can't be acquired, returns null without invoking
// the body — caller decides whether that's "skip" or "retry".
export async function withActiveTick<T>(
  db: Db,
  repoId: number,
  reason: string,
  body: () => Promise<T>,
  ttlS: number = DEFAULT_TTL_S,
): Promise<T | null> {
  if (!tryAcquireTick(db, repoId, reason, ttlS)) return null;
  try {
    return await body();
  } finally {
    releaseTick(db, repoId);
  }
}
