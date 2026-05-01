// Project-state snapshot for the Director's planning prompt.
//
// We don't dump everything in the DB — we curate. The LLM gets a focused
// view of "what's happening on this repo right now" so its decisions are
// grounded in reality, not hallucinated.
//
// Kept lean on purpose: a 6-hour cadence × 1 charter × 1 prompt at maybe
// 30k input tokens needs to stay under the think budget ($1/day default).

import type { Db } from "../storage/db.js";

export type StateSnapshot = {
  repo: { id: number; owner: string; name: string };
  capturedAt: string;
  // Counts give the LLM a scale, lists give it concrete handles.
  counts: {
    openIssues: number;
    openPrs: number;
    pendingTasks: number;
    recent24hRuns: number;
    recent24hCostUsd: number;
    recent24hMerges: number;
  };
  recentRuns: RunSummary[];
  recentMerges: DeploySummary[];
  openPrs: PrSummary[];
  recentChat: MessageSummary[];
  recentDecisions: DecisionSummary[];
  pendingDecisionCount: number;
};

export type RunSummary = {
  ts: string;
  lane: string;
  engine: string;
  status: string;
  costUsd: number;
};

export type DeploySummary = {
  ts: string;
  sha: string;
  status: string;
};

export type PrSummary = {
  prNumber: number;
  status: string;
  iterations: number;
  branch: string;
  updatedAt: string | null;
};

export type MessageSummary = {
  ts: string;
  role: string;
  type: string;
  body: string;
};

export type DecisionSummary = {
  ts: string;
  type: string;
  outcome: string;
  rationale: string;
};

export function captureStateSnapshot(
  db: Db,
  repoId: number,
  owner: string,
  name: string,
): StateSnapshot {
  const counts = {
    openIssues: scalar<number>(
      db,
      `SELECT COUNT(*) AS n FROM tasks WHERE repo_id = ? AND kind = 'issue' AND status NOT IN ('done','error')`,
      [repoId],
    ),
    openPrs: scalar<number>(
      db,
      `SELECT COUNT(DISTINCT pb.id) AS n FROM pr_branches pb
       JOIN tasks t ON t.id = pb.task_id
       WHERE t.repo_id = ? AND pb.status IN ('created','open')`,
      [repoId],
    ),
    pendingTasks: scalar<number>(
      db,
      `SELECT COUNT(*) AS n FROM tasks WHERE repo_id = ? AND status = 'pending'`,
      [repoId],
    ),
    recent24hRuns: scalar<number>(
      db,
      `SELECT COUNT(*) AS n FROM runs r
       JOIN tasks t ON t.id = r.task_id
       WHERE t.repo_id = ? AND r.started_at > datetime('now','-24 hours')`,
      [repoId],
    ),
    recent24hCostUsd: scalar<number>(
      db,
      `SELECT COALESCE(SUM(r.cost_usd), 0) AS n FROM runs r
       JOIN tasks t ON t.id = r.task_id
       WHERE t.repo_id = ? AND r.started_at > datetime('now','-24 hours')`,
      [repoId],
    ),
    recent24hMerges: scalar<number>(
      db,
      `SELECT COUNT(*) AS n FROM deploys
       WHERE repo_id = ? AND status = 'ok' AND started_at > datetime('now','-24 hours')`,
      [repoId],
    ),
  };

  const recentRuns = (
    db
      .prepare(
        `SELECT r.started_at AS ts, r.lane, r.engine, r.status, COALESCE(r.cost_usd,0) AS cost_usd
         FROM runs r JOIN tasks t ON t.id = r.task_id
         WHERE t.repo_id = ?
         ORDER BY r.id DESC LIMIT 15`,
      )
      .all(repoId) as {
      ts: string;
      lane: string;
      engine: string;
      status: string;
      cost_usd: number;
    }[]
  ).map((r) => ({
    ts: r.ts,
    lane: r.lane,
    engine: r.engine,
    status: r.status,
    costUsd: r.cost_usd,
  }));

  const recentMerges = (
    db
      .prepare(
        `SELECT started_at AS ts, sha, status FROM deploys
         WHERE repo_id = ? AND status = 'ok'
         ORDER BY id DESC LIMIT 5`,
      )
      .all(repoId) as { ts: string; sha: string; status: string }[]
  ).map((d) => ({ ts: d.ts, sha: d.sha.slice(0, 7), status: d.status }));

  const openPrs = db
    .prepare(
      `SELECT pb.pr_number AS prNumber, pb.status, pb.iterations, pb.branch, pb.updated_at AS updatedAt
         FROM pr_branches pb JOIN tasks t ON t.id = pb.task_id
         WHERE t.repo_id = ? AND pb.status IN ('created','open')
         ORDER BY pb.updated_at DESC NULLS LAST LIMIT 10`,
    )
    .all(repoId) as PrSummary[];

  const recentChat = (
    db
      .prepare(
        `SELECT ts, role, type, substr(body,1,400) AS body
         FROM director_messages
         WHERE repo_id = ?
         ORDER BY id DESC LIMIT 25`,
      )
      .all(repoId) as { ts: string; role: string; type: string; body: string }[]
  ).reverse();

  const recentDecisions = (
    db
      .prepare(
        `SELECT ts, decision_type AS type, outcome, substr(rationale,1,300) AS rationale
         FROM director_decisions
         WHERE repo_id = ?
         ORDER BY id DESC LIMIT 15`,
      )
      .all(repoId) as { ts: string; type: string; outcome: string; rationale: string }[]
  ).reverse();

  const pendingDecisionCount = scalar<number>(
    db,
    `SELECT COUNT(*) AS n FROM director_decisions WHERE repo_id = ? AND outcome = 'pending'`,
    [repoId],
  );

  return {
    repo: { id: repoId, owner, name },
    capturedAt: new Date().toISOString(),
    counts,
    recentRuns,
    recentMerges,
    openPrs,
    recentChat,
    recentDecisions,
    pendingDecisionCount,
  };
}

function scalar<T>(db: Db, sql: string, params: unknown[]): T {
  const row = db.prepare(sql).get(...(params as never[])) as { n: T } | undefined;
  return (row?.n ?? 0) as T;
}
