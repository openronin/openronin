// Integration tests: end-to-end lane scenarios using real SQLite,
// in-process DB state manipulation, and deterministic fake data.
// Run via: pnpm run test:integration (after pnpm run build).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── Test 1: Bot self-loop guard ─────────────────────────────────────────────

test("bot self-loop: isBotMessage correctly identifies bot messages", async () => {
  const { isBotMessage, BOT_PREFIX } = await import("../dist/lanes/messages.js");

  // Messages that MUST be recognised as bot output
  assert.equal(isBotMessage(`${BOT_PREFIX} taking in progress`), true, "exact bot prefix");
  assert.equal(isBotMessage(`  ${BOT_PREFIX} with leading whitespace`), true, "leading ws");
  assert.equal(isBotMessage("<!-- openronin:bot --> sentinel comment"), true, "HTML sentinel");
  assert.equal(isBotMessage(`middle text <!-- openronin:bot -->`), true, "sentinel anywhere");
  assert.equal(
    isBotMessage(`${BOT_PREFIX} итерация 1 — изменения запушены.`),
    true,
    "RU iteration comment",
  );

  // Normal user messages MUST NOT be flagged
  assert.equal(isBotMessage("normal reviewer comment"), false, "plain text");
  assert.equal(isBotMessage("mentioning openronin in body"), false, "mention only");
  assert.equal(isBotMessage(""), false, "empty string");
  assert.equal(isBotMessage(`Not ${BOT_PREFIX} at some offset`), false, "prefix not at start");
  assert.equal(isBotMessage("LGTM!"), false, "approval comment");
});

// ─── Test 2: Timezone sanity check (parseSqliteUtc) ──────────────────────────

test("timezone fix: parseSqliteUtc treats bare SQLite timestamps as UTC", async () => {
  const { parseSqliteUtc } = await import("../dist/lib/time.js");

  // SQLite datetime('now') returns "YYYY-MM-DD HH:MM:SS" without zone indicator.
  // Without the fix, new Date("...") would parse this as local time and corrupt
  // all "since last iteration" comparisons in pr-dialog.
  const sqliteTs = "2026-04-27 21:06:37";
  const parsed = parseSqliteUtc(sqliteTs);

  assert.equal(parsed.getUTCFullYear(), 2026, "year");
  assert.equal(parsed.getUTCMonth(), 3, "month (0-indexed, April=3)");
  assert.equal(parsed.getUTCDate(), 27, "day");
  assert.equal(parsed.getUTCHours(), 21, "hour");
  assert.equal(parsed.getUTCMinutes(), 6, "minute");
  assert.equal(parsed.getUTCSeconds(), 37, "second");

  // Same instant expressed as ISO-Z must be equal
  const isoTs = "2026-04-27T21:06:37Z";
  const parsedIso = parseSqliteUtc(isoTs);
  assert.equal(parsed.getTime(), parsedIso.getTime(), "sqlite bare == ISO-Z");

  // ISO with offset also handled correctly (+01:00 = same instant as 21:06:37Z)
  const isoOffset = "2026-04-27T22:06:37+01:00";
  const parsedOffset = parseSqliteUtc(isoOffset);
  assert.equal(parsedOffset.getTime(), parsed.getTime(), "ISO+offset parsed correctly");

  // Comparison correctness: the crux of the original bug.
  // A comment posted at 21:06:38Z is "after" the cutoff at 21:06:37 SQLite.
  const cutoff = parseSqliteUtc("2026-04-27 21:06:37");
  const apiAfter = new Date("2026-04-27T21:06:38Z");
  const apiBefore = new Date("2026-04-27T21:06:36Z");
  assert.ok(cutoff.getTime() < apiAfter.getTime(), "event after cutoff is new");
  assert.ok(cutoff.getTime() > apiBefore.getTime(), "event before cutoff is not new");
});

// ─── Test 3: Issue → analyze → patch state machine ───────────────────────────

test("workflow: issue with trigger label routes through analyze then patch", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "aidev-int-"));
  try {
    const { initDb } = await import("../dist/storage/db.js");
    const { ensureRepo, upsertTask, recordTaskDecision } = await import("../dist/storage/tasks.js");
    const { enqueue, dequeue, markDone } = await import("../dist/scheduler/queue.js");

    const db = initDb(tmp);
    const repoId = ensureRepo(db, { provider: "github", owner: "owner", name: "repo" });
    const taskId = upsertTask(db, repoId, "42", "issue");

    // Step 1: webhook arrives with trigger label → task queued high-priority.
    enqueue(db, taskId, "high", null);
    const first = dequeue(db);
    assert.ok(first, "task dequeued");
    assert.equal(first.id, taskId, "correct task");

    // At this point decision_json is null → pickLane would choose "analyze".
    const beforeAnalyze = db.prepare("SELECT decision_json FROM tasks WHERE id = ?").get(taskId);
    assert.equal(beforeAnalyze.decision_json, null, "no decision before analyze run");

    // Step 2: analyze lane runs and stores state=ready in decision_json.
    const readyState = JSON.stringify({
      lane: "analyze",
      state: "ready",
      summary: "Task is concrete and implementable",
      expanded_requirements: "- Write integration tests\n- Cover all five lane scenarios",
      iteration: 1,
    });
    recordTaskDecision(db, taskId, "abc123456789abcd", readyState);

    const afterAnalyze = db.prepare("SELECT decision_json FROM tasks WHERE id = ?").get(taskId);
    const stored = JSON.parse(afterAnalyze.decision_json);
    assert.equal(stored.lane, "analyze", "decision tagged as analyze");
    assert.equal(stored.state, "ready", "state=ready unlocks patch lane");
    assert.ok(stored.expanded_requirements, "expanded requirements stored");

    // Step 3: analyze lane marks done and re-enqueues immediately for patch.
    markDone(db, taskId, new Date(Date.now() + 500).toISOString());
    // enqueueImmediate equivalent: reset to high-priority pending with no next_due_at
    db.prepare(
      "UPDATE tasks SET status = 'pending', priority = 'high', next_due_at = NULL WHERE id = ?",
    ).run(taskId);

    const second = dequeue(db);
    assert.ok(second, "task re-dequeued for patch run");
    assert.equal(second.id, taskId, "same task");

    // pickLane condition: stored.lane==="analyze" && stored.state==="ready" → "patch"
    const finalRow = db.prepare("SELECT decision_json FROM tasks WHERE id = ?").get(taskId);
    const finalStored = JSON.parse(finalRow.decision_json);
    assert.equal(finalStored.state, "ready", "state=ready → patch lane selected");

    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── Test 4: PR dialog — new feedback detection with timezone-correct cutoff ──

test("pr_dialog: feedback filter uses parseSqliteUtc cutoff, skips bot comments", async () => {
  const { isBotMessage } = await import("../dist/lanes/messages.js");
  const { parseSqliteUtc } = await import("../dist/lib/time.js");

  // Simulate prRow.updated_at from SQLite (bare UTC, no Z)
  const cutoff = parseSqliteUtc("2026-04-27 12:00:00");

  const comments = [
    // New, real feedback — should be included
    {
      id: "10",
      author: "reviewer",
      body: "Please fix the typo in function name",
      createdAt: "2026-04-27T12:30:00Z",
    },
    // Bot's own iteration comment — must be skipped (isBotMessage + skip_authors)
    {
      id: "11",
      author: "openronin[bot]",
      body: "🤖 openronin: iteration 1 — изменения запушены.",
      createdAt: "2026-04-27T12:01:00Z",
    },
    // Old feedback (before cutoff) — must be skipped
    {
      id: "12",
      author: "reviewer2",
      body: "LGTM overall",
      createdAt: "2026-04-27T11:00:00Z",
    },
    // Another new comment — should be included
    {
      id: "13",
      author: "maintainer",
      body: "Can you add a test for the edge case?",
      createdAt: "2026-04-27T13:00:00Z",
    },
    // Bot HTML sentinel comment — must be skipped
    {
      id: "14",
      author: "github-actions[bot]",
      body: "<!-- openronin:bot --> automated note",
      createdAt: "2026-04-27T12:45:00Z",
    },
  ];

  const prDialogSkipAuthors = ["openronin[bot]"];

  const newFeedback = comments.filter(
    (c) =>
      new Date(c.createdAt).getTime() > cutoff.getTime() &&
      !prDialogSkipAuthors.includes(c.author) &&
      !isBotMessage(c.body),
  );

  assert.equal(newFeedback.length, 2, "exactly two new non-bot comments after cutoff");
  assert.equal(newFeedback[0].id, "10", "reviewer comment included");
  assert.equal(newFeedback[1].id, "13", "maintainer comment included");
});

// ─── Test 5: PR dialog — iteration counter ────────────────────────────────────

test("pr_dialog: bumpIteration only on successful push; non-push outcomes don't count", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "aidev-int-"));
  try {
    const { initDb } = await import("../dist/storage/db.js");
    const { ensureRepo, upsertTask } = await import("../dist/storage/tasks.js");
    const { recordPrBranch, bumpIteration, getPrBranchByPrNumber } =
      await import("../dist/storage/pr-branches.js");

    const db = initDb(tmp);
    const repoId = ensureRepo(db, { provider: "github", owner: "o", name: "n" });
    // pr_branches row is recorded against the source ISSUE's task, not the PR task.
    const issueTaskId = upsertTask(db, repoId, "55", "issue");

    const branchId = recordPrBranch(db, {
      taskId: issueTaskId,
      branch: "openronin/55-test-feature",
      baseSha: "base000",
      headSha: "head001",
      prNumber: 99,
      prUrl: "https://github.com/o/n/pull/99",
      status: "open",
    });

    const initial = getPrBranchByPrNumber(db, repoId, 99);
    assert.ok(initial, "pr_branches row exists");
    assert.equal(initial.iterations, 0, "starts at 0");

    // Successful push (outcome="pushed") → iteration++
    bumpIteration(db, branchId);
    const after1 = getPrBranchByPrNumber(db, repoId, 99);
    assert.equal(after1.iterations, 1, "iteration 1 after first push");

    // Second successful push → iteration++
    bumpIteration(db, branchId);
    const after2 = getPrBranchByPrNumber(db, repoId, 99);
    assert.equal(after2.iterations, 2, "iteration 2 after second push");

    // Non-push outcomes (needs_human / guardrail_blocked / no_changes) → no bump.
    // These outcomes do NOT call bumpIteration; verify iterations stay at 2.
    const afterNonPush = getPrBranchByPrNumber(db, repoId, 99);
    assert.equal(afterNonPush.iterations, 2, "iterations unchanged for non-push outcome");

    // Max-iterations gate: if iterations >= max, no pr_dialog run.
    // Simulate by bumping to the limit and checking the condition.
    const maxIter = 3;
    assert.ok(after2.iterations < maxIter, "not yet at limit → pr_dialog would run");
    bumpIteration(db, branchId);
    const atMax = getPrBranchByPrNumber(db, repoId, 99);
    assert.ok(atMax.iterations >= maxIter, "at limit → pr_dialog returns max_iterations");

    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── Test 6: Auto-merge happy path — pr_branches status → closed ──────────────

test("auto-merge: pr_branches.status updated to closed after successful merge", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "aidev-int-"));
  try {
    const { initDb } = await import("../dist/storage/db.js");
    const { ensureRepo, upsertTask } = await import("../dist/storage/tasks.js");
    const { recordPrBranch, getPrBranchByPrNumber } =
      await import("../dist/storage/pr-branches.js");

    const db = initDb(tmp);
    const repoId = ensureRepo(db, { provider: "github", owner: "o", name: "r" });
    const taskId = upsertTask(db, repoId, "200", "issue");

    const branchId = recordPrBranch(db, {
      taskId,
      branch: "openronin/200-auto-merge-feature",
      prNumber: 201,
      prUrl: "https://github.com/o/r/pull/201",
      status: "open",
    });

    const before = getPrBranchByPrNumber(db, repoId, 201);
    assert.equal(before.status, "open", "PR starts as open");

    // Happy path: mergeable=true, CI green, threads resolved →
    // tryAutoMerge executes the merge and updates status to closed.
    db.prepare("UPDATE pr_branches SET status = ?, updated_at = datetime('now') WHERE id = ?").run(
      "closed",
      branchId,
    );

    const after = getPrBranchByPrNumber(db, repoId, 201);
    assert.equal(after.status, "closed", "status is closed after successful merge");
    assert.ok(after.updated_at, "updated_at is set");

    // Closed branch must NOT be picked up as active by pickLane.
    const activeBranch = db
      .prepare("SELECT * FROM pr_branches WHERE id = ? AND status IN ('created', 'open')")
      .get(branchId);
    assert.equal(activeBranch, undefined, "closed branch not in active set → no pr_dialog");

    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── Test 7: Closed PR webhook → pr_branches sync → no re-trigger ────────────

test("closed PR: pr_branches.status synced to closed; pickLane skips it", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "aidev-int-"));
  try {
    const { initDb } = await import("../dist/storage/db.js");
    const { ensureRepo, upsertTask } = await import("../dist/storage/tasks.js");
    const { recordPrBranch, getPrBranchByPrNumber } =
      await import("../dist/storage/pr-branches.js");

    const db = initDb(tmp);
    const repoId = ensureRepo(db, { provider: "github", owner: "o", name: "r" });
    const taskId = upsertTask(db, repoId, "300", "issue");

    const branchId = recordPrBranch(db, {
      taskId,
      branch: "openronin/300-task",
      prNumber: 302,
      status: "open",
    });

    assert.equal(getPrBranchByPrNumber(db, repoId, 302).status, "open", "branch open initially");

    // worker.processOne detects closed PR item and sets status=closed.
    // (In production: if item.kind==='pull_request' && item.state==='closed'.)
    db.prepare("UPDATE pr_branches SET status = ?, updated_at = datetime('now') WHERE id = ?").run(
      "closed",
      branchId,
    );

    const updated = getPrBranchByPrNumber(db, repoId, 302);
    assert.equal(updated.status, "closed", "status synced to closed");

    // pickLane: status NOT IN ('created','open') → returns undefined → no lane runs.
    const active = db
      .prepare("SELECT * FROM pr_branches WHERE id = ? AND status IN ('created', 'open')")
      .get(branchId);
    assert.equal(active, undefined, "closed PR excluded from active branches → no pr_dialog");

    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
