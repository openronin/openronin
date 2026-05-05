// Outcome follow-up — long-tail check on whether director decisions held up.
//
// `executed` is a snapshot — at the moment we ran the side-effect it
// looked successful. But the LLM's "good" outcomes have to survive
// downstream reality:
//   • create_issue → did the issue actually get worked on, or did it sit
//     stale and get closed without a fix?
//   • comment_on_pr / approve_pr → did the PR merge, or was the comment
//     ignored and the PR abandoned?
//   • merge_pr → was the merge reverted within a week?
//
// Each pass appends a row to `director_outcome_followups` for the
// decisions it observed. Multiple rows per decision over time is normal
// (a "still open" observation might later become "merged via PR #N").
// The latest row is what the trace UI shows.
//
// Scope of this PR: only `create_issue` is observed (most common type
// the director emits, and the easiest signal — issue state via VCS).
// `merge_pr` reverts and `approve_pr` outcomes are documented as future
// work; the schema is general enough to add them without a migration.

import type { Db } from "../storage/db.js";
import type { VcsProvider } from "../providers/vcs.js";

// Don't observe the same decision more often than this. Ticks fire every
// 10s but a real signal change happens on a day scale.
const MIN_OBSERVATION_INTERVAL_HOURS = 6;

// Stop following up after this many days. By then the issue is either
// resolved (and we have our answer) or genuinely stale (and another
// observation won't change that).
const FOLLOWUP_WINDOW_DAYS = 14;

export type FollowupKind =
  | "issue_open" // initial observation: still being worked on
  | "issue_closed_no_pr" // closed without a linked merged PR (likely won't-fix)
  | "issue_merged_via_pr" // closed with a merged PR — the win signal
  | "issue_pr_open" // a PR is open targeting this issue (in progress)
  | "fetch_error"; // VCS call failed; recorded so we don't retry hot

export type FollowupRow = {
  id: number;
  decisionId: number;
  observedAt: string;
  kind: FollowupKind;
  detail: string | null;
  refNumber: number | null;
  refUrl: string | null;
};

export function recordFollowup(
  db: Db,
  args: {
    decisionId: number;
    kind: FollowupKind;
    detail?: string | null;
    refNumber?: number | null;
    refUrl?: string | null;
  },
): FollowupRow {
  const row = db
    .prepare(
      `INSERT INTO director_outcome_followups (decision_id, kind, detail, ref_number, ref_url)
       VALUES (?, ?, ?, ?, ?)
       RETURNING id, decision_id AS decisionId, observed_at AS observedAt, kind, detail, ref_number AS refNumber, ref_url AS refUrl`,
    )
    .get(
      args.decisionId,
      args.kind,
      args.detail ?? null,
      args.refNumber ?? null,
      args.refUrl ?? null,
    ) as FollowupRow;
  return row;
}

export function followupsForDecision(db: Db, decisionId: number): FollowupRow[] {
  const rows = db
    .prepare(
      `SELECT id, decision_id AS decisionId, observed_at AS observedAt, kind, detail,
              ref_number AS refNumber, ref_url AS refUrl
       FROM director_outcome_followups
       WHERE decision_id = ?
       ORDER BY id DESC`,
    )
    .all(decisionId) as FollowupRow[];
  return rows;
}

export function latestFollowup(db: Db, decisionId: number): FollowupRow | null {
  const rows = followupsForDecision(db, decisionId);
  return rows.length > 0 ? (rows[0] ?? null) : null;
}

// Pick decisions that are due for a fresh observation. Criteria:
//   • outcome=executed (we never followed-up speculatively on pending)
//   • decisionType=create_issue (current scope)
//   • the decision is within the FOLLOWUP_WINDOW_DAYS observation window
//   • either: no follow-up yet, OR the latest follow-up is older than
//     MIN_OBSERVATION_INTERVAL_HOURS AND not a terminal kind
//
// Cap result at 5 to keep one sweep cheap on a busy repo.
type CandidateRow = {
  decision_id: number;
  payload: string | null;
  outcome_details: string | null;
};

export function pickFollowupCandidates(db: Db, repoId: number, limit = 5): CandidateRow[] {
  return db
    .prepare(
      `SELECT d.id AS decision_id, d.payload AS payload, d.outcome_details
       FROM director_decisions d
       WHERE d.repo_id = ?
         AND d.outcome = 'executed'
         AND d.decision_type = 'create_issue'
         AND d.ts > datetime('now', '-' || ? || ' days')
         AND NOT EXISTS (
           SELECT 1 FROM director_outcome_followups f
           WHERE f.decision_id = d.id
             AND (
               f.kind IN ('issue_closed_no_pr','issue_merged_via_pr')
               OR f.observed_at > datetime('now', '-' || ? || ' hours')
             )
         )
       ORDER BY d.id DESC
       LIMIT ?`,
    )
    .all(repoId, FOLLOWUP_WINDOW_DAYS, MIN_OBSERVATION_INTERVAL_HOURS, limit) as CandidateRow[];
}

// Extract the issue number that an executed `create_issue` produced. The
// executor records `outcome_details = "issue #N created (https://...)"`.
export function parseIssueNumberFromOutcomeDetails(details: string | null): number | null {
  if (!details) return null;
  const m = details.match(/issue #(\d+)/i);
  return m ? Number(m[1]) : null;
}

// Run one follow-up sweep for a repo. Walks the candidate list, polls
// VCS for each, inserts a row. Caller manages cadence (we throttle here
// per-decision, but the loop should call this at most ~hourly per repo
// to avoid burning rate limit).
export async function runOutcomeFollowupSweep(
  db: Db,
  repoId: number,
  ownerName: string,
  repoName: string,
  vcs: VcsProvider,
): Promise<{ observed: number; errored: number }> {
  const candidates = pickFollowupCandidates(db, repoId);
  let observed = 0;
  let errored = 0;
  for (const c of candidates) {
    const issueNumber = parseIssueNumberFromOutcomeDetails(c.outcome_details);
    if (!issueNumber) continue;
    try {
      const item = await vcs.getItem({ owner: ownerName, name: repoName }, issueNumber);
      // GitHub returns issues for both real issues and PRs; if `pull_request`
      // shows up the issue itself IS a PR. We only care about pure issues
      // here; future work covers PR/revert tracking.
      const isPr = item.kind === "pull_request";
      if (isPr) {
        // The executed create_issue produced an issue but somehow it's
        // showing as a PR — record and move on.
        recordFollowup(db, {
          decisionId: c.decision_id,
          kind: "issue_pr_open",
          detail: `tracked item is a PR, not an issue (state=${item.state})`,
          refNumber: issueNumber,
          refUrl: item.url ?? null,
        });
      } else if (item.state === "closed") {
        // GitHub-closed issues with `state_reason="completed"` are
        // typically closed by a merged PR's "fixes #N" link — that's
        // our positive signal. Anything else (`not_planned`,
        // `duplicate`, or no reason at all) counts as closed-without-fix.
        const reason = item.stateReason ?? "";
        const kind: FollowupKind =
          reason === "completed" ? "issue_merged_via_pr" : "issue_closed_no_pr";
        recordFollowup(db, {
          decisionId: c.decision_id,
          kind,
          detail: `closed${reason ? ` (state_reason=${reason})` : ""}`,
          refNumber: issueNumber,
          refUrl: item.url ?? null,
        });
      } else {
        recordFollowup(db, {
          decisionId: c.decision_id,
          kind: "issue_open",
          detail: `still open${item.title ? ` — "${item.title.slice(0, 80)}"` : ""}`,
          refNumber: issueNumber,
          refUrl: item.url ?? null,
        });
      }
      observed++;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      recordFollowup(db, {
        decisionId: c.decision_id,
        kind: "fetch_error",
        detail: detail.slice(0, 240),
        refNumber: issueNumber,
        refUrl: null,
      });
      errored++;
    }
  }
  return { observed, errored };
}

export function summariseFollowup(row: FollowupRow): string {
  switch (row.kind) {
    case "issue_open":
      return `🔵 still open${row.refNumber ? ` (#${row.refNumber})` : ""}`;
    case "issue_pr_open":
      return `🟡 tracked as PR${row.refNumber ? ` (#${row.refNumber})` : ""}`;
    case "issue_closed_no_pr":
      return `⚫ closed without a PR${row.refNumber ? ` (#${row.refNumber})` : ""}`;
    case "issue_merged_via_pr":
      return `🟢 merged${row.refNumber ? ` (closed #${row.refNumber})` : ""}`;
    case "fetch_error":
      return `❓ fetch error: ${row.detail ?? "(no detail)"}`;
    default:
      return row.kind;
  }
}
