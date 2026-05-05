// Decision dedup hashing + duplicate detection.
//
// Verifies:
//   • normaliseText folds case / whitespace / common prefixes
//   • hashPayload returns stable values for cosmetic re-wordings
//   • create_issue, comment_*, label_* each generate distinct hashes
//   • findRecentDuplicate respects the 7-day lookback
//   • outcome filter excludes rejected/expired/failed
//   • runTick records duplicates as skipped, not pending

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initDb } from "../dist/storage/db.js";
import {
  canonicalForHash,
  findRecentDuplicate,
  hashPayload,
  normaliseText,
} from "../dist/director/dedup.js";
import { recordDecision } from "../dist/director/decisions.js";
import { runTick } from "../dist/director/tick.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "openronin-dedup-test-"));
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

test("normaliseText: folds case + whitespace + common prefix + trailing punct", () => {
  assert.equal(normaliseText("Issue: Add Per-Repo cost view!  "), "add per-repo cost view");
  assert.equal(normaliseText("  add\n\nper-repo  cost view."), "add per-repo cost view");
  assert.equal(normaliseText(""), "");
  assert.equal(normaliseText(undefined), "");
});

test("hashPayload: same canonical title → same hash for create_issue", () => {
  const a = hashPayload("create_issue", {
    title: "Add Per-Repo cost view to admin dashboard.",
    body: "## Problem\n\nFoo.",
  });
  const b = hashPayload("create_issue", {
    title: "  add per-repo cost view to admin dashboard ",
    body: "## Problem\n\nFoo.",
  });
  assert.equal(a, b);
  assert.ok(typeof a === "string" && a.length > 0);
});

test("hashPayload: different decision_type → different hash even with same body", () => {
  const issue = hashPayload("create_issue", { title: "x", body: "y" });
  const comment = hashPayload("comment_on_issue", { issue_number: 1, body: "y" });
  assert.notEqual(issue, comment);
});

test("hashPayload: returns null for ask_user / no_op (always idempotent)", () => {
  assert.equal(hashPayload("ask_user", { question: "?" }), null);
  assert.equal(hashPayload("no_op", null), null);
});

test("canonicalForHash: label_* canonicalises set semantics (order-independent)", () => {
  const a = canonicalForHash("label_issue", {
    issue_number: 5,
    add: ["bug", "good first issue"],
    remove: ["wontfix"],
  });
  const b = canonicalForHash("label_issue", {
    issue_number: 5,
    add: ["good first issue", "bug", "bug"],
    remove: ["wontfix"],
  });
  assert.equal(a, b);
});

test("findRecentDuplicate: matches pending; ignores rejected/expired", () => {
  const { db, dir, repoId } = freshDb();
  try {
    const payload = { title: "Add Per-Repo cost view", body: "## Problem\n\nFoo." };
    const first = recordDecision(db, {
      repoId,
      decisionType: "create_issue",
      rationale: "observability priority is uncovered",
      payload,
      outcome: "pending",
    });
    const hash = hashPayload("create_issue", payload);
    assert.equal(findRecentDuplicate(db, repoId, hash), first.id);

    // Reject the first; lookup should now return null (no live duplicate).
    db.prepare(`UPDATE director_decisions SET outcome = 'rejected' WHERE id = ?`).run(first.id);
    assert.equal(findRecentDuplicate(db, repoId, hash), null);
  } finally {
    cleanup(dir);
  }
});

test("findRecentDuplicate: respects 7-day lookback", () => {
  const { db, dir, repoId } = freshDb();
  try {
    const payload = { title: "Add Per-Repo cost view" };
    recordDecision(db, {
      repoId,
      decisionType: "create_issue",
      rationale: "old proposal that was stuck pending",
      payload,
      outcome: "pending",
    });
    const hash = hashPayload("create_issue", payload);
    // Backdate the row to 30d ago.
    db.prepare(
      `UPDATE director_decisions SET ts = datetime('now', '-30 days') WHERE payload_hash = ?`,
    ).run(hash);
    assert.equal(findRecentDuplicate(db, repoId, hash, 7), null);
    // But within a 60d window, it shows up again.
    assert.notEqual(findRecentDuplicate(db, repoId, hash, 60), null);
  } finally {
    cleanup(dir);
  }
});

const sampleCharter = {
  vision: "Reliable, observable AI dev agent.",
  priorities: [{ id: "observability", weight: 1.0, rubric: "debuggable without SSH" }],
  out_of_bounds: [],
  out_of_bounds_paths: [],
  definition_of_done: [],
};

const sampleBudget = {
  initial_daily_usd: 2.0,
  initial_weekly_usd: 10.0,
  max_daily_usd: 10.0,
  max_weekly_usd: 50.0,
  think_daily_usd: 1.0,
  pause_on_failure_streak: 3,
  good_outcome_quarantine_days: 7,
};

const sampleDirector = {
  enabled: true,
  mode: "dry_run",
  cadence_hours: 6,
  bot_prefix: "👔 director:",
  language: "English",
  charter: sampleCharter,
  budget: sampleBudget,
  authority: {
    can_create_issues: true,
    can_label: true,
    can_close_issues: false,
    can_comment: true,
    can_approve_pr: true,
    can_merge: false,
    can_modify_charter: false,
  },
};

const sampleRepo = {
  provider: "github",
  owner: "openronin",
  name: "openronin",
  watched: true,
  lanes: ["triage"],
  director: sampleDirector,
};

const llmJsonCreateIssue = {
  observations: "Project lacks observability into engine costs per repo.",
  reasoning: "Per-repo cost view is missing — observability priority is at 1.0 in the charter.",
  decisions: [
    {
      type: "create_issue",
      rationale: "Charter priority observability is underserved",
      priority_id: "observability",
      payload: {
        title: "Add per-repo cost view to admin dashboard",
        body: "## Problem\n\nThe cost dashboard groups by lane and engine but not by repo.",
        labels: [],
        priority: "normal",
      },
    },
  ],
};

function mockEngine(json) {
  return () => ({
    id: "mock",
    defaultModel: "mock",
    async run() {
      return {
        content: JSON.stringify(json),
        json,
        usage: { tokensIn: 100, tokensOut: 50, costUsd: 0.001 },
        finishReason: "end_turn",
        durationMs: 50,
      };
    },
  });
}

test("runTick: second tick proposing the same create_issue records skipped, not pending", async () => {
  const { db, dir, repoId } = freshDb();
  try {
    // First tick: persist as pending (we use a non-dry mode so it stays pending).
    const proposeDirector = { ...sampleDirector, mode: "propose" };
    const result1 = await runTick({
      db,
      repoId,
      repo: { ...sampleRepo, director: proposeDirector },
      director: proposeDirector,
      dataDir: dir,
      engineFactory: mockEngine(llmJsonCreateIssue),
    });
    assert.equal(result1.status, "ok");

    // Second tick: same payload, slightly different wording → still dups.
    const cosmeticDup = JSON.parse(JSON.stringify(llmJsonCreateIssue));
    cosmeticDup.decisions[0].payload.title = "  Add Per-Repo cost view to admin dashboard.  ";
    cosmeticDup.decisions[0].rationale = "again, observability priority is underserved";
    const result2 = await runTick({
      db,
      repoId,
      repo: { ...sampleRepo, director: proposeDirector },
      director: proposeDirector,
      dataDir: dir,
      engineFactory: mockEngine(cosmeticDup),
    });
    assert.equal(result2.status, "ok");

    const rows = db
      .prepare(
        `SELECT id, decision_type, outcome, outcome_details FROM director_decisions
         WHERE repo_id = ? ORDER BY id`,
      )
      .all(repoId);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].outcome, "pending"); // first survived as a real proposal
    assert.equal(rows[1].outcome, "skipped"); // second got dedup'd
    assert.match(rows[1].outcome_details, /duplicate of decision #/);
  } finally {
    cleanup(dir);
  }
});
