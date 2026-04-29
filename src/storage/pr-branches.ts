import type { Db } from "./db.js";

export interface PrBranchRow {
  id: number;
  task_id: number;
  branch: string;
  base_sha: string | null;
  head_sha: string | null;
  pr_number: number | null;
  pr_url: string | null;
  status: string;
  iterations: number;
  conflict_resolutions_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string | null;
}

export function recordPrBranch(
  db: Db,
  args: {
    taskId: number;
    branch: string;
    baseSha?: string;
    headSha?: string;
    prNumber?: number;
    prUrl?: string;
    status?: string;
    lastError?: string;
  },
): number {
  const result = db
    .prepare(
      `INSERT INTO pr_branches (task_id, branch, base_sha, head_sha, pr_number, pr_url, status, last_error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(task_id, branch) DO UPDATE SET
         base_sha = excluded.base_sha,
         head_sha = excluded.head_sha,
         pr_number = excluded.pr_number,
         pr_url = excluded.pr_url,
         status = excluded.status,
         last_error = excluded.last_error,
         updated_at = datetime('now')`,
    )
    .run(
      args.taskId,
      args.branch,
      args.baseSha ?? null,
      args.headSha ?? null,
      args.prNumber ?? null,
      args.prUrl ?? null,
      args.status ?? "created",
      args.lastError ?? null,
    );
  return Number(result.lastInsertRowid);
}

export function bumpIteration(db: Db, branchId: number): void {
  db.prepare(
    "UPDATE pr_branches SET iterations = iterations + 1, updated_at = datetime('now') WHERE id = ?",
  ).run(branchId);
}

export function bumpConflictResolutions(db: Db, branchId: number): void {
  db.prepare(
    `UPDATE pr_branches
        SET conflict_resolutions_count = conflict_resolutions_count + 1,
            updated_at = datetime('now')
      WHERE id = ?`,
  ).run(branchId);
}

export function updateBranchHeadSha(db: Db, branchId: number, headSha: string): void {
  db.prepare("UPDATE pr_branches SET head_sha = ?, updated_at = datetime('now') WHERE id = ?").run(
    headSha,
    branchId,
  );
}

export function listPrBranches(db: Db, limit = 50): PrBranchRow[] {
  return db
    .prepare("SELECT * FROM pr_branches ORDER BY created_at DESC LIMIT ?")
    .all(limit) as PrBranchRow[];
}

export function getPrBranchByTask(db: Db, taskId: number): PrBranchRow | undefined {
  return db
    .prepare("SELECT * FROM pr_branches WHERE task_id = ? ORDER BY id DESC LIMIT 1")
    .get(taskId) as PrBranchRow | undefined;
}

export interface BlockedPatchRow extends PrBranchRow {
  external_id: string;
  owner: string;
  repo_name: string;
  provider: string;
}

export function listBlockedPatches(db: Db): BlockedPatchRow[] {
  return db
    .prepare(
      `SELECT pb.*, t.external_id, r.owner, r.name AS repo_name, r.provider
       FROM pr_branches pb
       JOIN tasks t ON t.id = pb.task_id
       JOIN repos r ON r.id = t.repo_id
       WHERE pb.status = 'guardrail_blocked'
       ORDER BY pb.updated_at DESC`,
    )
    .all() as BlockedPatchRow[];
}

// Find a pr_branches row by PR number, scoped to a repo. The PR has its own
// task (external_id=PR number), but the row was created against the source
// issue's task — so we join through tasks → repos.
export function getPrBranchByPrNumber(
  db: Db,
  repoId: number,
  prNumber: number,
): PrBranchRow | undefined {
  return db
    .prepare(
      `SELECT pb.*
       FROM pr_branches pb
       JOIN tasks t ON t.id = pb.task_id
       WHERE t.repo_id = ? AND pb.pr_number = ?
       ORDER BY pb.id DESC LIMIT 1`,
    )
    .get(repoId, prNumber) as PrBranchRow | undefined;
}
