import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("cadence: parseDurationMs handles s/m/h/d", async () => {
  const { parseDurationMs } = await import("../dist/scheduler/cadence.js");
  assert.equal(parseDurationMs("30s"), 30_000);
  assert.equal(parseDurationMs("5m"), 300_000);
  assert.equal(parseDurationMs("2h"), 7_200_000);
  assert.equal(parseDurationMs("7d"), 604_800_000);
  assert.throws(() => parseDurationMs("5x"));
  assert.throws(() => parseDurationMs("abc"));
});

test("cadence: bucketFor returns hot/default/cold by age", async () => {
  const { bucketFor } = await import("../dist/scheduler/cadence.js");
  const now = new Date("2026-04-27T12:00:00Z");
  assert.equal(bucketFor("2026-04-27T11:00:00Z", now), "hot"); // 1h
  assert.equal(bucketFor("2026-03-01T12:00:00Z", now), "default"); // ~57d
  assert.equal(bucketFor("2025-04-27T12:00:00Z", now), "cold"); // 1y
});

test("cadence: isDue treats null as due, future as not-due", async () => {
  const { isDue } = await import("../dist/scheduler/cadence.js");
  const now = new Date();
  assert.equal(isDue(null, now), true);
  assert.equal(isDue(new Date(now.getTime() - 1000).toISOString(), now), true);
  assert.equal(isDue(new Date(now.getTime() + 60_000).toISOString(), now), false);
});

test("liftTransientPark: lifts error/dirty to cancelled, leaves human-gated statuses untouched", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "aidev-lift-"));
  try {
    const { initDb } = await import("../dist/storage/db.js");
    const { ensureRepo, upsertTask } = await import("../dist/storage/tasks.js");
    const { recordPrBranch, liftTransientPark, getPrBranchByTask } =
      await import("../dist/storage/pr-branches.js");

    const db = initDb(tmp);
    const repoId = ensureRepo(db, { provider: "github", owner: "o", name: "n" });

    // Task with error status — should be lifted
    const t1 = upsertTask(db, repoId, "11", "issue");
    recordPrBranch(db, { taskId: t1, branch: "openronin/11", status: "error" });
    assert.equal(liftTransientPark(db, t1), true, "returns true when a row was updated");
    assert.equal(getPrBranchByTask(db, t1)?.status, "cancelled");

    // Task with dirty status — should be lifted
    const t2 = upsertTask(db, repoId, "12", "issue");
    recordPrBranch(db, { taskId: t2, branch: "openronin/12", status: "dirty" });
    assert.equal(liftTransientPark(db, t2), true);
    assert.equal(getPrBranchByTask(db, t2)?.status, "cancelled");

    // Task with guardrail_blocked — must NOT be lifted
    const t3 = upsertTask(db, repoId, "13", "issue");
    recordPrBranch(db, { taskId: t3, branch: "openronin/13", status: "guardrail_blocked" });
    assert.equal(liftTransientPark(db, t3), false, "returns false when nothing changed");
    assert.equal(getPrBranchByTask(db, t3)?.status, "guardrail_blocked");

    // Task with needs_human — must NOT be lifted
    const t4 = upsertTask(db, repoId, "14", "issue");
    recordPrBranch(db, { taskId: t4, branch: "openronin/14", status: "needs_human" });
    assert.equal(liftTransientPark(db, t4), false);
    assert.equal(getPrBranchByTask(db, t4)?.status, "needs_human");

    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("TRANSIENT_PARK_STATUSES excludes human-gated statuses", async () => {
  const { TRANSIENT_PARK_STATUSES } = await import("../dist/scheduler/worker.js");
  assert.ok(TRANSIENT_PARK_STATUSES.has("error"));
  assert.ok(TRANSIENT_PARK_STATUSES.has("dirty"));
  assert.ok(!TRANSIENT_PARK_STATUSES.has("guardrail_blocked"));
  assert.ok(!TRANSIENT_PARK_STATUSES.has("needs_human"));
  assert.ok(!TRANSIENT_PARK_STATUSES.has("no_changes"));
});

test("queue: dequeue picks high priority then earliest due, marks running", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "aidev-queue-"));
  try {
    const { initDb } = await import("../dist/storage/db.js");
    const { ensureRepo, upsertTask } = await import("../dist/storage/tasks.js");
    const { enqueue, dequeue, queueStats } = await import("../dist/scheduler/queue.js");

    const db = initDb(tmp);
    const repoId = ensureRepo(db, { provider: "github", owner: "o", name: "n" });
    const t1 = upsertTask(db, repoId, "1", "issue");
    const t2 = upsertTask(db, repoId, "2", "issue");
    const t3 = upsertTask(db, repoId, "3", "issue");

    enqueue(db, t1, "normal", new Date(Date.now() - 60_000).toISOString());
    enqueue(db, t2, "high", null);
    enqueue(db, t3, "normal", new Date(Date.now() + 3_600_000).toISOString()); // future

    const stats = queueStats(db);
    assert.equal(stats.pending, 3);
    assert.equal(stats.due, 2);

    const first = dequeue(db);
    assert.equal(first?.id, t2, "high priority wins");
    assert.equal(first?.status, "running");

    const second = dequeue(db);
    assert.equal(second?.id, t1, "earliest due normal task next");

    const third = dequeue(db);
    assert.equal(third, undefined, "future-due task is not yet due");
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
