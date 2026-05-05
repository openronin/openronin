// Slash commands in the admin chat composer.
//
// Verifies:
//   • parseSlashCommand recognises /tick /pause /resume /status /budget /help /digest
//   • non-slash text is ignored
//   • runSlashCommand /tick clears last_tick_at
//   • runSlashCommand /pause sets paused=1; /resume clears it
//   • runSlashCommand /status returns a non-empty echo

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initDb } from "../dist/storage/db.js";
import { ensureBudgetState } from "../dist/director/budget.js";
import { parseSlashCommand, runSlashCommand } from "../dist/server/slash-commands.js";

const sampleBudget = {
  initial_daily_usd: 2.0,
  initial_weekly_usd: 10.0,
  max_daily_usd: 10.0,
  max_weekly_usd: 50.0,
  think_daily_usd: 1.0,
  pause_on_failure_streak: 3,
  good_outcome_quarantine_days: 7,
};

const sampleRepo = {
  provider: "github",
  owner: "openronin",
  name: "openronin",
  watched: true,
  lanes: ["triage"],
  director: {
    enabled: true,
    mode: "propose",
    cadence_hours: 6,
    bot_prefix: "👔 director:",
    language: "English",
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
  },
};

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "openronin-slash-test-"));
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

test("parseSlashCommand: known commands", () => {
  assert.equal(parseSlashCommand("/tick").name, "tick");
  assert.equal(parseSlashCommand("/pause urgent fire").name, "pause");
  assert.equal(parseSlashCommand("/pause urgent fire").args, "urgent fire");
  assert.equal(parseSlashCommand("/HELP").name, "help");
});

test("parseSlashCommand: unknown command → null", () => {
  assert.equal(parseSlashCommand("/foobar"), null);
});

test("parseSlashCommand: non-slash text → null", () => {
  assert.equal(parseSlashCommand("tick the project"), null);
  assert.equal(parseSlashCommand("hello world"), null);
});

test("runSlashCommand /tick: clears last_tick_at", async () => {
  const { db, dir, repoId } = freshDb();
  ensureBudgetState(db, repoId, sampleBudget);
  // Bump last_tick_at so we can verify it gets cleared.
  db.prepare(
    `UPDATE director_budget_state SET last_tick_at = datetime('now') WHERE repo_id = ?`,
  ).run(repoId);
  try {
    await runSlashCommand({
      db,
      repo: sampleRepo,
      repoId,
      cmd: { name: "tick", args: "" },
      dataDir: dir,
    });
    const state = ensureBudgetState(db, repoId, sampleBudget);
    assert.equal(state.lastTickAt, null);
  } finally {
    cleanup(dir);
  }
});

test("runSlashCommand /pause + /resume: toggles paused flag", async () => {
  const { db, dir, repoId } = freshDb();
  ensureBudgetState(db, repoId, sampleBudget);
  try {
    await runSlashCommand({
      db,
      repo: sampleRepo,
      repoId,
      cmd: { name: "pause", args: "going to lunch" },
      dataDir: dir,
    });
    let state = ensureBudgetState(db, repoId, sampleBudget);
    assert.equal(state.paused, true);
    assert.match(state.pauseReason ?? "", /going to lunch/);

    await runSlashCommand({
      db,
      repo: sampleRepo,
      repoId,
      cmd: { name: "resume", args: "" },
      dataDir: dir,
    });
    state = ensureBudgetState(db, repoId, sampleBudget);
    assert.equal(state.paused, false);
  } finally {
    cleanup(dir);
  }
});

test("runSlashCommand /status: echoes mode and budget", async () => {
  const { db, dir, repoId } = freshDb();
  ensureBudgetState(db, repoId, sampleBudget);
  try {
    const r = await runSlashCommand({
      db,
      repo: sampleRepo,
      repoId,
      cmd: { name: "status", args: "" },
      dataDir: dir,
    });
    assert.match(r.echo, /Status/);
    assert.match(r.echo, /propose/);
  } finally {
    cleanup(dir);
  }
});
