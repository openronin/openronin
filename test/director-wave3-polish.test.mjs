// Wave 3 polish: pending expiry, transient retry, charter diff.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initDb } from "../dist/storage/db.js";
import { expireStalePending, recordDecision, getDecisionById } from "../dist/director/decisions.js";
import { isTransientError, withTransientRetry } from "../dist/director/executor.js";
import { captureCharterVersion } from "../dist/director/charter.js";
import { recentMessages } from "../dist/director/chat.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "openronin-wave3-test-"));
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

test("expireStalePending: flips pending >7d → expired; leaves recent untouched", () => {
  const { db, dir, repoId } = freshDb();
  try {
    const old = recordDecision(db, {
      repoId,
      decisionType: "create_issue",
      rationale: "old proposal nobody acted on",
      payload: { title: "older proposal" },
      outcome: "pending",
    });
    const recent = recordDecision(db, {
      repoId,
      decisionType: "create_issue",
      rationale: "fresh proposal that should survive",
      payload: { title: "newer proposal" },
      outcome: "pending",
    });
    db.prepare(`UPDATE director_decisions SET ts = datetime('now', '-10 days') WHERE id = ?`).run(
      old.id,
    );

    const expired = expireStalePending(db, repoId, 7);
    assert.equal(expired, 1);
    assert.equal(getDecisionById(db, old.id).outcome, "expired");
    assert.equal(getDecisionById(db, recent.id).outcome, "pending");
  } finally {
    cleanup(dir);
  }
});

test("isTransientError: matches 5xx / ECONNRESET / timeout; rejects 404", () => {
  assert.equal(isTransientError(new Error("Server returned 503 Service Unavailable")), true);
  assert.equal(isTransientError(new Error("connect ECONNRESET 10.0.0.1:443")), true);
  assert.equal(isTransientError(new Error("Request timeout after 30s")), true);
  assert.equal(isTransientError(new Error("Secondary rate limit triggered")), true);
  assert.equal(isTransientError(new Error("404 Not Found: issue does not exist")), false);
  assert.equal(isTransientError(new Error("422 Unprocessable Entity")), false);
});

test("withTransientRetry: succeeds after transient failures", async () => {
  let attempts = 0;
  const result = await withTransientRetry(async () => {
    attempts++;
    if (attempts < 3) throw new Error("503 Service Unavailable");
    return "ok";
  }, [10, 10, 10]);
  assert.equal(result, "ok");
  assert.equal(attempts, 3);
});

test("withTransientRetry: gives up after delays exhausted", async () => {
  let attempts = 0;
  await assert.rejects(
    withTransientRetry(async () => {
      attempts++;
      throw new Error("503 still down");
    }, [10, 10]),
    /503 still down/,
  );
  assert.equal(attempts, 3); // initial + 2 retries
});

test("withTransientRetry: terminal error doesn't retry", async () => {
  let attempts = 0;
  await assert.rejects(
    withTransientRetry(async () => {
      attempts++;
      throw new Error("404 Not Found");
    }, [10, 10]),
    /404 Not Found/,
  );
  assert.equal(attempts, 1);
});

test("captureCharterVersion: posts diff message on v1 → v2 transition", () => {
  const { db, dir, repoId } = freshDb();
  try {
    const v1 = {
      vision: "Reliable AI dev agent.",
      priorities: [{ id: "reliability", weight: 0.5, rubric: "graceful failure" }],
      out_of_bounds: [],
      out_of_bounds_paths: [],
      definition_of_done: [],
    };
    const ver1 = captureCharterVersion(db, repoId, v1);
    assert.equal(ver1, 1);
    let messages = recentMessages(db, repoId, 5);
    // First version is silent.
    assert.equal(messages.filter((m) => m.metadata?.kind === "charter_diff").length, 0);

    const v2 = {
      ...v1,
      priorities: [
        { id: "reliability", weight: 0.7, rubric: "graceful failure" },
        { id: "observability", weight: 0.3, rubric: "metrics endpoint" },
      ],
    };
    const ver2 = captureCharterVersion(db, repoId, v2);
    assert.equal(ver2, 2);
    messages = recentMessages(db, repoId, 5);
    const diff = messages.find((m) => m.metadata?.kind === "charter_diff");
    assert.ok(diff);
    assert.match(diff.body, /Priorities added: observability/);
    assert.match(diff.body, /reliability: 0\.50 → 0\.70/);
  } finally {
    cleanup(dir);
  }
});
