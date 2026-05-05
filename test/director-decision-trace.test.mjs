// Per-decision trace storage.
//
// Verifies:
//   • recordDecision persists the trace columns (prompt, response, tokens, latency, engine, model)
//   • capTrace truncates oversized prompts but keeps a marker
//   • runTick stamps every decision in the same tick with the SAME prompt/response
//     (they're all from one LLM call)

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initDb } from "../dist/storage/db.js";
import { recordDecision, getDecisionById, recentDecisions } from "../dist/director/decisions.js";
import { runTick } from "../dist/director/tick.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "openronin-trace-test-"));
  const db = initDb(dir);
  const r = db
    .prepare(
      `INSERT INTO repos (provider, owner, name, watched, config_json)
       VALUES ('github', 'openronin', 'openronin', 1, '{}')
       RETURNING id`,
    )
    .get();
  return { db, dir, repoId: r.id };
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

test("recordDecision: trace columns round-trip", () => {
  const { db, dir, repoId } = freshDb();
  try {
    const created = recordDecision(db, {
      repoId,
      decisionType: "create_issue",
      rationale: "exercising the trace columns end-to-end",
      payload: { title: "test issue" },
      outcome: "pending",
      promptText: "system: be a director\nuser: do something",
      responseText: '{"observations":"x","reasoning":"y","decisions":[]}',
      tokensIn: 1234,
      tokensOut: 567,
      durationMs: 890,
      engineId: "anthropic",
      model: "claude-sonnet-4-6",
    });
    const fetched = getDecisionById(db, created.id);
    assert.equal(fetched.promptText, "system: be a director\nuser: do something");
    assert.match(fetched.responseText, /observations/);
    assert.equal(fetched.tokensIn, 1234);
    assert.equal(fetched.tokensOut, 567);
    assert.equal(fetched.durationMs, 890);
    assert.equal(fetched.engineId, "anthropic");
    assert.equal(fetched.model, "claude-sonnet-4-6");
  } finally {
    cleanup(dir);
  }
});

test("recordDecision: oversized prompt is capped with truncation marker", () => {
  const { db, dir, repoId } = freshDb();
  try {
    const big = "x".repeat(50 * 1024); // 50KB > 32KB cap
    const created = recordDecision(db, {
      repoId,
      decisionType: "create_issue",
      rationale: "checking the cap behaves",
      payload: { title: "cap test" },
      promptText: big,
    });
    const fetched = getDecisionById(db, created.id);
    assert.ok(fetched.promptText.length < big.length);
    assert.match(fetched.promptText, /truncated; original was 51200 chars/);
  } finally {
    cleanup(dir);
  }
});

test("recordDecision: omitted trace fields stay null (manual decisions stay clean)", () => {
  const { db, dir, repoId } = freshDb();
  try {
    const created = recordDecision(db, {
      repoId,
      decisionType: "create_issue",
      rationale: "no trace populated by caller",
      payload: { title: "no trace" },
    });
    const fetched = getDecisionById(db, created.id);
    assert.equal(fetched.promptText, null);
    assert.equal(fetched.responseText, null);
    assert.equal(fetched.tokensIn, null);
    assert.equal(fetched.engineId, null);
  } finally {
    cleanup(dir);
  }
});

const sampleCharter = {
  vision: "Reliable AI dev agent.",
  priorities: [{ id: "x", weight: 1.0, rubric: "y" }],
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

test("runTick: stamps the same trace on every decision in one tick", async () => {
  const { db, dir, repoId } = freshDb();
  try {
    await runTick({
      db,
      repoId,
      repo: sampleRepo,
      director: sampleDirector,
      dataDir: dir,
      engineFactory: () => ({
        id: "mock",
        defaultModel: "mock-1",
        async run(opts) {
          assert.match(opts.systemPrompt, /Director|product owner/);
          return {
            content: '{"observations":"...","reasoning":"...","decisions":[]}',
            json: {
              observations: "Two-decision tick exercising trace propagation.",
              reasoning: "Both rows should carry identical prompt/response.",
              decisions: [
                { type: "no_op", rationale: "first no-op of the run" },
                { type: "no_op", rationale: "second no-op of the run" },
              ],
            },
            usage: { tokensIn: 100, tokensOut: 30, costUsd: 0.001 },
            finishReason: "end_turn",
            durationMs: 150,
          };
        },
      }),
    });
    const decisions = recentDecisions(db, repoId, 5);
    assert.equal(decisions.length, 2);
    assert.equal(decisions[0].promptText, decisions[1].promptText);
    assert.equal(decisions[0].responseText, decisions[1].responseText);
    assert.match(decisions[0].promptText, /# system/);
    assert.equal(decisions[0].engineId, "mock");
    assert.equal(decisions[0].durationMs, 150);
  } finally {
    cleanup(dir);
  }
});
