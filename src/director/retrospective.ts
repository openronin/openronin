// Adaptive-budget retrospective.
//
// Once per UTC day (right after the day-rollover), look at the recent track
// record of director-emitted decisions and adjust the repo's daily/weekly
// budget caps accordingly:
//
//   • success_rate ≥ 0.80 over a meaningful sample → climb 10% (cap at max)
//   • success_rate ≤ 0.40 over a meaningful sample → shrink 20% (floor at initial)
//   • otherwise hold steady
//
// Sample = decisions in the last 14 days with terminal outcomes (executed,
// failed, rejected, skipped). dry_run / pending don't count — they aren't
// outcomes yet.
//
// "Success" = `executed`. `failed` and `rejected` are negative. `skipped`
// is neutral (it just means the operator didn't unlock that decision type).
//
// Trade-off: this isn't a "good outcome retrospective" in the strong sense
// (we'd need to look at whether merged PRs stuck around for 7 days without
// being reverted). Doing that requires polling the VCS for revert / CI
// state per merge over a week — out of scope for this version. The current
// model is honest about its limits and writes its reasoning to chat.

import type { Db } from "../storage/db.js";
import type { BudgetConfig } from "./types.js";

const WINDOW_DAYS = 14;
const MIN_SAMPLE_SIZE = 5;
const CLIMB_THRESHOLD = 0.8;
const SHRINK_THRESHOLD = 0.4;
const CLIMB_FACTOR = 1.1;
const SHRINK_FACTOR = 0.8;

export type RetroSample = {
  windowDays: number;
  total: number;
  executed: number;
  failed: number;
  rejected: number;
  skipped: number;
  // Computed: success_rate = executed / (executed + failed + rejected).
  // skipped excluded (operator policy, not outcome).
  successRate: number | null;
};

export type RetroResult = {
  sample: RetroSample;
  oldDaily: number;
  newDaily: number;
  oldWeekly: number;
  newWeekly: number;
  reason: string;
};

export function sampleRecentOutcomes(db: Db, repoId: number): RetroSample {
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN outcome = 'executed' THEN 1 ELSE 0 END) AS executed,
         SUM(CASE WHEN outcome = 'failed'   THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN outcome = 'rejected' THEN 1 ELSE 0 END) AS rejected,
         SUM(CASE WHEN outcome = 'skipped'  THEN 1 ELSE 0 END) AS skipped,
         COUNT(*) AS total
       FROM director_decisions
       WHERE repo_id = ?
         AND ts > datetime('now', '-' || ? || ' days')
         AND outcome IN ('executed','failed','rejected','skipped')`,
    )
    .get(repoId, WINDOW_DAYS) as
    | {
        executed: number | null;
        failed: number | null;
        rejected: number | null;
        skipped: number | null;
        total: number;
      }
    | undefined;
  const executed = row?.executed ?? 0;
  const failed = row?.failed ?? 0;
  const rejected = row?.rejected ?? 0;
  const skipped = row?.skipped ?? 0;
  const total = row?.total ?? 0;
  const counted = executed + failed + rejected; // skipped excluded
  const successRate = counted > 0 ? executed / counted : null;
  return { windowDays: WINDOW_DAYS, total, executed, failed, rejected, skipped, successRate };
}

export function recalibrateBudget(db: Db, repoId: number, cfg: BudgetConfig): RetroResult | null {
  const sample = sampleRecentOutcomes(db, repoId);

  // Read current caps.
  const cur = db
    .prepare(`SELECT daily_cap_usd, weekly_cap_usd FROM director_budget_state WHERE repo_id = ?`)
    .get(repoId) as { daily_cap_usd: number; weekly_cap_usd: number } | undefined;
  if (!cur) return null;

  const oldDaily = cur.daily_cap_usd;
  const oldWeekly = cur.weekly_cap_usd;

  // Don't move the caps until we have enough signal.
  if (sample.executed + sample.failed + sample.rejected < MIN_SAMPLE_SIZE) {
    return null;
  }

  const rate = sample.successRate ?? 0;
  let factor = 1;
  let reason = "no change";
  if (rate >= CLIMB_THRESHOLD) {
    factor = CLIMB_FACTOR;
    reason = `climb (success_rate ${(rate * 100).toFixed(0)}% over ${sample.executed + sample.failed + sample.rejected} decisions)`;
  } else if (rate <= SHRINK_THRESHOLD) {
    factor = SHRINK_FACTOR;
    reason = `shrink (success_rate ${(rate * 100).toFixed(0)}% over ${sample.executed + sample.failed + sample.rejected} decisions)`;
  } else {
    return null; // hold steady
  }

  const newDaily = clamp(oldDaily * factor, cfg.initial_daily_usd, cfg.max_daily_usd);
  const newWeekly = clamp(oldWeekly * factor, cfg.initial_weekly_usd, cfg.max_weekly_usd);

  // No-op if floor/ceiling kept us at the same number.
  if (Math.abs(newDaily - oldDaily) < 0.005 && Math.abs(newWeekly - oldWeekly) < 0.005) {
    return null;
  }

  db.prepare(
    `UPDATE director_budget_state
     SET daily_cap_usd = ?, weekly_cap_usd = ?, updated_at = datetime('now')
     WHERE repo_id = ?`,
  ).run(newDaily, newWeekly, repoId);

  db.prepare(
    `INSERT INTO director_budget_history
       (repo_id, old_daily_cap, new_daily_cap, old_weekly_cap, new_weekly_cap,
        success_rate, sample_size, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    repoId,
    oldDaily,
    newDaily,
    oldWeekly,
    newWeekly,
    sample.successRate,
    sample.executed + sample.failed + sample.rejected,
    reason,
  );

  return { sample, oldDaily, newDaily, oldWeekly, newWeekly, reason };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// Was the last recalibration on a different UTC day from now? If yes, we
// should run again. We piggyback on `last_reset_day` from
// `director_budget_state` so we don't need a separate column.
export function shouldRecalibrateToday(db: Db, repoId: number): boolean {
  const row = db
    .prepare(`SELECT MAX(date(ts)) AS last_day FROM director_budget_history WHERE repo_id = ?`)
    .get(repoId) as { last_day: string | null } | undefined;
  const today = new Date().toISOString().slice(0, 10);
  return !row?.last_day || row.last_day < today;
}
