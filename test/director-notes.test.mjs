// Standing notes — long-term operator preferences.
//
// Verifies:
//   • recordNote / listNotes / deleteNote round-trip
//   • renderNotesForPrompt formats lines as "- kind: body"
//   • runTick can execute a remember_preference decision and the next
//     state snapshot includes the new note in standingNotes

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initDb } from "../dist/storage/db.js";
import { deleteNote, listNotes, recordNote, renderNotesForPrompt } from "../dist/director/notes.js";
import { runTick } from "../dist/director/tick.js";
import { captureStateSnapshot } from "../dist/director/state.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "openronin-notes-test-"));
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

test("recordNote / listNotes / deleteNote round-trip", () => {
  const { db, dir, repoId } = freshDb();
  try {
    const a = recordNote(db, { repoId, kind: "preference", body: "no scope > 200 LOC" });
    const b = recordNote(db, { repoId, kind: "constraint", body: "comment in Russian" });
    const all = listNotes(db, repoId);
    assert.equal(all.length, 2);
    assert.equal(all[0].id, b.id); // most recent first
    assert.equal(deleteNote(db, repoId, a.id), true);
    assert.equal(listNotes(db, repoId).length, 1);
  } finally {
    cleanup(dir);
  }
});

test("renderNotesForPrompt: empty list → placeholder; non-empty formats kv-style", () => {
  assert.match(renderNotesForPrompt([]), /no standing notes/);
  const formatted = renderNotesForPrompt([
    {
      id: 1,
      repoId: 1,
      ts: "2026-05-05",
      kind: "preference",
      body: "no work on weekends",
      sourceMessageId: null,
    },
    {
      id: 2,
      repoId: 1,
      ts: "2026-05-05",
      kind: "fact",
      body: "deploys go through 0srv",
      sourceMessageId: null,
    },
  ]);
  assert.match(formatted, /- preference: no work on weekends/);
  assert.match(formatted, /- fact: deploys go through 0srv/);
});

test("captureStateSnapshot: includes standingNotes", () => {
  const { db, dir, repoId } = freshDb();
  try {
    recordNote(db, { repoId, kind: "preference", body: "issues need an Acceptance section" });
    const snapshot = captureStateSnapshot(db, repoId, "openronin", "openronin");
    assert.equal(snapshot.standingNotes.length, 1);
    assert.equal(snapshot.standingNotes[0].body, "issues need an Acceptance section");
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
  mode: "propose",
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

test("runTick: remember_preference decision persists a note (no approval needed)", async () => {
  const { db, dir, repoId } = freshDb();
  try {
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
          return {
            content: "{}",
            json: {
              observations: "Operator stated a stable preference about issue scope.",
              reasoning: "Persist this so it survives the recent_chat windowing.",
              decisions: [
                {
                  type: "remember_preference",
                  rationale: "operator stated stable preference about scope cap",
                  payload: {
                    kind: "preference",
                    body: "Issues should not exceed 200 LOC of changes",
                  },
                },
              ],
            },
            usage: { tokensIn: 100, tokensOut: 50, costUsd: 0.001 },
            finishReason: "end_turn",
            durationMs: 50,
          };
        },
      }),
    });
    assert.equal(result.status, "ok");
    const notes = listNotes(db, repoId);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].kind, "preference");
    assert.match(notes[0].body, /200 LOC/);
  } finally {
    cleanup(dir);
  }
});
