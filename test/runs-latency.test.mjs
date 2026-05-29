import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("getAvgLatencyByLane: groups by lane, excludes running rows", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "aidev-latency-"));
  try {
    const { initDb } = await import("../dist/storage/db.js");
    const { ensureRepo, upsertTask } = await import("../dist/storage/tasks.js");
    const { createRun, getAvgLatencyByLane } = await import("../dist/storage/runs.js");

    const db = initDb(tmp);
    const repoId = ensureRepo(db, { provider: "github", owner: "o", name: "n" });
    const taskId = upsertTask(db, repoId, "1", "issue");

    // Insert a completed patch run (~10 s) via raw SQL for precise timing control
    db.prepare(
      `INSERT INTO runs (task_id, lane, engine, started_at, finished_at, status)
       VALUES (?, 'patch', 'claude_code', '2026-05-29T10:00:00Z', '2026-05-29T10:00:10Z', 'ok')`,
    ).run(taskId);

    // Insert another completed patch run (~20 s)
    db.prepare(
      `INSERT INTO runs (task_id, lane, engine, started_at, finished_at, status)
       VALUES (?, 'patch', 'claude_code', '2026-05-29T10:01:00Z', '2026-05-29T10:01:20Z', 'ok')`,
    ).run(taskId);

    // Insert a triage run (~5 s)
    db.prepare(
      `INSERT INTO runs (task_id, lane, engine, started_at, finished_at, status)
       VALUES (?, 'triage', 'mimo', '2026-05-29T10:00:00Z', '2026-05-29T10:00:05Z', 'ok')`,
    ).run(taskId);

    // Insert a running row (finished_at IS NULL) — must be excluded from latency
    db.prepare(
      `INSERT INTO runs (task_id, lane, engine, started_at, finished_at, status)
       VALUES (?, 'patch', 'claude_code', '2026-05-29T10:02:00Z', NULL, 'running')`,
    ).run(taskId);

    const since = "2026-01-01T00:00:00Z";
    const rows = getAvgLatencyByLane(db, since);

    // patch: avg of 10 and 20 = 15 s
    const patch = rows.find((r) => r.lane === "patch");
    assert.ok(patch, "patch lane present");
    assert.ok(Math.abs(patch.avg_seconds - 15) < 0.5, `patch avg ~15s, got ${patch.avg_seconds}`);
    assert.equal(patch.runs, 2, "running row excluded");

    // triage: 5 s
    const triage = rows.find((r) => r.lane === "triage");
    assert.ok(triage, "triage lane present");
    assert.ok(Math.abs(triage.avg_seconds - 5) < 0.5, `triage avg ~5s, got ${triage.avg_seconds}`);
    assert.equal(triage.runs, 1);

    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("getErrorRateByLane: computes error_rate per lane", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "aidev-errrate-"));
  try {
    const { initDb } = await import("../dist/storage/db.js");
    const { ensureRepo, upsertTask } = await import("../dist/storage/tasks.js");
    const { getErrorRateByLane } = await import("../dist/storage/runs.js");

    const db = initDb(tmp);
    const repoId = ensureRepo(db, { provider: "github", owner: "o", name: "n" });
    const taskId = upsertTask(db, repoId, "2", "issue");

    // patch: 1 ok + 1 error → 50%
    db.prepare(
      `INSERT INTO runs (task_id, lane, engine, started_at, status)
       VALUES (?, 'patch', 'claude_code', '2026-05-29T10:00:00Z', 'ok')`,
    ).run(taskId);
    db.prepare(
      `INSERT INTO runs (task_id, lane, engine, started_at, status)
       VALUES (?, 'patch', 'claude_code', '2026-05-29T10:01:00Z', 'error')`,
    ).run(taskId);

    // triage: 3 ok → 0%
    for (let i = 0; i < 3; i++) {
      db.prepare(
        `INSERT INTO runs (task_id, lane, engine, started_at, status)
         VALUES (?, 'triage', 'mimo', '2026-05-29T10:0${i}:00Z', 'ok')`,
      ).run(taskId);
    }

    const since = "2026-01-01T00:00:00Z";
    const rows = getErrorRateByLane(db, since);

    const patch = rows.find((r) => r.lane === "patch");
    assert.ok(patch, "patch lane present");
    assert.ok(
      Math.abs(patch.error_rate - 0.5) < 0.01,
      `patch error_rate ~0.5, got ${patch.error_rate}`,
    );
    assert.equal(patch.total, 2);

    const triage = rows.find((r) => r.lane === "triage");
    assert.ok(triage, "triage lane present");
    assert.equal(triage.error_rate, 0);
    assert.equal(triage.total, 3);

    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
