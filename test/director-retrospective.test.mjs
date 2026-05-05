// Tests for the adaptive-budget retrospective.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initDb } from "../dist/storage/db.js";
import {
  recalibrateBudget,
  sampleRecentOutcomes,
  shouldRecalibrateToday,
} from "../dist/director/retrospective.js";
import { ensureBudgetState } from "../dist/director/budget.js";
import { recordDecision, setDecisionOutcome } from "../dist/director/decisions.js";

const cfg = {
  initial_daily_usd: 2.0,
  initial_weekly_usd: 10.0,
  max_daily_usd: 10.0,
  max_weekly_usd: 50.0,
  think_daily_usd: 1.0,
  pause_on_failure_streak: 3,
  good_outcome_quarantine_days: 7,
};

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "openronin-retro-test-"));
  const db = initDb(dir);
  const r = db
    .prepare(
      `INSERT INTO repos (provider, owner, name, watched, config_json)
       VALUES ('github','o','o',1,'{}') RETURNING id`,
    )
    .get();
  ensureBudgetState(db, r.id, cfg);
  return { db, dir, repoId: r.id };
}
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });

function seedDecisions(db, repoId, outcomes) {
  for (const outcome of outcomes) {
    const d = recordDecision(db, {
      repoId,
      decisionType: "create_issue",
      rationale: "seeded for retro test",
      outcome: "pending",
    });
    setDecisionOutcome(db, d.id, outcome, "seeded");
  }
}

test("sample: empty → null success rate", () => {
  const { db, dir, repoId } = freshDb();
  try {
    const s = sampleRecentOutcomes(db, repoId);
    assert.equal(s.total, 0);
    assert.equal(s.successRate, null);
  } finally {
    cleanup(dir);
  }
});

test("sample: counts and success_rate excludes skipped", () => {
  const { db, dir, repoId } = freshDb();
  try {
    seedDecisions(db, repoId, [
      "executed",
      "executed",
      "executed",
      "executed",
      "failed",
      "rejected",
      "skipped", // excluded
      "skipped", // excluded
    ]);
    const s = sampleRecentOutcomes(db, repoId);
    assert.equal(s.executed, 4);
    assert.equal(s.failed, 1);
    assert.equal(s.rejected, 1);
    assert.equal(s.skipped, 2);
    // 4 / (4+1+1) = 0.666...
    assert.ok(Math.abs(s.successRate - 4 / 6) < 1e-9);
  } finally {
    cleanup(dir);
  }
});

test("recalibrate: high success rate → climb, capped at max", () => {
  const { db, dir, repoId } = freshDb();
  try {
    // 9 executed out of 10 = 90% → climb
    seedDecisions(db, repoId, [
      "executed",
      "executed",
      "executed",
      "executed",
      "executed",
      "executed",
      "executed",
      "executed",
      "executed",
      "failed",
    ]);
    const r = recalibrateBudget(db, repoId, cfg);
    assert.ok(r);
    assert.equal(r.oldDaily, 2.0);
    assert.ok(r.newDaily > r.oldDaily);
    assert.ok(r.newDaily <= cfg.max_daily_usd);
    assert.match(r.reason, /climb/);

    // Repeat enough times — should stop climbing at max_daily_usd.
    for (let i = 0; i < 50; i++) {
      // Each call writes to history table, but we want to roll the day
      // to allow it to fire — for the test, just call directly.
      recalibrateBudget(db, repoId, cfg);
    }
    const final = db
      .prepare(`SELECT daily_cap_usd FROM director_budget_state WHERE repo_id = ?`)
      .get(repoId);
    assert.ok(final.daily_cap_usd <= cfg.max_daily_usd);
    // After enough climbs we should be at the ceiling (within rounding).
    assert.ok(final.daily_cap_usd > 9.0);
  } finally {
    cleanup(dir);
  }
});

test("recalibrate: low success rate → shrink, floored at initial", () => {
  const { db, dir, repoId } = freshDb();
  try {
    // First climb a bit so we have room to shrink
    db.prepare(
      `UPDATE director_budget_state SET daily_cap_usd = 5.0, weekly_cap_usd = 25.0 WHERE repo_id = ?`,
    ).run(repoId);
    seedDecisions(db, repoId, ["executed", "failed", "failed", "failed", "rejected"]);
    const r = recalibrateBudget(db, repoId, cfg);
    assert.ok(r);
    assert.ok(r.newDaily < r.oldDaily);
    assert.match(r.reason, /shrink/);
    assert.ok(r.newDaily >= cfg.initial_daily_usd);
  } finally {
    cleanup(dir);
  }
});

test("recalibrate: insufficient sample → null (no change)", () => {
  const { db, dir, repoId } = freshDb();
  try {
    seedDecisions(db, repoId, ["executed", "executed"]); // < MIN_SAMPLE_SIZE = 5
    const r = recalibrateBudget(db, repoId, cfg);
    assert.equal(r, null);
  } finally {
    cleanup(dir);
  }
});

test("recalibrate: middling rate → null (hold steady)", () => {
  const { db, dir, repoId } = freshDb();
  try {
    seedDecisions(db, repoId, ["executed", "executed", "executed", "failed", "failed", "failed"]);
    const r = recalibrateBudget(db, repoId, cfg);
    // 3/(3+3) = 50% → between thresholds → no change
    assert.equal(r, null);
  } finally {
    cleanup(dir);
  }
});

test("recalibrate writes to budget history table", () => {
  const { db, dir, repoId } = freshDb();
  try {
    seedDecisions(db, repoId, [
      "executed",
      "executed",
      "executed",
      "executed",
      "executed",
      "failed",
    ]);
    recalibrateBudget(db, repoId, cfg);
    const hist = db
      .prepare(`SELECT * FROM director_budget_history WHERE repo_id = ?`)
      .all(repoId);
    assert.equal(hist.length, 1);
    assert.match(hist[0].reason, /climb/);
  } finally {
    cleanup(dir);
  }
});

test("shouldRecalibrateToday: true on first call, false right after", () => {
  const { db, dir, repoId } = freshDb();
  try {
    assert.equal(shouldRecalibrateToday(db, repoId), true, "first call should recalibrate");
    seedDecisions(db, repoId, [
      "executed",
      "executed",
      "executed",
      "executed",
      "executed",
      "failed",
    ]);
    recalibrateBudget(db, repoId, cfg);
    assert.equal(
      shouldRecalibrateToday(db, repoId),
      false,
      "second call same day should not",
    );
  } finally {
    cleanup(dir);
  }
});
