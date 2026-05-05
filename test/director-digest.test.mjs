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
  getLastDigestDate,
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
