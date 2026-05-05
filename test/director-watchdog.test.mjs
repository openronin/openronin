// Stale watchdog: collectAttentionItems via captureStateSnapshot.
//
// Verifies each attention category surfaces correctly:
//   • stale_pr — open PR with no update >24h
//   • stale_awaiting_answer — issue task with awaiting-answer label, last_run_at >48h
//   • recent_deploy_failed — deploy with status != ok in last 48h
//   • failure_streak_high — director_budget_state.failure_streak >= 2
//   • high_pending_proposals — >=5 pending decisions

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initDb } from "../dist/storage/db.js";
import { captureStateSnapshot } from "../dist/director/state.js";
import { ensureBudgetState, bumpFailureStreak } from "../dist/director/budget.js";
import { recordDecision } from "../dist/director/decisions.js";

const sampleBudget = {
  initial_daily_usd: 2.0,
  initial_weekly_usd: 10.0,
  max_daily_usd: 10.0,
  max_weekly_usd: 50.0,
  think_daily_usd: 1.0,
  pause_on_failure_streak: 3,
  good_outcome_quarantine_days: 7,
};

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "openronin-watchdog-test-"));
  const db = initDb(dir);
  const result = db
    .prepare(
      `INSERT INTO repos (provider, owner, name, watched, config_json)
       VALUES ('github', 'openronin', 'openronin', 1, '{}')
       RETURNING id`,
    )
    .get();
  return { db, dir, repoId: result.id };
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

test("watchdog: empty repo → no attention items", () => {
  const { db, dir, repoId } = freshDb();
  ensureBudgetState(db, repoId, sampleBudget);
  try {
    const snapshot = captureStateSnapshot(db, repoId, "openronin", "openronin");
    assert.deepEqual(snapshot.attentionItems, []);
  } finally {
    cleanup(dir);
  }
});

test("watchdog: stale PR (>24h) surfaces a stale_pr item", () => {
  const { db, dir, repoId } = freshDb();
  ensureBudgetState(db, repoId, sampleBudget);
  try {
    const taskRow = db
      .prepare(
        `INSERT INTO tasks (repo_id, external_id, kind, status)
         VALUES (?, '99', 'pr', 'pending') RETURNING id`,
      )
      .get(repoId);
    db.prepare(
      `INSERT INTO pr_branches (task_id, pr_number, branch, status, iterations, updated_at)
       VALUES (?, 99, 'feat/abandoned', 'open', 0, datetime('now', '-30 hours'))`,
    ).run(taskRow.id);

    const snapshot = captureStateSnapshot(db, repoId, "openronin", "openronin");
    const stalePrs = snapshot.attentionItems.filter((a) => a.kind === "stale_pr");
    assert.equal(stalePrs.length, 1);
    assert.equal(stalePrs[0].ref, "#99");
    assert.ok(stalePrs[0].ageHours >= 29);
  } finally {
    cleanup(dir);
  }
});

test("watchdog: awaiting-answer issue >48h flagged", () => {
  const { db, dir, repoId } = freshDb();
  ensureBudgetState(db, repoId, sampleBudget);
  try {
    db.prepare(
      `INSERT INTO tasks (repo_id, external_id, kind, status, last_run_at, decision_json)
       VALUES (?, '42', 'issue', 'pending', datetime('now', '-72 hours'), ?)`,
    ).run(repoId, JSON.stringify({ labels: ["openronin:awaiting-answer"] }));

    const snapshot = captureStateSnapshot(db, repoId, "openronin", "openronin");
    const stuck = snapshot.attentionItems.filter((a) => a.kind === "stale_awaiting_answer");
    assert.equal(stuck.length, 1);
    assert.equal(stuck[0].ref, "#42");
  } finally {
    cleanup(dir);
  }
});

test("watchdog: recent failed deploy surfaces", () => {
  const { db, dir, repoId } = freshDb();
  ensureBudgetState(db, repoId, sampleBudget);
  try {
    db.prepare(
      `INSERT INTO deploys (repo_id, sha, branch, triggered_by, status, started_at)
       VALUES (?, 'abcdef0123456789', 'main', 'auto', 'error', datetime('now', '-2 hours'))`,
    ).run(repoId);

    const snapshot = captureStateSnapshot(db, repoId, "openronin", "openronin");
    const failed = snapshot.attentionItems.filter((a) => a.kind === "recent_deploy_failed");
    assert.equal(failed.length, 1);
    assert.match(failed[0].ref, /deploy abcdef0/);
  } finally {
    cleanup(dir);
  }
});

test("watchdog: failure streak >=2 flagged; <2 silent", () => {
  const { db, dir, repoId } = freshDb();
  ensureBudgetState(db, repoId, sampleBudget);
  try {
    bumpFailureStreak(db, repoId);
    let snapshot = captureStateSnapshot(db, repoId, "openronin", "openronin");
    assert.equal(snapshot.attentionItems.filter((a) => a.kind === "failure_streak_high").length, 0);

    bumpFailureStreak(db, repoId);
    snapshot = captureStateSnapshot(db, repoId, "openronin", "openronin");
    assert.equal(snapshot.attentionItems.filter((a) => a.kind === "failure_streak_high").length, 1);
  } finally {
    cleanup(dir);
  }
});

test("watchdog: high pending proposals queue surfaces when >=5", () => {
  const { db, dir, repoId } = freshDb();
  ensureBudgetState(db, repoId, sampleBudget);
  try {
    for (let i = 0; i < 5; i++) {
      recordDecision(db, {
        repoId,
        decisionType: "create_issue",
        rationale: `pending proposal #${i} for backlog`,
        payload: { title: `proposal ${i}` },
        outcome: "pending",
      });
    }
    const snapshot = captureStateSnapshot(db, repoId, "openronin", "openronin");
    const queue = snapshot.attentionItems.filter((a) => a.kind === "high_pending_proposals");
    assert.equal(queue.length, 1);
    assert.match(queue[0].detail, /5 proposals/);
  } finally {
    cleanup(dir);
  }
});
