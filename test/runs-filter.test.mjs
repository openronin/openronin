import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("listRunsFiltered: taskId filter returns only matching task runs", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "aidev-runs-filter-"));
  try {
    const { initDb } = await import("../dist/storage/db.js");
    const { ensureRepo, upsertTask } = await import("../dist/storage/tasks.js");
    const { listRunsFiltered, countRunsFiltered } = await import("../dist/storage/runs.js");

    const db = initDb(tmp);
    const repoId = ensureRepo(db, { provider: "github", owner: "o", name: "n" });
    const taskA = upsertTask(db, repoId, "10", "issue");
    const taskB = upsertTask(db, repoId, "11", "issue");

    db.prepare(
      `INSERT INTO runs (task_id, lane, engine, started_at, status)
       VALUES (?, 'patch', 'claude_code', '2026-05-29T10:00:00Z', 'ok')`,
    ).run(taskA);
    db.prepare(
      `INSERT INTO runs (task_id, lane, engine, started_at, status)
       VALUES (?, 'analyze', 'mimo', '2026-05-29T10:01:00Z', 'error')`,
    ).run(taskA);
    db.prepare(
      `INSERT INTO runs (task_id, lane, engine, started_at, status)
       VALUES (?, 'triage', 'mimo', '2026-05-29T10:02:00Z', 'ok')`,
    ).run(taskB);

    const rowsA = listRunsFiltered(db, { taskId: taskA });
    assert.equal(rowsA.length, 2, "taskA has 2 runs");
    assert.ok(
      rowsA.every((r) => r.task_id === taskA),
      "all rows belong to taskA",
    );

    const rowsB = listRunsFiltered(db, { taskId: taskB });
    assert.equal(rowsB.length, 1, "taskB has 1 run");
    assert.equal(rowsB[0].lane, "triage");

    const countA = countRunsFiltered(db, { taskId: taskA });
    assert.equal(countA, 2, "countRunsFiltered returns 2 for taskA");

    const errorOnly = listRunsFiltered(db, { taskId: taskA, status: "error" });
    assert.equal(errorOnly.length, 1, "taskA error-only: 1 run");
    assert.equal(errorOnly[0].lane, "analyze");

    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
