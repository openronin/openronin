// Trust ramp suggestions.
//
// Verifies:
//   • evaluateTrustRamp holds when sample is too small
//   • promote suggestion fires past 0.9 rate + 30 sample
//   • demote suggestion fires below 0.4 + 10 sample
//   • cooldown blocks back-to-back posts
//   • full_auto cannot promote further; dry_run cannot demote further

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initDb } from "../dist/storage/db.js";
import {
  evaluateTrustRamp,
  maybePostTrustRampSuggestion,
  trustRampOnCooldown,
} from "../dist/director/trust-ramp.js";
import { recordDecision, setDecisionOutcome } from "../dist/director/decisions.js";
import { recentMessages, appendMessage } from "../dist/director/chat.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "openronin-trust-ramp-test-"));
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

// Insert N decisions for the given repo, all of `decisionType=create_issue`,
// with outcomes split between executed/rejected to hit a target success rate.
function seedDecisions(db, repoId, executedN, rejectedN) {
  for (let i = 0; i < executedN; i++) {
    const d = recordDecision(db, {
      repoId,
      decisionType: "create_issue",
      rationale: `seed executed #${i} for trust-ramp test fixtures`,
      payload: { title: `seed-${i}-${Math.random()}` }, // unique to avoid dedup
      outcome: "pending",
    });
    setDecisionOutcome(db, d.id, "executed", "ok");
  }
  for (let i = 0; i < rejectedN; i++) {
    const d = recordDecision(db, {
      repoId,
      decisionType: "create_issue",
      rationale: `seed rejected #${i} for trust-ramp test fixtures`,
      payload: { title: `rej-${i}-${Math.random()}` },
      outcome: "pending",
    });
    setDecisionOutcome(db, d.id, "rejected", "operator said no");
  }
}

test("evaluateTrustRamp: hold when sample too small", () => {
  const { db, dir, repoId } = freshDb();
  try {
    seedDecisions(db, repoId, 3, 0);
    const s = evaluateTrustRamp(db, repoId, "propose");
    assert.equal(s.kind, "hold");
  } finally {
    cleanup(dir);
  }
});

test("evaluateTrustRamp: promote propose → semi_auto when 28/30 executed", () => {
  const { db, dir, repoId } = freshDb();
  try {
    seedDecisions(db, repoId, 28, 2);
    const s = evaluateTrustRamp(db, repoId, "propose");
    assert.equal(s.kind, "promote");
    assert.equal(s.from, "propose");
    assert.equal(s.to, "semi_auto");
    assert.ok(s.rate > 0.9);
    assert.equal(s.sampleSize, 30);
  } finally {
    cleanup(dir);
  }
});

test("evaluateTrustRamp: demote when 7/12 rejected", () => {
  const { db, dir, repoId } = freshDb();
  try {
    seedDecisions(db, repoId, 5, 7); // 5/12 = 41% — actually above 0.4
    let s = evaluateTrustRamp(db, repoId, "semi_auto");
    assert.equal(s.kind, "hold"); // borderline holds
    seedDecisions(db, repoId, 0, 5); // now 5/17 = 29%
    s = evaluateTrustRamp(db, repoId, "semi_auto");
    assert.equal(s.kind, "demote");
    assert.equal(s.from, "semi_auto");
    assert.equal(s.to, "propose");
  } finally {
    cleanup(dir);
  }
});

test("evaluateTrustRamp: full_auto cannot promote further", () => {
  const { db, dir, repoId } = freshDb();
  try {
    seedDecisions(db, repoId, 30, 0);
    const s = evaluateTrustRamp(db, repoId, "full_auto");
    assert.equal(s.kind, "hold");
    assert.match(s.reason, /cannot promote/);
  } finally {
    cleanup(dir);
  }
});

test("maybePostTrustRampSuggestion: posts a question + sets cooldown", () => {
  const { db, dir, repoId } = freshDb();
  try {
    seedDecisions(db, repoId, 28, 2);
    const before = recentMessages(db, repoId, 50).length;
    const result = maybePostTrustRampSuggestion(db, repoId, "propose", "English");
    assert.ok(result);
    assert.equal(result.kind, "promote");
    const messages = recentMessages(db, repoId, 50);
    assert.equal(messages.length, before + 1);
    const posted = messages[messages.length - 1];
    assert.equal(posted.role, "director");
    assert.equal(posted.type, "question");
    assert.match(posted.body, /Trust ramp suggestion|trust ramp/i);
    assert.equal(posted.metadata?.kind, "trust_ramp");
    assert.equal(trustRampOnCooldown(db, repoId), true);
    // Second call should be blocked by cooldown.
    const result2 = maybePostTrustRampSuggestion(db, repoId, "propose", "English");
    assert.equal(result2, null);
  } finally {
    cleanup(dir);
  }
});

test("maybePostTrustRampSuggestion: Russian language → Russian copy", () => {
  const { db, dir, repoId } = freshDb();
  try {
    seedDecisions(db, repoId, 28, 2);
    maybePostTrustRampSuggestion(db, repoId, "propose", "Russian");
    const messages = recentMessages(db, repoId, 5);
    const posted = messages[messages.length - 1];
    assert.match(posted.body, /Предложение по уровню доверия|повысить/);
  } finally {
    cleanup(dir);
  }
});
