import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Harness: a scheduler whose drain is a fake that claims one task via the
// real dequeue() and then blocks until released. Lets us observe how many
// slots run concurrently per repo without touching GitHub or an engine.
async function harness({ globalMax, repoMax, tasks }) {
  const tmp = mkdtempSync(join(tmpdir(), "openronin-maxw-"));
  const { initDb } = await import("../dist/storage/db.js");
  const { ensureRepo, upsertTask } = await import("../dist/storage/tasks.js");
  const { dequeue } = await import("../dist/scheduler/queue.js");
  const { startScheduler } = await import("../dist/scheduler/index.js");
  const { GlobalConfigSchema, RepoConfigSchema } = await import("../dist/config/schema.js");

  const db = initDb(tmp);
  const repo = RepoConfigSchema.parse({
    owner: "o",
    name: "n",
    ...(repoMax !== undefined && { max_workers: repoMax }),
  });
  const config = {
    dataDir: tmp,
    global: GlobalConfigSchema.parse({ scheduler: { max_workers_per_repo: globalMax } }),
    repos: [repo],
  };
  const repoId = ensureRepo(db, repo);
  for (let i = 1; i <= tasks; i++) upsertTask(db, repoId, String(i), "issue");

  const claimed = [];
  const releases = [];
  const drainRepoFn = async (dbArg, _config, rid) => {
    const task = dequeue(dbArg, undefined, { repoId: rid });
    if (!task) return [];
    claimed.push(task.id);
    await new Promise((res) => releases.push(res));
    return [{ taskId: task.id, status: "ok" }];
  };
  const scheduler = startScheduler(db, () => config, {
    reconcileIntervalMs: 3_600_000,
    drainIntervalMs: 3_600_000,
    drainRepoFn,
  });
  const cleanup = async () => {
    for (const r of releases) r();
    await scheduler.stop(2000);
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  };
  return { scheduler, claimed, releases, cleanup };
}

const tick = () => new Promise((res) => setImmediate(res));

test("max_workers: default 1 keeps one slot per repo", async () => {
  const h = await harness({ globalMax: 1, tasks: 3 });
  try {
    void h.scheduler.tickDrain();
    void h.scheduler.tickDrain(); // second tick: no free slot
    await tick();
    assert.equal(h.claimed.length, 1);
    const [w] = h.scheduler.workerStatuses();
    assert.equal(w.running, 1);
    assert.equal(w.maxWorkers, 1);
    assert.equal(w.busy, true);
  } finally {
    await h.cleanup();
  }
});

test("max_workers: per-repo override runs N distinct tasks concurrently", async () => {
  const h = await harness({ globalMax: 1, repoMax: 3, tasks: 5 });
  try {
    void h.scheduler.tickDrain();
    await tick();
    assert.equal(h.claimed.length, 3, "three slots, three tasks");
    assert.equal(new Set(h.claimed).size, 3, "no task claimed twice");
    // Saturated: another tick must not exceed the limit.
    void h.scheduler.tickDrain();
    await tick();
    assert.equal(h.claimed.length, 3);
    assert.equal(h.scheduler.workerStatuses()[0].running, 3);
  } finally {
    await h.cleanup();
  }
});

test("max_workers: extra slots open only for queued work", async () => {
  const h = await harness({ globalMax: 3, tasks: 2 });
  try {
    void h.scheduler.tickDrain();
    await tick();
    assert.equal(h.claimed.length, 2);
    assert.equal(h.scheduler.workerStatuses()[0].running, 2, "no idle third slot");
  } finally {
    await h.cleanup();
  }
});

test("max_workers: a freed slot is refilled on the next tick", async () => {
  const h = await harness({ globalMax: 2, tasks: 3 });
  try {
    void h.scheduler.tickDrain();
    await tick();
    assert.equal(h.claimed.length, 2);
    h.releases[0](); // first slot finishes and exits
    await tick();
    await tick();
    assert.equal(h.scheduler.workerStatuses()[0].running, 1);
    void h.scheduler.tickDrain();
    await tick();
    assert.equal(h.claimed.length, 3, "next tick filled the freed slot");
    assert.equal(h.scheduler.workerStatuses()[0].running, 2);
    assert.equal(new Set(h.claimed).size, 3);
  } finally {
    await h.cleanup();
  }
});

test("maxWorkersFor: repo override beats global", async () => {
  const { maxWorkersFor, GlobalConfigSchema } = await import("../dist/config/schema.js");
  const g = GlobalConfigSchema.parse({ scheduler: { max_workers_per_repo: 2 } });
  assert.equal(maxWorkersFor({}, g), 2);
  assert.equal(maxWorkersFor({ max_workers: 4 }, g), 4);
  assert.equal(GlobalConfigSchema.parse({}).scheduler.max_workers_per_repo, 1);
});

test("proc-mem: samples a process tree including children", async (t) => {
  if (process.platform !== "linux") return t.skip("needs /proc");
  const { sampleTreeBytes, startPeakMemorySampler } = await import("../dist/lib/proc-mem.js");
  // Parent shell with a sleeping child: the tree must weigh more than the
  // parent alone.
  const child = spawn("sh", ["-c", "sleep 5 & wait"], { stdio: "ignore" });
  try {
    await new Promise((res) => setTimeout(res, 200));
    const sampler = startPeakMemorySampler(child.pid, 50);
    await new Promise((res) => setTimeout(res, 150));
    const tree = sampleTreeBytes(child.pid);
    assert.ok(tree > 0, "tree has memory");
    const peak = sampler.stop();
    assert.ok(peak > 0, "sampler recorded a peak");
  } finally {
    child.kill("SIGKILL");
  }
  assert.equal(sampleTreeBytes(2 ** 22 + 12345), undefined, "missing pid → undefined");
});

test("runs: peak memory is stored and aggregated per repo/lane", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "openronin-mem-"));
  try {
    const { initDb } = await import("../dist/storage/db.js");
    const { ensureRepo, upsertTask } = await import("../dist/storage/tasks.js");
    const { createRun, finishRun, getPeakMemByRepoLane } = await import("../dist/storage/runs.js");
    const db = initDb(tmp);
    const repoId = ensureRepo(db, { provider: "github", owner: "o", name: "n" });
    const taskId = upsertTask(db, repoId, "1", "issue");
    const MiB = 1048576;
    for (const mb of [100, 200, 300, 400]) {
      const id = createRun(db, { taskId, lane: "patch", engine: "claude_code" });
      finishRun(db, id, { status: "ok", peakMemBytes: mb * MiB });
    }
    const none = createRun(db, { taskId, lane: "patch", engine: "mimo" });
    finishRun(db, none, { status: "ok" });
    const [g] = getPeakMemByRepoLane(db, "1970-01-01 00:00:00");
    assert.equal(g.repo, "o/n");
    assert.equal(g.runs, 4, "runs without a peak are ignored");
    assert.equal(g.p50, 200 * MiB);
    assert.equal(g.max, 400 * MiB);
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("enqueue: a running task is not re-queued in parallel, it re-runs after finishing", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "openronin-rerun-"));
  try {
    const { initDb } = await import("../dist/storage/db.js");
    const { ensureRepo, upsertTask } = await import("../dist/storage/tasks.js");
    const { dequeue, enqueue, markDone, markError } = await import("../dist/scheduler/queue.js");
    const db = initDb(tmp);
    const repoId = ensureRepo(db, { provider: "github", owner: "o", name: "n" });
    const taskId = upsertTask(db, repoId, "850", "pull_request");
    const row = () => db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);

    assert.equal(dequeue(db, undefined, { repoId })?.id, taskId);
    // A webhook (new PR comment) arrives while the task is running.
    enqueue(db, taskId, "high", null);
    assert.equal(row().status, "running", "running task stays running");
    assert.equal(row().rerun_requested, 1);
    assert.equal(dequeue(db, undefined, { repoId }), undefined, "no second slot can claim it");

    // Run finishes → straight back to the head of the queue, flag cleared.
    markDone(db, taskId, "2999-01-01T00:00:00.000Z");
    assert.equal(row().status, "pending");
    assert.equal(row().next_due_at, null);
    assert.equal(row().priority, "high");
    assert.equal(row().rerun_requested, 0);

    // Without a re-run request markDone behaves as before.
    assert.equal(dequeue(db, undefined, { repoId })?.id, taskId);
    markDone(db, taskId, "2999-01-01T00:00:00.000Z");
    assert.equal(row().status, "done");
    assert.equal(row().next_due_at, "2999-01-01T00:00:00.000Z");

    // A failed run keeps its retry delay (may be a rate-limit cooldown).
    enqueue(db, taskId, "high", null);
    assert.equal(dequeue(db, undefined, { repoId })?.id, taskId);
    enqueue(db, taskId, "high", null);
    markError(db, taskId, "boom", 60_000);
    assert.equal(row().status, "pending");
    assert.notEqual(row().next_due_at, null, "retry delay kept");
    assert.equal(row().rerun_requested, 0);

    // A task that is not running is enqueued exactly as before.
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(taskId);
    enqueue(db, taskId, "normal", null);
    assert.equal(row().status, "pending");
    assert.equal(row().rerun_requested, 0);
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
