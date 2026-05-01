// Foundation tests for the Director.
//
// These exercise: schema migration v12 lands cleanly, charter parsing
// roundtrips, charter versioning is content-addressed, the chat append +
// recent + since helpers behave, and the budget gate trips on the right
// thresholds. No LLM calls — that lands in #22.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initDb } from "../dist/storage/db.js";
import {
  appendMessage,
  recentMessages,
  messagesSince,
  unansweredUserDirectives,
} from "../dist/director/chat.js";
import {
  parseCharter,
  charterHash,
  captureCharterVersion,
  latestCharterVersion,
} from "../dist/director/charter.js";
import {
  recordDecision,
  setDecisionOutcome,
  recentDecisions,
  pendingDecisions,
} from "../dist/director/decisions.js";
import {
  ensureBudgetState,
  checkBudgetGate,
  recordThinkSpend,
  recordProjectSpend,
  bumpFailureStreak,
  resetFailureStreak,
  pause,
  unpause,
} from "../dist/director/budget.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "openronin-director-test-"));
  const db = initDb(dir);
  // Need a repo to satisfy FK constraints on director_* tables.
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

const sampleCharter = {
  vision: "Reliable, observable AI dev agent.",
  priorities: [
    { id: "reliability", weight: 0.5, rubric: "graceful failure" },
    { id: "observability", weight: 0.5, rubric: "debuggable without SSH" },
  ],
  out_of_bounds: ["no schema changes without migration"],
  out_of_bounds_paths: ["src/storage/db.ts"],
  definition_of_done: ["pnpm run check green"],
};

test("migration v12 creates director tables", () => {
  const { db, dir } = freshDb();
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name);
    for (const expected of [
      "director_messages",
      "director_decisions",
      "director_charter_versions",
      "director_budget_state",
    ]) {
      assert.ok(tables.includes(expected), `missing table ${expected}`);
    }
    const v = db.prepare("SELECT MAX(version) AS v FROM schema_version").get().v;
    assert.ok(v >= 12, `schema version >= 12, got ${v}`);
  } finally {
    cleanup(dir);
  }
});

test("parseCharter accepts well-formed and rejects malformed", () => {
  assert.ok(parseCharter(sampleCharter));
  assert.equal(parseCharter(null), null);
  assert.equal(parseCharter({ vision: "x" }), null); // no priorities
  assert.equal(parseCharter({ vision: "x", priorities: [] }), null); // empty
});

test("charterHash is stable and content-addressed", () => {
  const h1 = charterHash(parseCharter(sampleCharter));
  const h2 = charterHash(parseCharter({ ...sampleCharter }));
  assert.equal(h1, h2);
  const h3 = charterHash(parseCharter({ ...sampleCharter, vision: "different" }));
  assert.notEqual(h1, h3);
});

test("captureCharterVersion deduplicates identical content", () => {
  const { db, dir, repoId } = freshDb();
  try {
    const charter = parseCharter(sampleCharter);
    const v1 = captureCharterVersion(db, repoId, charter);
    const v2 = captureCharterVersion(db, repoId, charter);
    assert.equal(v1, v2, "same charter → same version");
    const altered = parseCharter({ ...sampleCharter, vision: "v2" });
    const v3 = captureCharterVersion(db, repoId, altered);
    assert.equal(v3, v1 + 1);

    const latest = latestCharterVersion(db, repoId);
    assert.equal(latest.version, v3);
    assert.equal(latest.charter.vision, "v2");
  } finally {
    cleanup(dir);
  }
});

test("chat append + recent ordering", () => {
  const { db, dir, repoId } = freshDb();
  try {
    appendMessage(db, { repoId, role: "director", type: "tick_log", body: "first" });
    appendMessage(db, { repoId, role: "user", type: "directive", body: "focus on tests" });
    appendMessage(db, { repoId, role: "director", type: "report", body: "done" });
    const msgs = recentMessages(db, repoId, 50);
    assert.equal(msgs.length, 3);
    assert.equal(msgs[0].body, "first");
    assert.equal(msgs[2].body, "done");
  } finally {
    cleanup(dir);
  }
});

test("messagesSince returns only newer messages", () => {
  const { db, dir, repoId } = freshDb();
  try {
    const m1 = appendMessage(db, { repoId, role: "director", type: "tick_log", body: "a" });
    appendMessage(db, { repoId, role: "director", type: "tick_log", body: "b" });
    appendMessage(db, { repoId, role: "user", type: "directive", body: "c" });
    const newer = messagesSince(db, repoId, m1.id);
    assert.equal(newer.length, 2);
    assert.equal(newer[0].body, "b");
    assert.equal(newer[1].body, "c");
  } finally {
    cleanup(dir);
  }
});

test("unansweredUserDirectives finds messages after last director reply", () => {
  const { db, dir, repoId } = freshDb();
  try {
    appendMessage(db, { repoId, role: "director", type: "status", body: "tick" });
    appendMessage(db, { repoId, role: "user", type: "directive", body: "do X" });
    appendMessage(db, { repoId, role: "user", type: "answer", body: "and Y" });
    const open = unansweredUserDirectives(db, repoId);
    assert.equal(open.length, 2);
    appendMessage(db, { repoId, role: "director", type: "report", body: "ok" });
    const stillOpen = unansweredUserDirectives(db, repoId);
    assert.equal(stillOpen.length, 0);
  } finally {
    cleanup(dir);
  }
});

test("decision lifecycle: record → set outcome → query", () => {
  const { db, dir, repoId } = freshDb();
  try {
    const d = recordDecision(db, {
      repoId,
      decisionType: "create_issue",
      rationale: "addresses observability gap",
      payload: { title: "Add /metrics" },
    });
    assert.equal(d.outcome, "pending");
    assert.deepEqual(d.payload, { title: "Add /metrics" });

    const pending = pendingDecisions(db, repoId);
    assert.equal(pending.length, 1);

    setDecisionOutcome(db, d.id, "executed", "issue #42 created");
    const updated = recentDecisions(db, repoId, 10);
    assert.equal(updated[0].outcome, "executed");
    assert.equal(updated[0].outcomeDetails, "issue #42 created");
    assert.equal(pendingDecisions(db, repoId).length, 0);
  } finally {
    cleanup(dir);
  }
});

test("budget gate: paused → blocked", () => {
  const { db, dir, repoId } = freshDb();
  try {
    const cfg = {
      initial_daily_usd: 2.0,
      initial_weekly_usd: 10.0,
      max_daily_usd: 10.0,
      max_weekly_usd: 50.0,
      think_daily_usd: 1.0,
      pause_on_failure_streak: 3,
      good_outcome_quarantine_days: 7,
    };
    let state = ensureBudgetState(db, repoId, cfg);
    assert.equal(checkBudgetGate(state, cfg).ok, true);

    pause(db, repoId, "manual test pause");
    state = ensureBudgetState(db, repoId, cfg);
    const gate = checkBudgetGate(state, cfg);
    assert.equal(gate.ok, false);
    assert.match(gate.reason, /paused/);

    unpause(db, repoId);
    state = ensureBudgetState(db, repoId, cfg);
    assert.equal(checkBudgetGate(state, cfg).ok, true);
  } finally {
    cleanup(dir);
  }
});

test("budget gate: failure_streak >= threshold → blocked", () => {
  const { db, dir, repoId } = freshDb();
  try {
    const cfg = {
      initial_daily_usd: 2.0,
      initial_weekly_usd: 10.0,
      max_daily_usd: 10.0,
      max_weekly_usd: 50.0,
      think_daily_usd: 1.0,
      pause_on_failure_streak: 3,
      good_outcome_quarantine_days: 7,
    };
    ensureBudgetState(db, repoId, cfg);
    bumpFailureStreak(db, repoId);
    bumpFailureStreak(db, repoId);
    let state = ensureBudgetState(db, repoId, cfg);
    assert.equal(checkBudgetGate(state, cfg).ok, true, "2 < 3, still ok");
    bumpFailureStreak(db, repoId);
    state = ensureBudgetState(db, repoId, cfg);
    assert.equal(checkBudgetGate(state, cfg).ok, false, "3 trips the gate");

    resetFailureStreak(db, repoId);
    state = ensureBudgetState(db, repoId, cfg);
    assert.equal(checkBudgetGate(state, cfg).ok, true);
  } finally {
    cleanup(dir);
  }
});

test("budget gate: think and project spend caps", () => {
  const { db, dir, repoId } = freshDb();
  try {
    const cfg = {
      initial_daily_usd: 2.0,
      initial_weekly_usd: 10.0,
      max_daily_usd: 10.0,
      max_weekly_usd: 50.0,
      think_daily_usd: 1.0,
      pause_on_failure_streak: 3,
      good_outcome_quarantine_days: 7,
    };
    ensureBudgetState(db, repoId, cfg);
    recordThinkSpend(db, repoId, 1.5); // exceeds think cap
    let state = ensureBudgetState(db, repoId, cfg);
    const gate1 = checkBudgetGate(state, cfg);
    assert.equal(gate1.ok, false);
    assert.match(gate1.reason, /think budget/);

    // Reset by pretending day rolled over (manual hack: zero the column)
    db.prepare(
      `UPDATE director_budget_state SET spent_today_think_usd = 0 WHERE repo_id = ?`,
    ).run(repoId);
    recordProjectSpend(db, repoId, 5.0); // exceeds initial_daily
    state = ensureBudgetState(db, repoId, cfg);
    const gate2 = checkBudgetGate(state, cfg);
    assert.equal(gate2.ok, false);
    assert.match(gate2.reason, /daily project budget/);
  } finally {
    cleanup(dir);
  }
});
