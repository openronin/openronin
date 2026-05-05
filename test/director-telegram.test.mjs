// Tests for the Director Telegram bridge.
//
// We don't poll the live Telegram API in tests — we exercise the
// command-handling logic by feeding in synthetic update objects via the
// public class methods. The fetch() mocking here is minimal and just
// records outbound calls so we can assert what the bridge would have sent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initDb } from "../dist/storage/db.js";
import { DirectorTelegramBridge } from "../dist/director/telegram.js";
import { runTick } from "../dist/director/tick.js";
import { recentMessages } from "../dist/director/chat.js";
import { recentDecisions, getDecisionById } from "../dist/director/decisions.js";

const charter = {
  vision: "Test charter for telegram bridge tests.",
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
const directorCfg = (mode = "propose") => ({
  enabled: true,
  mode,
  cadence_hours: 6,
  bot_prefix: "👔 director:",
  charter,
  budget: baseBudget,
  authority: fullAuthority,
});
const repoCfg = (d = directorCfg()) => ({
  provider: "github",
  owner: "openronin",
  name: "openronin",
  watched: true,
  lanes: ["triage"],
  director: d,
});

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "openronin-tg-test-"));
  const db = initDb(dir);
  const r = db
    .prepare(
      `INSERT INTO repos (provider, owner, name, watched, config_json)
       VALUES ('github','openronin','openronin',1,'{}') RETURNING id`,
    )
    .get();
  return { db, dir, repoId: r.id };
}
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });

// Patch global.fetch to capture outbound /sendMessage calls. Returns ok=true
// for everything; the bridge handles parse-mode fallback by retrying without
// markdown — we accept both calls.
function captureFetch() {
  const sent = [];
  const original = global.fetch;
  global.fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init?.body ?? "{}") });
    return new Response(JSON.stringify({ ok: true, result: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    sent,
    restore: () => {
      global.fetch = original;
    },
  };
}

function bridgeWith(db, getConfig, allowed = [42]) {
  return new DirectorTelegramBridge(db, getConfig, "fake-token", allowed);
}

function runProposeTick(db, repoId, dir) {
  return runTick({
    db,
    repoId,
    repo: repoCfg(),
    director: directorCfg(),
    dataDir: dir,
    engineFactory: () => ({
      id: "mock",
      defaultModel: "x",
      async run() {
        const json = {
          observations: "Project state stable, nothing pressing surfaces in this snapshot.",
          reasoning: "Routine planning per charter priority rel; one proposal worth queueing.",
          decisions: [
            {
              type: "create_issue",
              rationale: "address an observability gap noticed this tick",
              payload: {
                title: "Add /metrics endpoint with cost_usd_total",
                body: "## Problem\n\nNo metric.\n\n## Acceptance\n- [ ] /metrics emits cost",
                labels: [],
                priority: "normal",
              },
            },
          ],
        };
        return {
          content: JSON.stringify(json),
          json,
          usage: { tokensIn: 1000, tokensOut: 200, costUsd: 0.001 },
          finishReason: "end_turn",
          durationMs: 100,
        };
      },
    }),
    vcsFactory: () => ({}),
  });
}

test("bridge: free-form text from authorized user → directive recorded", async () => {
  const { db, dir, repoId } = freshDb();
  const fetchMock = captureFetch();
  try {
    const bridge = bridgeWith(db, () => ({ dataDir: dir, global: {}, repos: [repoCfg()] }));
    // synthesise an incoming Telegram update via internal handler
    await bridge["handleIncoming"]({
      message_id: 1,
      from: { id: 42, username: "test" },
      chat: { id: 100, type: "private" },
      text: "focus on testing this week",
      date: 0,
    });
    const msgs = recentMessages(db, repoId, 5);
    const directive = msgs.find((m) => m.type === "directive");
    assert.ok(directive);
    assert.match(directive.body, /focus on testing/);
    // Acknowledgement also went out via sendMessage
    const ack = fetchMock.sent.find((s) => s.url.includes("sendMessage"));
    assert.ok(ack);
    assert.match(ack.body.text, /directive recorded/);
  } finally {
    fetchMock.restore();
    cleanup(dir);
  }
});

test("bridge: /approve <id> approves and reports outcome", async () => {
  const { db, dir, repoId } = freshDb();
  const fetchMock = captureFetch();
  try {
    await runProposeTick(db, repoId, dir);
    const pending = recentDecisions(db, repoId, 5).find((d) => d.outcome === "pending");
    assert.ok(pending);

    // Provide a mock VcsProvider via overriding defaultVcs on the bridge
    const bridge = bridgeWith(db, () => ({ dataDir: dir, global: {}, repos: [repoCfg()] }));
    bridge["defaultVcs"] = () => ({
      id: "mock",
      async createIssue() {
        return { number: 999, url: "https://gh/i/999" };
      },
      // unused
      listOpenItems: async function* () {},
      async getItem() {
        throw new Error("x");
      },
      async postComment() {
        return { id: "c", url: "u" };
      },
      async updateComment() {},
      async closeItem() {},
      async listAllPrFeedback() {
        return [];
      },
      verifyWebhookSignature() {
        return true;
      },
      async addLabels() {},
      async removeLabels() {},
      async approvePullRequest() {},
      async mergePullRequest() {
        return { merged: true };
      },
    });

    await bridge["handleIncoming"]({
      message_id: 1,
      from: { id: 42, username: "test" },
      chat: { id: 100, type: "private" },
      text: `/approve ${pending.id}`,
      date: 0,
    });

    const after = getDecisionById(db, pending.id);
    assert.equal(after.outcome, "executed");
    const ack = fetchMock.sent.find(
      (s) =>
        s.url.includes("sendMessage") &&
        typeof s.body.text === "string" &&
        s.body.text.includes("→ executed"),
    );
    assert.ok(ack);
  } finally {
    fetchMock.restore();
    cleanup(dir);
  }
});

test("bridge: /reject <id> reason", async () => {
  const { db, dir, repoId } = freshDb();
  const fetchMock = captureFetch();
  try {
    await runProposeTick(db, repoId, dir);
    const pending = recentDecisions(db, repoId, 5).find((d) => d.outcome === "pending");

    const bridge = bridgeWith(db, () => ({ dataDir: dir, global: {}, repos: [repoCfg()] }));
    await bridge["handleIncoming"]({
      message_id: 2,
      from: { id: 42 },
      chat: { id: 100, type: "private" },
      text: `/reject ${pending.id} not aligned with sprint`,
      date: 0,
    });

    const after = getDecisionById(db, pending.id);
    assert.equal(after.outcome, "rejected");
    assert.match(after.outcomeDetails, /not aligned with sprint/);
  } finally {
    fetchMock.restore();
    cleanup(dir);
  }
});

test("bridge: /pending lists pending decisions", async () => {
  const { db, dir, repoId } = freshDb();
  const fetchMock = captureFetch();
  try {
    await runProposeTick(db, repoId, dir);

    const bridge = bridgeWith(db, () => ({ dataDir: dir, global: {}, repos: [repoCfg()] }));
    await bridge["handleIncoming"]({
      message_id: 3,
      from: { id: 42 },
      chat: { id: 100, type: "private" },
      text: "/pending",
      date: 0,
    });
    const reply = fetchMock.sent.find((s) => s.url.includes("sendMessage"));
    assert.ok(reply);
    assert.match(reply.body.text, /create_issue/);
  } finally {
    fetchMock.restore();
    cleanup(dir);
  }
});

test("bridge: /pause and /resume toggle paused flag", async () => {
  const { db, dir, repoId } = freshDb();
  const fetchMock = captureFetch();
  try {
    const bridge = bridgeWith(db, () => ({ dataDir: dir, global: {}, repos: [repoCfg()] }));
    await bridge["handleIncoming"]({
      message_id: 4,
      from: { id: 42 },
      chat: { id: 100, type: "private" },
      text: "/pause github--openronin--openronin",
      date: 0,
    });
    const paused = db
      .prepare(`SELECT paused FROM director_budget_state WHERE repo_id = ?`)
      .get(repoId);
    assert.equal(paused.paused, 1);

    await bridge["handleIncoming"]({
      message_id: 5,
      from: { id: 42 },
      chat: { id: 100, type: "private" },
      text: "/resume github--openronin--openronin",
      date: 0,
    });
    const resumed = db
      .prepare(`SELECT paused FROM director_budget_state WHERE repo_id = ?`)
      .get(repoId);
    assert.equal(resumed.paused, 0);
  } finally {
    fetchMock.restore();
    cleanup(dir);
  }
});

test("bridge: unauthorized user is ignored (no DB write, no reply)", async () => {
  const { db, dir, repoId } = freshDb();
  const fetchMock = captureFetch();
  try {
    const bridge = bridgeWith(db, () => ({ dataDir: dir, global: {}, repos: [repoCfg()] }), [42]);
    // pollOnce uses fetch.getUpdates; call private pollOnce isn't easy.
    // Instead, simulate via runIncomingLoop's filter by hitting pollOnce path
    // through synthetic update.
    // Direct unit: call handleIncoming through pollOnce shim
    // We can't easily exercise the whitelist filter from outside the loop;
    // instead, verify it indirectly: handleIncoming itself trusts the
    // caller to have filtered. So we verify the filter via a fresh fetch
    // mock returning an update from user_id=99.
    fetchMock.restore();
    const sent = [];
    global.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes("getUpdates")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: [
              {
                update_id: 1,
                message: {
                  message_id: 1,
                  from: { id: 99 }, // not in whitelist
                  chat: { id: 100, type: "private" },
                  text: "hello",
                  date: 0,
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      sent.push({ url: u, body: JSON.parse(init?.body ?? "{}") });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    // Trigger one poll cycle
    await bridge["pollOnce"]();
    const msgs = recentMessages(db, repoId, 5);
    assert.equal(msgs.length, 0, "unauthorized user must not produce DB writes");
    assert.equal(sent.length, 0, "no reply sent to unauthorized user");
  } finally {
    cleanup(dir);
    global.fetch = fetch; // best-effort restore
  }
});
