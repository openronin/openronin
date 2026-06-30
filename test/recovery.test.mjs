import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("recovery report: write/read roundtrip + age calculation", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "aidev-recovery-"));
  try {
    const { writeRecoveryReport, readRecoveryReport, recoveryReportAgeSec } =
      await import("../dist/storage/recovery.js");
    const ts = new Date(Date.now() - 5000).toISOString();
    const path = writeRecoveryReport(tmp, {
      ts,
      recovered: true,
      tasks: 2,
      runs: 1,
      deploys: 0,
      clean_shutdown: false,
    });
    assert.ok(existsSync(path), "report file written");

    const back = readRecoveryReport(tmp);
    assert.ok(back, "report read back");
    assert.equal(back.ts, ts);
    assert.equal(back.recovered, true);
    assert.equal(back.tasks, 2);
    assert.equal(back.runs, 1);
    assert.equal(back.deploys, 0);
    assert.equal(back.clean_shutdown, false);

    const age = recoveryReportAgeSec(back);
    assert.ok(age >= 4 && age <= 10, `age ~5s, got ${age}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("recovery report: read returns null when missing or malformed", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "aidev-recovery-"));
  try {
    const { readRecoveryReport } = await import("../dist/storage/recovery.js");
    assert.equal(readRecoveryReport(tmp), null, "missing file → null");

    // Write a malformed file
    const { mkdirSync } = await import("node:fs");
    const dir = resolve(tmp, "recovery");
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "last.json"), "{not json");
    assert.equal(readRecoveryReport(tmp), null, "malformed file → null");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("recoverStuckTasks: writes a clean-shutdown report when nothing was running", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "aidev-recovery-"));
  try {
    const { initDb } = await import("../dist/storage/db.js");
    const { recoverStuckTasks } = await import("../dist/scheduler/index.js");
    const { readRecoveryReport } = await import("../dist/storage/recovery.js");
    const db = initDb(tmp);
    const result = recoverStuckTasks(db, { dataDir: tmp });
    assert.equal(result.tasks, 0);
    assert.equal(result.runs, 0);
    assert.equal(result.deploys, 0);
    const report = readRecoveryReport(tmp);
    assert.ok(report, "report written even on clean boot");
    assert.equal(report.recovered, false);
    assert.equal(report.clean_shutdown, true);
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("recoverStuckTasks: marks orphaned runs/tasks and reports counts", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "aidev-recovery-"));
  try {
    const { initDb } = await import("../dist/storage/db.js");
    const { ensureRepo, upsertTask } = await import("../dist/storage/tasks.js");
    const { recoverStuckTasks } = await import("../dist/scheduler/index.js");
    const { readRecoveryReport } = await import("../dist/storage/recovery.js");
    const { createRun } = await import("../dist/storage/runs.js");

    const db = initDb(tmp);
    const repoId = ensureRepo(db, { provider: "github", owner: "o", name: "n" });
    const t = upsertTask(db, repoId, "1", "issue");
    db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(t);
    const runId = createRun(db, { taskId: t, lane: "patch", engine: "claude_code" });

    const result = recoverStuckTasks(db, { dataDir: tmp });
    assert.equal(result.tasks, 1, "one task reset");
    assert.equal(result.runs, 1, "one run closed as error");
    const report = readRecoveryReport(tmp);
    assert.ok(report);
    assert.equal(report.recovered, true);
    assert.equal(report.tasks, 1);
    assert.equal(report.runs, 1);
    assert.equal(report.clean_shutdown, false);

    // Task is back to pending and the run is closed with the crash marker.
    const task = db.prepare("SELECT status FROM tasks WHERE id = ?").get(t);
    assert.equal(task.status, "pending");
    const run = db.prepare("SELECT status, error FROM runs WHERE id = ?").get(runId);
    assert.equal(run.status, "error");
    assert.ok(run.error.includes("crash recovery"));
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("healthz: enriched response includes active_runs/queued_runs/last_recovery and ok status", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "aidev-recovery-"));
  try {
    const { initDb } = await import("../dist/storage/db.js");
    const { buildHealthz } = await import("../dist/server/healthz.js");
    const { writeRecoveryReport } = await import("../dist/storage/recovery.js");
    const { loadConfig } = await import("../dist/config/loader.js");

    const db = initDb(tmp);
    writeRecoveryReport(tmp, {
      ts: new Date().toISOString(),
      recovered: false,
      tasks: 0,
      runs: 0,
      deploys: 0,
      clean_shutdown: true,
    });
    process.env.OPENRONIN_DATA_DIR = tmp;
    const config = loadConfig({ dataDir: tmp });

    const body = buildHealthz({ db, startedAt: Date.now() - 12_000, getConfig: () => config });
    assert.equal(body.status, "ok");
    assert.equal(body.db_ok, true);
    assert.equal(body.active_runs, 0);
    assert.equal(body.queued_runs, 0);
    assert.ok(body.last_recovery, "last_recovery block present");
    assert.equal(body.last_recovery.clean_shutdown, true);
    assert.ok(body.uptime_s >= 10);
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("healthz: reports active_runs when a row is in 'running' state", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "aidev-recovery-"));
  try {
    const { initDb } = await import("../dist/storage/db.js");
    const { ensureRepo, upsertTask } = await import("../dist/storage/tasks.js");
    const { createRun } = await import("../dist/storage/runs.js");
    const { buildHealthz } = await import("../dist/server/healthz.js");
    const { loadConfig } = await import("../dist/config/loader.js");

    const db = initDb(tmp);
    const repoId = ensureRepo(db, { provider: "github", owner: "o", name: "n" });
    const t = upsertTask(db, repoId, "7", "issue");
    createRun(db, { taskId: t, lane: "patch", engine: "claude_code" });

    process.env.OPENRONIN_DATA_DIR = tmp;
    const config = loadConfig({ dataDir: tmp });
    const body = buildHealthz({ db, startedAt: Date.now(), getConfig: () => config });
    assert.equal(body.active_runs, 1);
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("healthz: returns down + 503 when DB has been closed", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "aidev-recovery-"));
  try {
    const { initDb } = await import("../dist/storage/db.js");
    const { healthzRoute } = await import("../dist/server/healthz.js");
    const { loadConfig } = await import("../dist/config/loader.js");

    const db = initDb(tmp);
    db.close();
    process.env.OPENRONIN_DATA_DIR = tmp;
    const config = loadConfig({ dataDir: tmp });
    const app = healthzRoute({ db, startedAt: Date.now(), getConfig: () => config });
    const res = await app.request("/");
    assert.equal(res.status, 503, "DB unreachable → 503");
    const body = await res.json();
    assert.equal(body.status, "down");
    assert.equal(body.db_ok, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("recovery report: write is atomic (no .tmp leftover after success)", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "aidev-recovery-"));
  try {
    const { writeRecoveryReport } = await import("../dist/storage/recovery.js");
    writeRecoveryReport(tmp, {
      ts: new Date().toISOString(),
      recovered: false,
      tasks: 0,
      runs: 0,
      deploys: 0,
      clean_shutdown: true,
    });
    const final = resolve(tmp, "recovery", "last.json");
    const tmpFile = resolve(tmp, "recovery", "last.json.tmp");
    assert.ok(existsSync(final), "final file present");
    assert.ok(!existsSync(tmpFile), "no .tmp residue");
    const raw = JSON.parse(readFileSync(final, "utf8"));
    assert.equal(raw.clean_shutdown, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
