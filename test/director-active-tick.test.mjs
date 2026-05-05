// Per-repo active-tick lock + thinking indicator.
//
// Verifies:
//   • tryAcquire returns true once, false on a second concurrent attempt
//   • a stale (TTL-expired) lock can be reclaimed
//   • getActiveTick filters out stale rows
//   • release drops the lock immediately
//   • withActiveTick wraps a body with auto-release

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initDb } from "../dist/storage/db.js";
import {
  getActiveTick,
  releaseTick,
  tryAcquireTick,
  withActiveTick,
} from "../dist/director/active-tick.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "openronin-active-tick-test-"));
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

test("tryAcquireTick: first caller wins, second is rejected", () => {
  const { db, dir, repoId } = freshDb();
  try {
    assert.equal(tryAcquireTick(db, repoId, "scheduled"), true);
    assert.equal(tryAcquireTick(db, repoId, "user_message"), false);
    const active = getActiveTick(db, repoId);
    assert.ok(active);
    assert.equal(active.reason, "scheduled");
  } finally {
    cleanup(dir);
  }
});

test("releaseTick: drops the lock immediately", () => {
  const { db, dir, repoId } = freshDb();
  try {
    tryAcquireTick(db, repoId, "scheduled");
    releaseTick(db, repoId);
    assert.equal(getActiveTick(db, repoId), null);
    assert.equal(tryAcquireTick(db, repoId, "user_message"), true);
  } finally {
    cleanup(dir);
  }
});

test("getActiveTick: stale rows are filtered out", () => {
  const { db, dir, repoId } = freshDb();
  try {
    // Insert a row that's already past its TTL by backdating started_at.
    db.prepare(
      `INSERT INTO director_active_ticks (repo_id, started_at, holder_pid, reason, ttl_s)
       VALUES (?, datetime('now', '-10 minutes'), ?, 'stale', 60)`,
    ).run(repoId, process.pid);
    assert.equal(getActiveTick(db, repoId), null);
    // ...and a fresh acquire reclaims the slot.
    assert.equal(tryAcquireTick(db, repoId, "scheduled"), true);
    const active = getActiveTick(db, repoId);
    assert.ok(active);
    assert.equal(active.reason, "scheduled");
  } finally {
    cleanup(dir);
  }
});

test("withActiveTick: runs body, releases on success", async () => {
  const { db, dir, repoId } = freshDb();
  try {
    const result = await withActiveTick(db, repoId, "scheduled", async () => {
      assert.ok(getActiveTick(db, repoId)); // held during body
      return 42;
    });
    assert.equal(result, 42);
    assert.equal(getActiveTick(db, repoId), null); // released after
  } finally {
    cleanup(dir);
  }
});

test("withActiveTick: releases on throw", async () => {
  const { db, dir, repoId } = freshDb();
  try {
    await assert.rejects(
      withActiveTick(db, repoId, "scheduled", async () => {
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal(getActiveTick(db, repoId), null);
  } finally {
    cleanup(dir);
  }
});

test("withActiveTick: returns null when lock is held, body not invoked", async () => {
  const { db, dir, repoId } = freshDb();
  try {
    tryAcquireTick(db, repoId, "scheduled");
    let invoked = false;
    const result = await withActiveTick(db, repoId, "user_message", async () => {
      invoked = true;
      return 1;
    });
    assert.equal(result, null);
    assert.equal(invoked, false);
  } finally {
    cleanup(dir);
  }
});
