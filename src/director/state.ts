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
  // Things the director should look at FIRST. Populated by the stale
  // watchdog — PRs without movement, issues stuck in awaiting-answer,
  // recent failed deploys. The prompt template renders these in their
  // own section so the LLM addresses them before charter-priority work.
  attentionItems: AttentionItem[];
};

export type AttentionItem = {
  kind:
    | "stale_pr"
    | "stale_awaiting_answer"
    | "recent_deploy_failed"
    | "failure_streak_high"
    | "high_pending_proposals";
  ref: string; // PR/issue number, "deploy <sha>" or "global"
  detail: string;
  ageHours?: number;
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
    attentionItems: collectAttentionItems(db, repoId),
  };
}

// ── Stale watchdog ───────────────────────────────────────────────────────
// Surfaces "things the director should look at first" before charter-driven
// planning. Cheap aggregate queries; we cap each list so the prompt doesn't
// balloon when a project is genuinely on fire (the LLM would just get lost
// in 50 stale items — show it the worst 5 per category).

const STALE_PR_HOURS = 24;
const STALE_AWAITING_ANSWER_HOURS = 48;
const FAILED_DEPLOY_LOOKBACK_HOURS = 48;
const FAILURE_STREAK_ATTENTION_THRESHOLD = 2;
const PENDING_PROPOSAL_ATTENTION_THRESHOLD = 5;

function collectAttentionItems(db: Db, repoId: number): AttentionItem[] {
  const items: AttentionItem[] = [];

  // 1. Open PRs that haven't moved in STALE_PR_HOURS.
  const stalePrs = db
    .prepare(
      `SELECT pb.pr_number AS prNumber, pb.branch, pb.updated_at AS updatedAt,
              ROUND((julianday('now') - julianday(pb.updated_at)) * 24.0, 1) AS ageHours
       FROM pr_branches pb JOIN tasks t ON t.id = pb.task_id
       WHERE t.repo_id = ?
         AND pb.status IN ('created','open')
         AND pb.updated_at IS NOT NULL
         AND pb.updated_at < datetime('now', '-${STALE_PR_HOURS} hours')
       ORDER BY pb.updated_at ASC LIMIT 5`,
    )
    .all(repoId) as { prNumber: number; branch: string; ageHours: number }[];
  for (const p of stalePrs) {
    items.push({
      kind: "stale_pr",
      ref: `#${p.prNumber}`,
      detail: `PR #${p.prNumber} (${p.branch}) untouched for ${p.ageHours}h`,
      ageHours: p.ageHours,
    });
  }

  // 2. Issues sitting in awaiting-answer for too long (label-driven —
  //    pulled from tasks.decision_json which carries the label set
  //    snapshot from the analyzer). Heuristic: any task last_run_at older
  //    than the threshold whose decision_json mentions awaiting-answer.
  const stuckAwaiting = db
    .prepare(
      `SELECT external_id AS issueNumber,
              ROUND((julianday('now') - julianday(last_run_at)) * 24.0, 1) AS ageHours
       FROM tasks
       WHERE repo_id = ?
         AND kind = 'issue'
         AND last_run_at IS NOT NULL
         AND last_run_at < datetime('now', '-${STALE_AWAITING_ANSWER_HOURS} hours')
         AND decision_json LIKE '%awaiting-answer%'
       ORDER BY last_run_at ASC LIMIT 5`,
    )
    .all(repoId) as { issueNumber: string; ageHours: number }[];
  for (const a of stuckAwaiting) {
    items.push({
      kind: "stale_awaiting_answer",
      ref: `#${a.issueNumber}`,
      detail: `Issue #${a.issueNumber} stuck in awaiting-answer for ${a.ageHours}h — likely needs a nudge`,
      ageHours: a.ageHours,
    });
  }

  // 3. Recent failed deploys.
  const failedDeploys = db
    .prepare(
      `SELECT sha, started_at AS ts, status
       FROM deploys
       WHERE repo_id = ?
         AND status NOT IN ('ok','running')
         AND started_at > datetime('now', '-${FAILED_DEPLOY_LOOKBACK_HOURS} hours')
       ORDER BY id DESC LIMIT 3`,
    )
    .all(repoId) as { sha: string; ts: string; status: string }[];
  for (const d of failedDeploys) {
    items.push({
      kind: "recent_deploy_failed",
      ref: `deploy ${d.sha.slice(0, 7)}`,
      detail: `Deploy ${d.sha.slice(0, 7)} failed at ${d.ts} (${d.status})`,
    });
  }

  // 4. Failure streak — director's own bumpFailureStreak counter. >=2
  //    means we've had two failed ticks in a row and should slow down.
  const streak = (
    db
      .prepare(`SELECT failure_streak FROM director_budget_state WHERE repo_id = ?`)
      .get(repoId) as { failure_streak: number } | undefined
  )?.failure_streak;
  if (streak && streak >= FAILURE_STREAK_ATTENTION_THRESHOLD) {
    items.push({
      kind: "failure_streak_high",
      ref: "global",
      detail: `Director failure streak is ${streak} — investigate before more proposals`,
    });
  }

  // 5. Pending-proposal queue depth — if the human is buried in unreviewed
  //    proposals, the director should slow down rather than pile on.
  const pending = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM director_decisions WHERE repo_id = ? AND outcome = 'pending'`,
      )
      .get(repoId) as { n: number } | undefined
  )?.n;
  if (pending && pending >= PENDING_PROPOSAL_ATTENTION_THRESHOLD) {
    items.push({
      kind: "high_pending_proposals",
      ref: "global",
      detail: `${pending} proposals waiting for human approval — pause new ones until queue drains`,
    });
  }

  return items;
}

function scalar<T>(db: Db, sql: string, params: unknown[]): T {
  const row = db.prepare(sql).get(...(params as never[])) as { n: T } | undefined;
  return (row?.n ?? 0) as T;
}
