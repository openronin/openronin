// Outcome follow-up sweep.
//
// Verifies:
//   • parseIssueNumberFromOutcomeDetails extracts #N from executor output
//   • pickFollowupCandidates respects the 14-day window and not-recently-observed
//   • runOutcomeFollowupSweep records the right kind for open / closed-completed /
//     closed-not_planned issues
//   • a terminal observation (closed) prevents further sweeps from picking it

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initDb } from "../dist/storage/db.js";
import { recordDecision, setDecisionOutcome } from "../dist/director/decisions.js";
import {
  followupsForDecision,
  parseIssueNumberFromOutcomeDetails,
  pickFollowupCandidates,
  recordFollowup,
  runOutcomeFollowupSweep,
  summariseFollowup,
} from "../dist/director/outcome-followup.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "openronin-followup-test-"));
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

test("parseIssueNumberFromOutcomeDetails: pulls #N out of the executor's output", () => {
  assert.equal(
    parseIssueNumberFromOutcomeDetails("issue #42 created (https://github.com/o/r/issues/42)"),
    42,
  );
  assert.equal(parseIssueNumberFromOutcomeDetails("issue #1234 created"), 1234);
  assert.equal(parseIssueNumberFromOutcomeDetails(null), null);
  assert.equal(parseIssueNumberFromOutcomeDetails("nothing matching"), null);
});

test("pickFollowupCandidates: only executed create_issue rows within the window", () => {
  const { db, dir, repoId } = freshDb();
  try {
    const goodDecision = recordDecision(db, {
      repoId,
      decisionType: "create_issue",
      rationale: "good candidate within the window",
      payload: { title: "x" },
    });
    setDecisionOutcome(db, goodDecision.id, "executed", "issue #100 created");

    const badNonExecuted = recordDecision(db, {
      repoId,
      decisionType: "create_issue",
      rationale: "still pending — not a candidate",
      payload: { title: "y" },
      outcome: "pending",
    });
    void badNonExecuted; // explicit

    const badCommentDecision = recordDecision(db, {
      repoId,
      decisionType: "comment_on_issue",
      rationale: "wrong type — not a candidate",
      payload: { issue_number: 1, body: "hi" },
    });
    setDecisionOutcome(db, badCommentDecision.id, "executed", "comment posted on #1");

    const candidates = pickFollowupCandidates(db, repoId);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].decision_id, goodDecision.id);
  } finally {
    cleanup(dir);
  }
});

test("pickFollowupCandidates: hides decisions with a recent observation", () => {
  const { db, dir, repoId } = freshDb();
  try {
    const d = recordDecision(db, {
      repoId,
      decisionType: "create_issue",
      rationale: "candidate that already had a recent observation",
      payload: { title: "x" },
    });
    setDecisionOutcome(db, d.id, "executed", "issue #100 created");

    recordFollowup(db, {
      decisionId: d.id,
      kind: "issue_open",
      detail: "still open",
      refNumber: 100,
    });

    assert.equal(pickFollowupCandidates(db, repoId).length, 0);
  } finally {
    cleanup(dir);
  }
});

test("pickFollowupCandidates: terminal observation hides forever (within window)", () => {
  const { db, dir, repoId } = freshDb();
  try {
    const d = recordDecision(db, {
      repoId,
      decisionType: "create_issue",
      rationale: "candidate that already terminally resolved",
      payload: { title: "x" },
    });
    setDecisionOutcome(db, d.id, "executed", "issue #100 created");

    recordFollowup(db, {
      decisionId: d.id,
      kind: "issue_merged_via_pr",
      detail: "closed",
      refNumber: 100,
    });
    // Backdate the observation to make it "old" — but the kind is terminal
    // so the row should still be hidden.
    db.prepare(
      `UPDATE director_outcome_followups SET observed_at = datetime('now', '-3 days')`,
    ).run();
    assert.equal(pickFollowupCandidates(db, repoId).length, 0);
  } finally {
    cleanup(dir);
  }
});

function makeStubVcs(itemByNumber) {
  return {
    id: "stub",
    listOpenItems: async function* () {},
    async getItem(_repo, n) {
      const item = itemByNumber.get(n);
      if (!item) {
        const err = new Error("404 Not Found");
        err.status = 404;
        throw err;
      }
      return item;
    },
    async postComment() { return { id: "0", url: "" }; },
    async updateComment() {},
    async closeItem() {},
    async listAllPrFeedback() { return []; },
    verifyWebhookSignature() { return true; },
    async createIssue() { return { number: 0, url: "" }; },
    async addLabels() {},
    async removeLabels() {},
    async approvePullRequest() {},
    async mergePullRequest() { return { merged: false }; },
  };
}

test("runOutcomeFollowupSweep: records issue_open / issue_merged_via_pr / issue_closed_no_pr", async () => {
  const { db, dir, repoId } = freshDb();
  try {
    const dOpen = recordDecision(db, {
      repoId,
      decisionType: "create_issue",
      rationale: "issue is still open in stub VCS",
      payload: { title: "open" },
    });
    setDecisionOutcome(db, dOpen.id, "executed", "issue #100 created");

    const dMerged = recordDecision(db, {
      repoId,
      decisionType: "create_issue",
      rationale: "issue closed by a merged PR (state_reason=completed)",
      payload: { title: "merged" },
    });
    setDecisionOutcome(db, dMerged.id, "executed", "issue #200 created");

    const dStale = recordDecision(db, {
      repoId,
      decisionType: "create_issue",
      rationale: "issue closed without resolution",
      payload: { title: "stale" },
    });
    setDecisionOutcome(db, dStale.id, "executed", "issue #300 created");

    const stub = makeStubVcs(
      new Map([
        [100, { number: 100, kind: "issue", title: "Open one", body: "", author: "x", authorAssociation: "MEMBER", state: "open", labels: [], createdAt: "2026-05-01T00:00:00Z", updatedAt: "2026-05-05T00:00:00Z", url: "https://example.test/issues/100" }],
        [200, { number: 200, kind: "issue", title: "Merged one", body: "", author: "x", authorAssociation: "MEMBER", state: "closed", stateReason: "completed", labels: [], createdAt: "2026-05-01T00:00:00Z", updatedAt: "2026-05-05T00:00:00Z", url: "https://example.test/issues/200" }],
        [300, { number: 300, kind: "issue", title: "Stale one", body: "", author: "x", authorAssociation: "MEMBER", state: "closed", stateReason: "not_planned", labels: [], createdAt: "2026-05-01T00:00:00Z", updatedAt: "2026-05-05T00:00:00Z", url: "https://example.test/issues/300" }],
      ]),
    );

    const result = await runOutcomeFollowupSweep(db, repoId, "openronin", "openronin", stub);
    assert.equal(result.observed, 3);
    assert.equal(result.errored, 0);

    assert.equal(followupsForDecision(db, dOpen.id)[0].kind, "issue_open");
    assert.equal(followupsForDecision(db, dMerged.id)[0].kind, "issue_merged_via_pr");
    assert.equal(followupsForDecision(db, dStale.id)[0].kind, "issue_closed_no_pr");
  } finally {
    cleanup(dir);
  }
});

test("summariseFollowup: human-readable strings include the ref number", () => {
  assert.match(
    summariseFollowup({ kind: "issue_merged_via_pr", refNumber: 42, observedAt: "", id: 1, decisionId: 1, detail: "", refUrl: null }),
    /merged.*#42/,
  );
  assert.match(
    summariseFollowup({ kind: "issue_open", refNumber: 7, observedAt: "", id: 1, decisionId: 1, detail: "", refUrl: null }),
    /still open.*#7/,
  );
});
