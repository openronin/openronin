// Adaptive budget tracker for the Director.
//
// Two cost streams:
//   • project budget — what the Director's spawned issues end up costing the
//     worker. Capped per-day and per-week, climbs slowly on good outcomes,
//     shrinks on bad ones.
//   • think budget   — what the Director itself spends on its planning LLM
//     calls. Hard daily cap, no adaptation.
//
// Plus a failure-streak gate: N consecutive failures (rejected proposal,
// red CI, lane error) → pause and wait for human directive in chat.
//
// This file implements the bookkeeping. The actual decisions about *when*
// to check the budget live in `tick.ts` (foundation tick is no-op).

import type { Db } from "../storage/db.js";
import type { BudgetConfig, BudgetState } from "./types.js";

type BudgetRow = {
  repo_id: number;
  daily_cap_usd: number;
  weekly_cap_usd: number;
  spent_today_usd: number;
  spent_week_usd: number;
  spent_today_think_usd: number;
  failure_streak: number;
  last_tick_at: string | null;
  last_reset_day: string | null;
  paused: number;
  pause_reason: string | null;
};

function rowToState(row: BudgetRow): BudgetState {
  return {
    repoId: row.repo_id,
    dailyCapUsd: row.daily_cap_usd,
    weeklyCapUsd: row.weekly_cap_usd,
    spentTodayUsd: row.spent_today_usd,
    spentWeekUsd: row.spent_week_usd,
    spentTodayThinkUsd: row.spent_today_think_usd,
    failureStreak: row.failure_streak,
    lastTickAt: row.last_tick_at,
    lastResetDay: row.last_reset_day,
    paused: row.paused !== 0,
    pauseReason: row.pause_reason,
  };
}

export function ensureBudgetState(
  db: Db,
  repoId: number,
  cfg: BudgetConfig,
): BudgetState {
  const existing = db
    .prepare(`SELECT * FROM director_budget_state WHERE repo_id = ?`)
    .get(repoId) as BudgetRow | undefined;
  if (existing) return rowToState(existing);
  db.prepare(
    `INSERT INTO director_budget_state
       (repo_id, daily_cap_usd, weekly_cap_usd)
     VALUES (?, ?, ?)`,
  ).run(repoId, cfg.initial_daily_usd, cfg.initial_weekly_usd);
  return rowToState(
    db
      .prepare(`SELECT * FROM director_budget_state WHERE repo_id = ?`)
      .get(repoId) as BudgetRow,
  );
}

function utcDayString(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

// Reset spent_today_* counters once per UTC day.
export function rolloverDayIfNeeded(db: Db, repoId: number): void {
  const today = utcDayString();
  db.prepare(
    `UPDATE director_budget_state
     SET spent_today_usd = 0,
         spent_today_think_usd = 0,
         last_reset_day = ?
     WHERE repo_id = ? AND (last_reset_day IS NULL OR last_reset_day < ?)`,
  ).run(today, repoId, today);
}

export function recordThinkSpend(db: Db, repoId: number, costUsd: number): void {
  db.prepare(
    `UPDATE director_budget_state
     SET spent_today_think_usd = spent_today_think_usd + ?,
         updated_at = datetime('now')
     WHERE repo_id = ?`,
  ).run(costUsd, repoId);
}

export function recordProjectSpend(db: Db, repoId: number, costUsd: number): void {
  db.prepare(
    `UPDATE director_budget_state
     SET spent_today_usd = spent_today_usd + ?,
         spent_week_usd = spent_week_usd + ?,
         updated_at = datetime('now')
     WHERE repo_id = ?`,
  ).run(costUsd, costUsd, repoId);
}

export function bumpFailureStreak(db: Db, repoId: number): number {
  db.prepare(
    `UPDATE director_budget_state
     SET failure_streak = failure_streak + 1,
         updated_at = datetime('now')
     WHERE repo_id = ?`,
  ).run(repoId);
  const row = db
    .prepare(`SELECT failure_streak FROM director_budget_state WHERE repo_id = ?`)
    .get(repoId) as { failure_streak: number };
  return row.failure_streak;
}

export function resetFailureStreak(db: Db, repoId: number): void {
  db.prepare(
    `UPDATE director_budget_state
     SET failure_streak = 0,
         updated_at = datetime('now')
     WHERE repo_id = ?`,
  ).run(repoId);
}

export function pause(db: Db, repoId: number, reason: string): void {
  db.prepare(
    `UPDATE director_budget_state
     SET paused = 1, pause_reason = ?, updated_at = datetime('now')
     WHERE repo_id = ?`,
  ).run(reason, repoId);
}

export function unpause(db: Db, repoId: number): void {
  db.prepare(
    `UPDATE director_budget_state
     SET paused = 0, pause_reason = NULL, updated_at = datetime('now')
     WHERE repo_id = ?`,
  ).run(repoId);
}

export function markTick(db: Db, repoId: number): void {
  db.prepare(
    `UPDATE director_budget_state
     SET last_tick_at = datetime('now'),
         updated_at = datetime('now')
     WHERE repo_id = ?`,
  ).run(repoId);
}

// "Should we tick this repo right now?" — pure check, no side effect.
export type GateResult =
  | { ok: true }
  | { ok: false; reason: string };

export function checkBudgetGate(
  state: BudgetState,
  cfg: BudgetConfig,
): GateResult {
  if (state.paused) {
    return { ok: false, reason: `paused: ${state.pauseReason ?? "manual"}` };
  }
  if (state.failureStreak >= cfg.pause_on_failure_streak) {
    return {
      ok: false,
      reason: `failure_streak ${state.failureStreak} >= ${cfg.pause_on_failure_streak}`,
    };
  }
  if (state.spentTodayThinkUsd >= cfg.think_daily_usd) {
    return {
      ok: false,
      reason: `think budget exhausted ($${state.spentTodayThinkUsd.toFixed(2)})`,
    };
  }
  if (state.spentTodayUsd >= state.dailyCapUsd) {
    return { ok: false, reason: `daily project budget exhausted` };
  }
  if (state.spentWeekUsd >= state.weeklyCapUsd) {
    return { ok: false, reason: `weekly project budget exhausted` };
  }
  return { ok: true };
}
