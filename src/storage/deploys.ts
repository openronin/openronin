import type { Db } from "./db.js";

export interface DeployRow {
  id: number;
  repo_id: number;
  sha: string;
  branch: string;
  triggered_by: string;
  status: string;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export function createDeploy(
  db: Db,
  args: { repoId: number; sha: string; branch: string; triggeredBy: string },
): number {
  const result = db
    .prepare("INSERT INTO deploys (repo_id, sha, branch, triggered_by) VALUES (?, ?, ?, ?)")
    .run(args.repoId, args.sha, args.branch, args.triggeredBy);
  return Number(result.lastInsertRowid);
}

export function finishDeploy(
  db: Db,
  id: number,
  args: { status: "ok" | "error"; error?: string },
): void {
  db.prepare(
    "UPDATE deploys SET status = ?, error = ?, finished_at = datetime('now') WHERE id = ?",
  ).run(args.status, args.error ?? null, id);
}

export function listRecentDeploys(db: Db, limit = 10, repoId?: number): DeployRow[] {
  if (repoId !== undefined) {
    return db
      .prepare("SELECT * FROM deploys WHERE repo_id = ? ORDER BY started_at DESC LIMIT ?")
      .all(repoId, limit) as DeployRow[];
  }
  return db
    .prepare("SELECT * FROM deploys ORDER BY started_at DESC LIMIT ?")
    .all(limit) as DeployRow[];
}

export function getLastSuccessfulDeploy(db: Db, repoId: number): DeployRow | undefined {
  return db
    .prepare(
      "SELECT * FROM deploys WHERE repo_id = ? AND status = 'ok' ORDER BY started_at DESC LIMIT 1",
    )
    .get(repoId) as DeployRow | undefined;
}
