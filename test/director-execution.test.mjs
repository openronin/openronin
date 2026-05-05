// Tests for the Director's decision executor.
//
// These exercise the full mode × authority × decision-type matrix using a
// mock VcsProvider. No live API calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initDb } from "../dist/storage/db.js";
import { runTick } from "../dist/director/tick.js";
import { recentMessages } from "../dist/director/chat.js";
import { recentDecisions } from "../dist/director/decisions.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "openronin-exec-test-"));
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

const charter = {
  vision: "Test charter for execution tests.",
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

function repo(d) {
  return {
    provider: "github",
    owner: "openronin",
    name: "openronin",
    watched: true,
    lanes: ["triage"],
    director: d,
  };
}

function mockEngine(decisions) {
  return () => ({
    id: "mock",
    defaultModel: "mock-model",
    async run() {
      const json = {
        observations: "State is stable. No urgent issues. Sufficient observability coverage.",
        reasoning: "Routine planning per charter priority rel; nothing pressing surfaced.",
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

// Recording mock — captures every VCS method call so tests can assert.
function mockVcs() {
  const calls = [];
  const provider = {
    id: "mock-vcs",
    listOpenItems: async function* () {},
    async getItem() {
      throw new Error("not used");
    },
    async postComment(_repo, number, body) {
      calls.push({ method: "postComment", number, body });
      return { id: "c1", url: `https://gh/comment/${number}` };
    },
    async updateComment() {},
    async closeItem(_repo, number, reason) {
      calls.push({ method: "closeItem", number, reason });
    },
    async listAllPrFeedback() {
      return [];
    },
    verifyWebhookSignature() {
      return true;
    },
    async createIssue(_repo, args) {
      calls.push({ method: "createIssue", ...args });
      return { number: 999, url: "https://gh/issues/999" };
    },
    async addLabels(_repo, number, labels) {
      calls.push({ method: "addLabels", number, labels });
    },
    async removeLabels(_repo, number, labels) {
      calls.push({ method: "removeLabels", number, labels });
    },
    async approvePullRequest(_repo, prNumber, body) {
      calls.push({ method: "approvePullRequest", prNumber, body });
    },
    async mergePullRequest(_repo, prNumber, strategy) {
      calls.push({ method: "mergePullRequest", prNumber, strategy });
      return { merged: true, sha: "abc1234" };
    },
  };
  return { provider, calls };
}

const vcsFactory = (vcs) => () => vcs;

// ── Mode → outcome behaviour ─────────────────────────────────────────────

test("dry_run: create_issue → outcome=dry_run, no VCS call", async () => {
  const { db, dir, repoId } = freshDb();
  const vcs = mockVcs();
  try {
    await runTick({
      db,
      repoId,
      repo: repo(director("dry_run")),
      director: director("dry_run"),
      dataDir: dir,
      engineFactory: mockEngine([
        {
          type: "create_issue",
          rationale: "addresses observability gap in metrics",
          payload: {
            title: "Add metric",
            body: "## Problem\n\nNo metric.\n\n## Acceptance\n- [ ] add",
            labels: [],
            priority: "normal",
          },
        },
      ]),
      vcsFactory: vcsFactory(vcs.provider),
    });
    const ds = recentDecisions(db, repoId, 5);
    assert.equal(ds[0].outcome, "dry_run");
    assert.equal(vcs.calls.length, 0, "VCS must not be called in dry_run");
  } finally {
    cleanup(dir);
  }
});

test("propose: create_issue → outcome=pending, proposal posted, no VCS call", async () => {
  const { db, dir, repoId } = freshDb();
  const vcs = mockVcs();
  try {
    await runTick({
      db,
      repoId,
      repo: repo(director("propose")),
      director: director("propose"),
      dataDir: dir,
      engineFactory: mockEngine([
        {
          type: "create_issue",
          rationale: "needs to land",
          payload: {
            title: "Tweak something",
            body: "## Problem\n\nfoo\n\n## Acceptance\n- [ ] x",
            labels: ["a"],
            priority: "normal",
          },
        },
      ]),
      vcsFactory: vcsFactory(vcs.provider),
    });
    const ds = recentDecisions(db, repoId, 5);
    assert.equal(ds[0].outcome, "pending");
    assert.equal(vcs.calls.length, 0, "VCS must not be called in propose");
    const msgs = recentMessages(db, repoId, 5);
    const proposals = msgs.filter((m) => m.type === "proposal");
    assert.equal(proposals.length, 1);
    assert.match(proposals[0].body, /create_issue/);
    assert.match(proposals[0].body, /Tweak something/);
  } finally {
    cleanup(dir);
  }
});

test("semi_auto: create_issue executes, merge_pr stays pending", async () => {
  const { db, dir, repoId } = freshDb();
  const vcs = mockVcs();
  try {
    await runTick({
      db,
      repoId,
      repo: repo(director("semi_auto")),
      director: director("semi_auto"),
      dataDir: dir,
      engineFactory: mockEngine([
        {
          type: "create_issue",
          rationale: "needs to land per charter priority",
          payload: {
            title: "auto-create",
            body: "## Problem\n\nfoo\n\n## Done\n- yes",
            labels: [],
            priority: "normal",
          },
        },
        {
          type: "merge_pr",
          rationale: "ready: ci green, addresses charter",
          payload: { pr_number: 7, strategy: "squash" },
        },
      ]),
      vcsFactory: vcsFactory(vcs.provider),
    });
    const ds = recentDecisions(db, repoId, 10);
    const issueDec = ds.find((d) => d.decisionType === "create_issue");
    const mergeDec = ds.find((d) => d.decisionType === "merge_pr");
    assert.equal(issueDec.outcome, "executed");
    assert.equal(mergeDec.outcome, "pending");
    assert.equal(vcs.calls.filter((c) => c.method === "createIssue").length, 1);
    assert.equal(vcs.calls.filter((c) => c.method === "mergePullRequest").length, 0);
  } finally {
    cleanup(dir);
  }
});

test("full_auto: merge_pr executes, charter amend stays pending", async () => {
  const { db, dir, repoId } = freshDb();
  const vcs = mockVcs();
  try {
    await runTick({
      db,
      repoId,
      repo: repo(director("full_auto")),
      director: director("full_auto"),
      dataDir: dir,
      engineFactory: mockEngine([
        {
          type: "merge_pr",
          rationale: "ready: ci green, addresses charter",
          payload: { pr_number: 11, strategy: "squash" },
        },
        {
          type: "amend_charter",
          rationale: "evolve charter for new priority X",
          payload: {
            proposed_changes: "Add new priority X with weight 0.1",
            rationale: "Need more diversity in objectives",
          },
        },
      ]),
      vcsFactory: vcsFactory(vcs.provider),
    });
    const ds = recentDecisions(db, repoId, 10);
    const mergeDec = ds.find((d) => d.decisionType === "merge_pr");
    const charterDec = ds.find((d) => d.decisionType === "amend_charter");
    assert.equal(mergeDec.outcome, "executed");
    assert.equal(charterDec.outcome, "pending", "amend_charter is always proposal-only");
    assert.equal(vcs.calls.filter((c) => c.method === "mergePullRequest").length, 1);
  } finally {
    cleanup(dir);
  }
});

// ── Authority gating ─────────────────────────────────────────────────────

test("authority: can_merge=false blocks merge_pr in full_auto → outcome=skipped", async () => {
  const { db, dir, repoId } = freshDb();
  const vcs = mockVcs();
  const d = director("full_auto", { authority: { can_merge: false } });
  try {
    await runTick({
      db,
      repoId,
      repo: repo(d),
      director: d,
      dataDir: dir,
      engineFactory: mockEngine([
        {
          type: "merge_pr",
          rationale: "ready: ci green, addresses charter",
          payload: { pr_number: 5, strategy: "squash" },
        },
      ]),
      vcsFactory: vcsFactory(vcs.provider),
    });
    const ds = recentDecisions(db, repoId, 5);
    assert.equal(ds[0].outcome, "skipped");
    assert.equal(vcs.calls.length, 0);
  } finally {
    cleanup(dir);
  }
});

test("authority: can_close_issues=false blocks close_issue", async () => {
  const { db, dir, repoId } = freshDb();
  const vcs = mockVcs();
  const d = director("full_auto", { authority: { can_close_issues: false } });
  try {
    await runTick({
      db,
      repoId,
      repo: repo(d),
      director: d,
      dataDir: dir,
      engineFactory: mockEngine([
        {
          type: "close_issue",
          rationale: "stale per charter retrospective",
          payload: { issue_number: 99, reason: "no longer relevant; please reopen if needed" },
        },
      ]),
      vcsFactory: vcsFactory(vcs.provider),
    });
    const ds = recentDecisions(db, repoId, 5);
    assert.equal(ds[0].outcome, "skipped");
    assert.equal(vcs.calls.length, 0);
  } finally {
    cleanup(dir);
  }
});

// ── Per-type executors ───────────────────────────────────────────────────

test("full_auto label_pr → addLabels + removeLabels both called", async () => {
  const { db, dir, repoId } = freshDb();
  const vcs = mockVcs();
  try {
    await runTick({
      db,
      repoId,
      repo: repo(director("full_auto")),
      director: director("full_auto"),
      dataDir: dir,
      engineFactory: mockEngine([
        {
          type: "label_pr",
          rationale: "tag for review",
          payload: { pr_number: 8, add: ["needs-review"], remove: ["wip"] },
        },
      ]),
      vcsFactory: vcsFactory(vcs.provider),
    });
    const adds = vcs.calls.find((c) => c.method === "addLabels");
    const removes = vcs.calls.find((c) => c.method === "removeLabels");
    assert.deepEqual(adds.labels, ["needs-review"]);
    assert.deepEqual(removes.labels, ["wip"]);
  } finally {
    cleanup(dir);
  }
});

test("full_auto approve_pr → approvePullRequest called once", async () => {
  const { db, dir, repoId } = freshDb();
  const vcs = mockVcs();
  try {
    await runTick({
      db,
      repoId,
      repo: repo(director("full_auto")),
      director: director("full_auto"),
      dataDir: dir,
      engineFactory: mockEngine([
        {
          type: "approve_pr",
          rationale: "ci green, addresses charter rel priority",
          payload: { pr_number: 14, body: "LGTM" },
        },
      ]),
      vcsFactory: vcsFactory(vcs.provider),
    });
    const call = vcs.calls.find((c) => c.method === "approvePullRequest");
    assert.equal(call.prNumber, 14);
    assert.equal(call.body, "LGTM");
    const ds = recentDecisions(db, repoId, 5);
    assert.equal(ds[0].outcome, "executed");
  } finally {
    cleanup(dir);
  }
});

test("full_auto close_issue → posts comment then closes", async () => {
  const { db, dir, repoId } = freshDb();
  const vcs = mockVcs();
  try {
    await runTick({
      db,
      repoId,
      repo: repo(director("full_auto")),
      director: director("full_auto"),
      dataDir: dir,
      engineFactory: mockEngine([
        {
          type: "close_issue",
          rationale: "duplicate of an earlier issue thread",
          payload: { issue_number: 41, reason: "Duplicate of #40 — closing in favour of that one." },
        },
      ]),
      vcsFactory: vcsFactory(vcs.provider),
    });
    const comment = vcs.calls.find((c) => c.method === "postComment");
    const close = vcs.calls.find((c) => c.method === "closeItem");
    assert.equal(comment.number, 41);
    assert.match(comment.body, /Duplicate/);
    assert.equal(close.number, 41);
  } finally {
    cleanup(dir);
  }
});

// ── ask_user always executes (posts question to chat, no VCS) ───────────

test("propose: ask_user → outcome=executed, question posted to chat, no VCS", async () => {
  const { db, dir, repoId } = freshDb();
  const vcs = mockVcs();
  try {
    await runTick({
      db,
      repoId,
      repo: repo(director("propose")),
      director: director("propose"),
      dataDir: dir,
      engineFactory: mockEngine([
        {
          type: "ask_user",
          rationale: "uncertain about priority X vs Y",
          payload: { question: "Should we focus on X or Y next sprint?", context: "from charter" },
        },
      ]),
      vcsFactory: vcsFactory(vcs.provider),
    });
    const ds = recentDecisions(db, repoId, 5);
    assert.equal(ds[0].outcome, "executed");
    const questions = recentMessages(db, repoId, 10).filter((m) => m.type === "question");
    assert.equal(questions.length, 1);
    assert.equal(vcs.calls.length, 0);
  } finally {
    cleanup(dir);
  }
});

// ── Failure handling ─────────────────────────────────────────────────────

test("full_auto: VCS failure → outcome=failed, error message in chat", async () => {
  const { db, dir, repoId } = freshDb();
  const vcs = mockVcs();
  vcs.provider.createIssue = async () => {
    throw new Error("github 503: temporarily unavailable");
  };
  try {
    await runTick({
      db,
      repoId,
      repo: repo(director("full_auto")),
      director: director("full_auto"),
      dataDir: dir,
      engineFactory: mockEngine([
        {
          type: "create_issue",
          rationale: "needed to address charter goal",
          payload: {
            title: "x",
            body: "## p\n\nthing\n\n## d\n- yes",
            labels: [],
            priority: "normal",
          },
        },
      ]),
      vcsFactory: vcsFactory(vcs.provider),
    });
    const ds = recentDecisions(db, repoId, 5);
    assert.equal(ds[0].outcome, "failed");
    assert.match(ds[0].outcomeDetails, /503/);
    const errs = recentMessages(db, repoId, 10).filter((m) => m.type === "error");
    assert.equal(errs.length, 1);
  } finally {
    cleanup(dir);
  }
});

test("no_op decision always outcome=executed regardless of mode", async () => {
  const { db, dir, repoId } = freshDb();
  const vcs = mockVcs();
  try {
    await runTick({
      db,
      repoId,
      repo: repo(director("propose")),
      director: director("propose"),
      dataDir: dir,
      engineFactory: mockEngine([{ type: "no_op", rationale: "Nothing to do this tick." }]),
      vcsFactory: vcsFactory(vcs.provider),
    });
    const ds = recentDecisions(db, repoId, 5);
    // dry_run mode special-cases dry_run outcome; propose mode no_op → executed.
    assert.equal(ds[0].outcome, "executed");
    assert.equal(vcs.calls.length, 0);
  } finally {
    cleanup(dir);
  }
});

test("dry_run: no_op → outcome=dry_run (mode wins)", async () => {
  const { db, dir, repoId } = freshDb();
  const vcs = mockVcs();
  try {
    await runTick({
      db,
      repoId,
      repo: repo(director("dry_run")),
      director: director("dry_run"),
      dataDir: dir,
      engineFactory: mockEngine([{ type: "no_op", rationale: "Nothing to do this tick." }]),
      vcsFactory: vcsFactory(vcs.provider),
    });
    const ds = recentDecisions(db, repoId, 5);
    assert.equal(ds[0].outcome, "dry_run");
  } finally {
    cleanup(dir);
  }
});
