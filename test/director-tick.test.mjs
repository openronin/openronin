// Tests for the LLM-driven Director tick.
//
// We mock the Anthropic engine so the test suite stays offline. The tick
// is treated as a pure-ish function: input = (state, charter, mode), output
// = (decisions in DB, chat message in DB, budget delta). We assert each
// of those rather than poking at the LLM call itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { initDb } from "../dist/storage/db.js";
import { runTick } from "../dist/director/tick.js";
import { recentMessages } from "../dist/director/chat.js";
import { recentDecisions, pendingDecisions } from "../dist/director/decisions.js";
import { ensureBudgetState } from "../dist/director/budget.js";
import { parseTickOutput } from "../dist/director/decision-schema.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "openronin-tick-test-"));
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

function mockEngine(responseJson) {
  return () => ({
    id: "mock",
    defaultModel: "mock-model",
    async run() {
      const content = JSON.stringify(responseJson);
      return {
        content,
        json: responseJson,
        usage: { tokensIn: 8000, tokensOut: 500, costUsd: 0.0315 },
        finishReason: "end_turn",
        durationMs: 1234,
      };
    },
  });
}

test("decision-schema: TickOutput parses a well-formed payload", () => {
  const out = parseTickOutput({
    observations: "Project is in foundation phase. Director just landed.",
    reasoning: "Nothing material to do this tick. The reliability priority is well-served already.",
    decisions: [
      { type: "no_op", rationale: "Foundation is fresh; let humans drive a few cycles." },
    ],
  });
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.value.decisions.length, 1);
    assert.equal(out.value.decisions[0].type, "no_op");
  }
});

test("decision-schema: rejects missing required fields", () => {
  const out = parseTickOutput({
    observations: "x",
    decisions: [],
  });
  assert.equal(out.ok, false);
});

test("decision-schema: rejects unknown decision types", () => {
  const out = parseTickOutput({
    observations: "Lots of words to satisfy minimum length.",
    reasoning: "Lots more words to satisfy minimum length too.",
    decisions: [{ type: "delete_repo", rationale: "haha" }],
  });
  assert.equal(out.ok, false);
});

test("decision-schema: validates create_issue payload", () => {
  const out = parseTickOutput({
    observations: "Project lacks observability into engine costs per repo.",
    reasoning: "Per-repo cost view is missing — observability priority is at 0.5 in the charter.",
    decisions: [
      {
        type: "create_issue",
        rationale: "Charter priority observability is underserved",
        priority_id: "observability",
        payload: {
          title: "Add per-repo cost view to admin dashboard",
          body: "## Problem\n\nThe cost dashboard groups by lane and engine but not by repo, so it's hard to see which watched repo is the most expensive. ## Acceptance\n\n- [ ] /admin/cost has a per-repo row breakdown",
          labels: ["openronin:do-it"],
          priority: "normal",
        },
      },
    ],
  });
  assert.equal(out.ok, true);
});

test("runTick: dry_run records decisions with outcome=dry_run, posts status to chat", async () => {
  const { db, dir, repoId } = freshDb();
  // Install our test prompt template at the path loadTemplate() expects.
  // Since our test imports from dist/, the templates path resolves to
  // <repo>/prompts/templates which already has director-tick.md after the build.
  try {
    const llmJson = {
      observations: "Project healthy. 3 open PRs, 0 errors in last 24h, charter v1 just captured.",
      reasoning:
        "Reliability priority (0.5) is currently well-served by recent crash-recovery work. " +
        "Observability priority (0.5) shows a gap — there's no /metrics endpoint exposed.",
      decisions: [
        {
          type: "create_issue",
          rationale: "observability priority is uncovered; add Prometheus /metrics",
          priority_id: "observability",
          payload: {
            title: "Add Prometheus /metrics endpoint",
            body: "## Problem\n\nNo machine-readable metrics today.\n\n## Acceptance\n- /metrics endpoint with cost_usd_total, runs_total, lane_duration_seconds",
            labels: ["openronin:do-it"],
            priority: "normal",
          },
        },
      ],
    };
    const result = await runTick({
      db,
      repoId,
      repo: sampleRepo,
      director: sampleDirector,
      dataDir: dir,
      engineFactory: mockEngine(llmJson),
    });

    assert.equal(result.status, "ok");
    assert.equal(result.decisionsLogged, 1);
    assert.ok(result.costUsd > 0);

    const decisions = recentDecisions(db, repoId, 5);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].decisionType, "create_issue");
    assert.equal(decisions[0].outcome, "dry_run");
    assert.match(decisions[0].rationale, /observability/);
    assert.equal(pendingDecisions(db, repoId).length, 0); // dry_run is not pending

    const messages = recentMessages(db, repoId, 5);
    // 1 director status message
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, "director");
    assert.equal(messages[0].type, "status");
    assert.match(messages[0].body, /charter v1/);
    assert.match(messages[0].body, /create_issue/);

    const budget = ensureBudgetState(db, repoId, sampleBudget);
    assert.ok(budget.spentTodayThinkUsd > 0);
  } finally {
    cleanup(dir);
  }
});

test("runTick: propose mode marks decisions pending, not dry_run", async () => {
  const { db, dir, repoId } = freshDb();
  try {
    const propose = { ...sampleDirector, mode: "propose" };
    await runTick({
      db,
      repoId,
      repo: { ...sampleRepo, director: propose },
      director: propose,
      dataDir: dir,
      engineFactory: mockEngine({
        observations: "Project healthy. Nothing urgent. Just one observability gap.",
        reasoning: "Want to add a metrics endpoint to serve the observability charter priority.",
        decisions: [
          {
            type: "create_issue",
            rationale: "observability priority needs more coverage",
            payload: {
              title: "Surface tail latency metric",
              body: "## Problem\n\nNo p99 tracking.\n\n## Acceptance\n- [ ] add p99 to runs",
              labels: [],
              priority: "low",
            },
          },
        ],
      }),
    });
    const decisions = recentDecisions(db, repoId, 5);
    assert.equal(decisions[0].outcome, "pending");
    assert.equal(pendingDecisions(db, repoId).length, 1);
  } finally {
    cleanup(dir);
  }
});

test("runTick: invalid LLM JSON logs error message, no decisions", async () => {
  const { db, dir, repoId } = freshDb();
  try {
    const result = await runTick({
      db,
      repoId,
      repo: sampleRepo,
      director: sampleDirector,
      dataDir: dir,
      engineFactory: mockEngine({
        // Missing observations and reasoning + bad decision type
        decisions: [{ type: "delete_universe", rationale: "lol" }],
      }),
    });
    assert.equal(result.status, "error");
    assert.equal(result.decisionsLogged, 0);
    const messages = recentMessages(db, repoId, 5);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, "system");
    assert.equal(messages[0].type, "error");
    assert.equal(recentDecisions(db, repoId, 5).length, 0);
  } finally {
    cleanup(dir);
  }
});

test("runTick: paused budget skips the tick without LLM call", async () => {
  const { db, dir, repoId } = freshDb();
  try {
    ensureBudgetState(db, repoId, sampleBudget);
    db.prepare(
      `UPDATE director_budget_state SET paused = 1, pause_reason = 'test' WHERE repo_id = ?`,
    ).run(repoId);
    let llmCalls = 0;
    const result = await runTick({
      db,
      repoId,
      repo: sampleRepo,
      director: sampleDirector,
      dataDir: dir,
      engineFactory: () => ({
        id: "mock",
        defaultModel: "mock",
        async run() {
          llmCalls++;
          return { content: "{}", json: {}, usage: {}, finishReason: "x", durationMs: 0 };
        },
      }),
    });
    assert.equal(result.status, "paused");
    assert.equal(llmCalls, 0, "must not call LLM when paused");
    const messages = recentMessages(db, repoId, 5);
    assert.equal(messages[0].type, "tick_log");
    assert.match(messages[0].body, /paused/);
  } finally {
    cleanup(dir);
  }
});

test("runTick: no-op tick is logged but doesn't blow up rendering", async () => {
  const { db, dir, repoId } = freshDb();
  try {
    await runTick({
      db,
      repoId,
      repo: sampleRepo,
      director: sampleDirector,
      dataDir: dir,
      engineFactory: mockEngine({
        observations: "Project is in steady state. No urgent work.",
        reasoning: "All charter priorities currently well-served. No new gaps surfaced.",
        decisions: [{ type: "no_op", rationale: "Nothing material to do this tick." }],
      }),
    });
    const messages = recentMessages(db, repoId, 5);
    assert.match(messages[0].body, /no_op/);
  } finally {
    cleanup(dir);
  }
});
