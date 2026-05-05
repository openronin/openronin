// Tests for human approve/reject of pending director decisions.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initDb } from "../dist/storage/db.js";
import { runTick } from "../dist/director/tick.js";
import { approveDecision, rejectDecision } from "../dist/director/executor.js";
import { recentDecisions, getDecisionById } from "../dist/director/decisions.js";
import { recentMessages } from "../dist/director/chat.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "openronin-approval-test-"));
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
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });

const charter = {
  vision: "Test charter for approval tests.",
  priorities: [{ id: "rel", weight: 1.0, rubric: "reliability" }],
  out_of_bounds: [],
  out_of_bounds_paths: [],
  definition_of_done: [],
};

const baseBudget = {
  initial_daily_usd: 2.0,
  initial_weekly_usd: 10.0,
  max_daily_usd: 10.0,
  max_weekly_usd: 50.0,
  think_daily_usd: 1.0,
  pause_on_failure_streak: 3,
  good_outcome_quarantine_days: 7,
};

const fullAuthority = {
  can_create_issues: true,
  can_label: true,
  can_close_issues: true,
  can_comment: true,
  can_approve_pr: true,
  can_merge: true,
  can_modify_charter: true,
};

function director(mode, overrides = {}) {
  return {
    enabled: true,
    mode,
    cadence_hours: 6,
    bot_prefix: "👔 director:",
    charter,
    budget: baseBudget,
    authority: { ...fullAuthority, ...(overrides.authority ?? {}) },
  };
}

const repo = (d) => ({
  provider: "github",
  owner: "openronin",
  name: "openronin",
  watched: true,
  lanes: ["triage"],
  director: d,
});

function mockEngine(decisions) {
  return () => ({
    id: "mock",
    defaultModel: "mock",
    async run() {
      const json = {
        observations: "Project state stable, nothing pressing surfaces in this snapshot.",
        reasoning: "Routine planning per charter priority rel; one proposal worth queueing.",
        decisions,
      };
      return {
        content: JSON.stringify(json),
        json,
        usage: { tokensIn: 1000, tokensOut: 200, costUsd: 0.001 },
        finishReason: "end_turn",
        durationMs: 100,
      };
    },
  });
}

function mockVcs() {
  const calls = [];
  return {
    calls,
    provider: {
      id: "mock-vcs",
      listOpenItems: async function* () {},
      async getItem() {
        throw new Error("not used");
      },
      async postComment(_r, n, b) {
        calls.push({ method: "postComment", n, b });
        return { id: "c1", url: `https://gh/c/${n}` };
      },
      async updateComment() {},
      async closeItem(_r, n) {
        calls.push({ method: "closeItem", n });
      },
      async listAllPrFeedback() {
        return [];
      },
      verifyWebhookSignature() {
        return true;
      },
      async createIssue(_r, args) {
        calls.push({ method: "createIssue", ...args });
        return { number: 777, url: "https://gh/issues/777" };
      },
      async addLabels(_r, n, l) {
        calls.push({ method: "addLabels", n, l });
      },
      async removeLabels(_r, n, l) {
        calls.push({ method: "removeLabels", n, l });
      },
      async approvePullRequest(_r, n, b) {
        calls.push({ method: "approvePullRequest", n, b });
      },
      async mergePullRequest(_r, n, s) {
        calls.push({ method: "mergePullRequest", n, s });
        return { merged: true, sha: "abc" };
      },
    },
  };
}

async function runProposeTick(db, repoId, dir) {
  return runTick({
    db,
    repoId,
    repo: repo(director("propose")),
    director: director("propose"),
    dataDir: dir,
    engineFactory: mockEngine([
      {
        type: "create_issue",
        rationale: "needed to address an observability gap noticed this tick",
        payload: {
          title: "Add /metrics endpoint with cost_usd_total",
          body: "## Problem\n\nNo metric.\n\n## Acceptance\n- [ ] /metrics emits cost",
          labels: ["openronin:do-it"],
          priority: "normal",
        },
      },
    ]),
    vcsFactory: () => ({}),
  });
}

test("approveDecision: pending → executed, VCS called once, report in chat", async () => {
  const { db, dir, repoId } = freshDb();
  const vcs = mockVcs();
  try {
    await runProposeTick(db, repoId, dir);
    const ds = recentDecisions(db, repoId, 5);
    const pending = ds.find((d) => d.outcome === "pending");
    assert.ok(pending, "tick should produce one pending decision");

    const result = await approveDecision({
      db,
      decisionId: pending.id,
      repo: repo(director("propose")),
      director: director("propose"),
      actor: "test",
      getVcs: () => vcs.provider,
    });
    assert.equal(result.ok, true);
    assert.equal(result.outcome, "executed");

    const after = getDecisionById(db, pending.id);
    assert.equal(after.outcome, "executed");
    assert.match(after.outcomeDetails, /issue #777/);

    assert.equal(vcs.calls.filter((c) => c.method === "createIssue").length, 1);

    const msgs = recentMessages(db, repoId, 20);
    const userAck = msgs.find((m) => m.role === "user" && m.body.includes("Approved"));
    const report = msgs.find((m) => m.type === "report");
    assert.ok(userAck);
    assert.ok(report);
  } finally {
    cleanup(dir);
  }
});

test("rejectDecision: pending → rejected, no VCS, veto in chat", async () => {
  const { db, dir, repoId } = freshDb();
  const vcs = mockVcs();
  try {
    await runProposeTick(db, repoId, dir);
    const pending = recentDecisions(db, repoId, 5).find((d) => d.outcome === "pending");

    rejectDecision({
      db,
      decisionId: pending.id,
      repo: repo(director("propose")),
      actor: "test",
      reason: "not aligned with current sprint",
    });

    const after = getDecisionById(db, pending.id);
    assert.equal(after.outcome, "rejected");
    assert.match(after.outcomeDetails, /not aligned/);
    assert.equal(vcs.calls.length, 0);

    const veto = recentMessages(db, repoId, 20).find((m) => m.type === "veto");
    assert.ok(veto);
    assert.match(veto.body, /Rejected/);
    assert.match(veto.body, /not aligned/);
  } finally {
    cleanup(dir);
  }
});

test("approveDecision: re-checks authority — flipping can_create_issues=false → skipped", async () => {
  const { db, dir, repoId } = freshDb();
  const vcs = mockVcs();
  try {
    await runProposeTick(db, repoId, dir);
    const pending = recentDecisions(db, repoId, 5).find((d) => d.outcome === "pending");

    // Operator revoked authority between proposal and approval.
    const downgradedDirector = director("propose", {
      authority: { can_create_issues: false },
    });

    const result = await approveDecision({
      db,
      decisionId: pending.id,
      repo: repo(downgradedDirector),
      director: downgradedDirector,
      actor: "test",
      getVcs: () => vcs.provider,
    });
    assert.equal(result.ok, true);
    assert.equal(result.outcome, "skipped");

    const after = getDecisionById(db, pending.id);
    assert.equal(after.outcome, "skipped");
    assert.equal(vcs.calls.length, 0, "no VCS calls when gated");
  } finally {
    cleanup(dir);
  }
});

test("approveDecision: rejects double-approval (already executed)", async () => {
  const { db, dir, repoId } = freshDb();
  const vcs = mockVcs();
  try {
    await runProposeTick(db, repoId, dir);
    const pending = recentDecisions(db, repoId, 5).find((d) => d.outcome === "pending");

    const first = await approveDecision({
      db,
      decisionId: pending.id,
      repo: repo(director("propose")),
      director: director("propose"),
      actor: "test",
      getVcs: () => vcs.provider,
    });
    assert.equal(first.outcome, "executed");

    const second = await approveDecision({
      db,
      decisionId: pending.id,
      repo: repo(director("propose")),
      director: director("propose"),
      actor: "test",
      getVcs: () => vcs.provider,
    });
    assert.equal(second.ok, false);
    assert.match(second.reason, /not pending/);

    assert.equal(
      vcs.calls.filter((c) => c.method === "createIssue").length,
      1,
      "VCS call must run only once",
    );
  } finally {
    cleanup(dir);
  }
});

test("rejectDecision: rejects on already-executed (not pending)", async () => {
  const { db, dir, repoId } = freshDb();
  const vcs = mockVcs();
  try {
    await runProposeTick(db, repoId, dir);
    const pending = recentDecisions(db, repoId, 5).find((d) => d.outcome === "pending");

    await approveDecision({
      db,
      decisionId: pending.id,
      repo: repo(director("propose")),
      director: director("propose"),
      actor: "test",
      getVcs: () => vcs.provider,
    });

    const result = rejectDecision({
      db,
      decisionId: pending.id,
      repo: repo(director("propose")),
      actor: "test",
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /not pending/);
  } finally {
    cleanup(dir);
  }
});
