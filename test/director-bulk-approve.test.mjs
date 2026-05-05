// Bulk approve via /approve-all slash command.
//
// We can't easily test the HTTP route in isolation (admin-director.ts is
// large and pulls Hono routing). Instead, exercise the slash-command path
// against a freshly-seeded DB with a stub VcsProvider. That covers the
// same approveDecision loop as the HTTP handler.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initDb } from "../dist/storage/db.js";
import { ensureBudgetState } from "../dist/director/budget.js";
import { recordDecision, pendingDecisions } from "../dist/director/decisions.js";
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

const sampleDirector = {
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
};

const sampleRepo = {
  provider: "github",
  owner: "openronin",
  name: "openronin",
  watched: true,
  lanes: ["triage"],
  director: sampleDirector,
};

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "openronin-bulk-test-"));
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

test("parseSlashCommand: /approve-all maps to approve_all", () => {
  assert.equal(parseSlashCommand("/approve-all").name, "approve_all");
  assert.equal(parseSlashCommand("/approveall").name, "approve_all");
  assert.equal(parseSlashCommand("/APPROVE-ALL").name, "approve_all");
});

test("/approve-all on empty queue echoes 'no pending decisions'", async () => {
  const { db, dir, repoId } = freshDb();
  ensureBudgetState(db, repoId, sampleBudget);
  try {
    const r = await runSlashCommand({
      db,
      repo: sampleRepo,
      repoId,
      cmd: { name: "approve_all", args: "" },
      dataDir: dir,
    });
    assert.match(r.echo, /no pending decisions/);
  } finally {
    cleanup(dir);
  }
});

test("/approve-all with ask_user proposals: each runs (no VCS needed) → executed", async () => {
  const { db, dir, repoId } = freshDb();
  ensureBudgetState(db, repoId, sampleBudget);
  try {
    // ask_user doesn't need approval (per executor.decisionNeedsApproval),
    // so this exercises the loop without any real network. Three rows
    // pending, all should land executed.
    for (let i = 0; i < 3; i++) {
      recordDecision(db, {
        repoId,
        decisionType: "ask_user",
        rationale: `clarifying question #${i} for charter ambiguity`,
        payload: { question: `which is more important right now? (#${i})` },
        outcome: "pending",
      });
    }
    assert.equal(pendingDecisions(db, repoId).length, 3);

    const r = await runSlashCommand({
      db,
      repo: sampleRepo,
      repoId,
      cmd: { name: "approve_all", args: "" },
      dataDir: dir,
    });
    assert.match(r.echo, /3\/3 executed/);
    assert.equal(pendingDecisions(db, repoId).length, 0);
  } finally {
    cleanup(dir);
  }
});
