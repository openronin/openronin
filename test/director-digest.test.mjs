// Daily morning digest.
//
// Verifies:
//   • shouldRunDigest fires once per local-TZ day past the configured hour
//   • timezone awareness (Moscow vs LA at the same UTC instant differ)
//   • disabled config short-circuits
//   • runDigest posts a single status message and persists last-digest-date
//   • a second runDigest on the same day is gated by shouldRunDigest

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initDb } from "../dist/storage/db.js";
import {
  computeDigestBackoffMs,
  getDigestRetryState,
  getLastDigestDate,
  isUnsupportedModelError,
  localDateInTz,
  localHourInTz,
  runDigest,
  shouldRunDigest,
} from "../dist/director/digest.js";
import { ensureBudgetState } from "../dist/director/budget.js";
import { recentMessages } from "../dist/director/chat.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "openronin-digest-test-"));
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

const sampleBudget = {
  initial_daily_usd: 2.0,
  initial_weekly_usd: 10.0,
  max_daily_usd: 10.0,
  max_weekly_usd: 50.0,
  think_daily_usd: 1.0,
  pause_on_failure_streak: 3,
  good_outcome_quarantine_days: 7,
};

test("localHourInTz: differs across timezones at the same UTC instant", () => {
  const t = new Date("2026-05-05T14:00:00Z"); // 14:00 UTC
  assert.equal(localHourInTz(t, "UTC"), 14);
  assert.equal(localHourInTz(t, "Europe/Moscow"), 17); // UTC+3
  assert.equal(localHourInTz(t, "America/Los_Angeles"), 7); // UTC-7 (PDT in May)
});

test("localDateInTz: returns YYYY-MM-DD; rolls midnight per tz", () => {
  const t = new Date("2026-05-05T22:30:00Z"); // 22:30 UTC
  assert.equal(localDateInTz(t, "UTC"), "2026-05-05");
  // 01:30 Moscow next day
  assert.equal(localDateInTz(t, "Europe/Moscow"), "2026-05-06");
});

test("shouldRunDigest: fires past the hour, only once per local day", () => {
  const digest = { enabled: true, hour: 9, timezone: "UTC" };
  // 08:00 UTC → too early
  assert.equal(shouldRunDigest(digest, null, new Date("2026-05-05T08:00:00Z")), false);
  // 09:00 UTC → on the dot, hasn't fired today
  assert.equal(shouldRunDigest(digest, null, new Date("2026-05-05T09:00:00Z")), true);
  // 09:30 UTC → already fired today
  assert.equal(shouldRunDigest(digest, "2026-05-05", new Date("2026-05-05T09:30:00Z")), false);
  // Next day at 09:00 → fires again
  assert.equal(shouldRunDigest(digest, "2026-05-05", new Date("2026-05-06T09:00:00Z")), true);
});

test("shouldRunDigest: enabled=false disables", () => {
  const digest = { enabled: false, hour: 9, timezone: "UTC" };
  assert.equal(shouldRunDigest(digest, null, new Date("2026-05-05T12:00:00Z")), false);
});

test("shouldRunDigest: timezone shifts when a day rolls", () => {
  // 23:00 UTC = 02:00 Moscow next day. Moscow operator's "today" already rolled.
  const digest = { enabled: true, hour: 9, timezone: "Europe/Moscow" };
  // last fired 2026-05-04 (Moscow), now 23:00 UTC on 2026-05-04 = 02:00 Moscow on -05.
  // Hour=2 < 9 → too early; predicate returns false even though local date moved on.
  assert.equal(shouldRunDigest(digest, "2026-05-04", new Date("2026-05-04T23:00:00Z")), false);
  // 06:00 UTC on -05 = 09:00 Moscow on -05 → fire.
  assert.equal(shouldRunDigest(digest, "2026-05-04", new Date("2026-05-05T06:00:00Z")), true);
});

test("computeDigestBackoffMs: doubles per failure, capped at 1h", () => {
  // First failure → 1 min; subsequent ones double until the cap.
  assert.equal(computeDigestBackoffMs(1), 60_000);
  assert.equal(computeDigestBackoffMs(2), 120_000);
  assert.equal(computeDigestBackoffMs(3), 240_000);
  assert.equal(computeDigestBackoffMs(6), 32 * 60_000);
  // Cap at 1 hour = 3_600_000 ms; should not exceed.
  assert.equal(computeDigestBackoffMs(7), 60 * 60_000);
  assert.equal(computeDigestBackoffMs(20), 60 * 60_000);
});

test("isUnsupportedModelError: matches the MIMO 400 'Not supported model' shape", () => {
  assert.equal(isUnsupportedModelError("MIMO error 400: Not supported model"), true);
  assert.equal(isUnsupportedModelError("not supported MODEL: whatever"), true);
  assert.equal(isUnsupportedModelError("network ECONNRESET"), false);
  assert.equal(isUnsupportedModelError("HTTP 500"), false);
});

test("shouldRunDigest: respects the backoff next_attempt_at deadline", () => {
  const digest = { enabled: true, hour: 9, timezone: "UTC" };
  const now = new Date("2026-05-05T10:00:00Z");
  // No backoff active → fire.
  assert.equal(shouldRunDigest(digest, null, now, null), true);
  // Backoff still in the future (5 minutes from now) → don't fire.
  const future = new Date(now.getTime() + 5 * 60_000).toISOString();
  assert.equal(shouldRunDigest(digest, null, now, future), false);
  // Backoff already elapsed → fire.
  const past = new Date(now.getTime() - 1_000).toISOString();
  assert.equal(shouldRunDigest(digest, null, now, past), true);
});

test("runDigest: 'Not supported model' marks today done, posts ONE notification, won't retry", async () => {
  const { db, dir, repoId } = freshDb();
  ensureBudgetState(db, repoId, sampleBudget);
  const repo = {
    provider: "github",
    owner: "openronin",
    name: "openronin",
    watched: true,
    lanes: ["triage"],
  };
  try {
    const fail = () =>
      runDigest({
        db,
        repoId,
        repo,
        digest: { enabled: true, hour: 9, timezone: "UTC" },
        persona: undefined,
        language: "English",
        dataDir: dir,
        now: new Date("2026-05-05T09:30:00Z"),
        engineFactory: () => ({
          id: "mock",
          defaultModel: "mock",
          async run() {
            throw new Error("MIMO error 400: Not supported model");
          },
        }),
      });
    const first = await fail();
    assert.equal(first.status, "error");
    // last_digest_date is set to today, so subsequent calls in the same
    // service-loop iteration are gated out by shouldRunDigest.
    assert.equal(getLastDigestDate(db, repoId), "2026-05-05");
    // Failure counter reset — we're not in "retry with backoff" mode.
    const state = getDigestRetryState(db, repoId);
    assert.equal(state.failureCount, 0);
    assert.equal(state.nextAttemptAt, null);
    // Exactly one error message posted.
    const errs = recentMessages(db, repoId, 20).filter(
      (m) => m.metadata?.kind === "digest" && m.type === "error",
    );
    assert.equal(errs.length, 1);
    assert.equal(errs[0].metadata.classification, "model_unavailable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDigest: transient failure bumps backoff and does NOT mark today done", async () => {
  const { db, dir, repoId } = freshDb();
  ensureBudgetState(db, repoId, sampleBudget);
  const repo = {
    provider: "github",
    owner: "openronin",
    name: "openronin",
    watched: true,
    lanes: ["triage"],
  };
  try {
    const startAt = new Date("2026-05-05T09:30:00Z");
    const result = await runDigest({
      db,
      repoId,
      repo,
      digest: { enabled: true, hour: 9, timezone: "UTC" },
      persona: undefined,
      language: "English",
      dataDir: dir,
      now: startAt,
      engineFactory: () => ({
        id: "mock",
        defaultModel: "mock",
        async run() {
          throw new Error("MIMO error 500: upstream timeout");
        },
      }),
    });
    assert.equal(result.status, "error");
    // last_digest_date untouched: tomorrow's predicate still sees null.
    assert.equal(getLastDigestDate(db, repoId), null);
    const state = getDigestRetryState(db, repoId);
    assert.equal(state.failureCount, 1);
    // Next attempt = now + 60s (first-failure backoff).
    assert.equal(state.nextAttemptAt, new Date(startAt.getTime() + 60_000).toISOString());
    // shouldRunDigest now refuses to fire until the backoff elapses.
    assert.equal(
      shouldRunDigest(
        { enabled: true, hour: 9, timezone: "UTC" },
        null,
        new Date(startAt.getTime() + 30_000),
        state.nextAttemptAt,
      ),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDigest: success resets a prior failure count", async () => {
  const { db, dir, repoId } = freshDb();
  ensureBudgetState(db, repoId, sampleBudget);
  const repo = {
    provider: "github",
    owner: "openronin",
    name: "openronin",
    watched: true,
    lanes: ["triage"],
  };
  try {
    const digest = { enabled: true, hour: 9, timezone: "UTC" };
    // First call fails transiently.
    await runDigest({
      db,
      repoId,
      repo,
      digest,
      persona: undefined,
      language: "English",
      dataDir: dir,
      now: new Date("2026-05-05T09:30:00Z"),
      engineFactory: () => ({
        id: "mock",
        defaultModel: "mock",
        async run() {
          throw new Error("transient blip");
        },
      }),
    });
    assert.equal(getDigestRetryState(db, repoId).failureCount, 1);
    // Second call succeeds → counter resets to 0, backoff cleared.
    const ok = await runDigest({
      db,
      repoId,
      repo,
      digest,
      persona: undefined,
      language: "English",
      dataDir: dir,
      now: new Date("2026-05-05T09:32:00Z"),
      engineFactory: () => ({
        id: "mock",
        defaultModel: "mock",
        async run() {
          return {
            content: "Good morning.",
            json: null,
            usage: { tokensIn: 100, tokensOut: 5, costUsd: 0.0001 },
            finishReason: "end_turn",
            durationMs: 10,
          };
        },
      }),
    });
    assert.equal(ok.status, "ok");
    const after = getDigestRetryState(db, repoId);
    assert.equal(after.failureCount, 0);
    assert.equal(after.nextAttemptAt, null);
    assert.equal(after.lastDate, "2026-05-05");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDigest: posts a single status message and records today", async () => {
  const { db, dir, repoId } = freshDb();
  ensureBudgetState(db, repoId, sampleBudget);
  const repo = {
    provider: "github",
    owner: "openronin",
    name: "openronin",
    watched: true,
    lanes: ["triage"],
  };
  try {
    const result = await runDigest({
      db,
      repoId,
      repo,
      digest: { enabled: true, hour: 9, timezone: "UTC" },
      persona: undefined,
      language: "Russian",
      dataDir: dir,
      now: new Date("2026-05-05T09:30:00Z"),
      engineFactory: () => ({
        id: "mock",
        defaultModel: "mock",
        async run(opts) {
          assert.match(opts.systemPrompt, /Director|product owner/i);
          assert.match(opts.userPrompt, /2026-05-05/);
          return {
            content: "Тихая ночь — ничего нового.",
            json: null,
            usage: { tokensIn: 800, tokensOut: 50, costUsd: 0.001 },
            finishReason: "end_turn",
            durationMs: 50,
          };
        },
      }),
    });
    assert.equal(result.status, "ok");
    const messages = recentMessages(db, repoId, 5);
    const digestMsg = messages.find((m) => m.metadata?.kind === "digest");
    assert.ok(digestMsg);
    assert.equal(digestMsg.role, "director");
    assert.equal(digestMsg.body, "Тихая ночь — ничего нового.");
    assert.equal(getLastDigestDate(db, repoId), "2026-05-05");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
