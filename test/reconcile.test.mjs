import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeItem(overrides = {}) {
  return {
    number: 42,
    kind: "issue",
    title: "Test issue",
    body: "Some body text",
    author: "alice",
    authorAssociation: "CONTRIBUTOR",
    state: "open",
    labels: ["bug"],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-02T00:00:00Z",
    url: "https://github.com/test/repo/issues/42",
    ...overrides,
  };
}

function makeProvider(items) {
  return {
    id: "mock",
    async *listOpenItems() {
      for (const item of items) yield item;
    },
    async getItem() {
      throw new Error("not expected");
    },
    async postComment() {
      throw new Error("not expected");
    },
    async updateComment() {
      throw new Error("not expected");
    },
    async closeItem() {
      throw new Error("not expected");
    },
    async listAllPrFeedback() {
      return [];
    },
    verifyWebhookSignature() {
      return true;
    },
  };
}

const cadence = { hot: "1h", default: "24h", cold: "72h" };

const baseRepo = {
  provider: "github",
  owner: "test",
  name: "repo",
  lanes: ["review"],
  cadence,
  patch_trigger_label: undefined,
  pr_dialog_skip_authors: [],
  auto_merge: { enabled: false },
  protected_labels: [],
  language_for_communication: "English",
  language_for_commits: "English",
  language_for_code_identifiers: "English",
};

test("reconcile: new item is enqueued at high priority", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "reconcile-test-"));
  try {
    const { initDb } = await import("../dist/storage/db.js");
    const { reconcileRepo } = await import("../dist/scheduler/reconcile.js");

    const db = initDb(tmp);
    const item = makeItem();
    const provider = makeProvider([item]);

    const result = await reconcileRepo(db, baseRepo, cadence, provider);

    assert.equal(result.enqueued, 1);
    const task = db.prepare("SELECT * FROM tasks WHERE external_id = '42'").get();
    assert.equal(task.status, "pending");
    assert.equal(task.priority, "high");
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("reconcile: done item with unchanged content is not re-enqueued", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "reconcile-test-"));
  try {
    const { initDb } = await import("../dist/storage/db.js");
    const { ensureRepo, upsertTask, recordTaskDecision } = await import("../dist/storage/tasks.js");
    const { computeItemSnapshot } = await import("../dist/lib/snapshot.js");
    const { reconcileRepo } = await import("../dist/scheduler/reconcile.js");

    const db = initDb(tmp);
    const item = makeItem();

    const repoId = ensureRepo(db, { provider: "github", owner: "test", name: "repo" });
    const taskId = upsertTask(db, repoId, "42", "issue");
    const snapshot = computeItemSnapshot(item);
    recordTaskDecision(db, taskId, snapshot, '{"decision":"keep_open"}');
    db.prepare(
      "UPDATE tasks SET status = 'done', next_due_at = datetime('now', '-1 hour') WHERE id = ?",
    ).run(taskId);

    const provider = makeProvider([item]);
    const result = await reconcileRepo(db, baseRepo, cadence, provider);

    assert.equal(result.enqueued, 0);
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    assert.equal(task.status, "done");
    // next_due_at should have been bumped forward
    const nextDue = new Date(task.next_due_at);
    assert.ok(nextDue.getTime() > Date.now(), "next_due_at should be in the future");
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("reconcile: done item with changed labels triggers re-enqueue", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "reconcile-test-"));
  try {
    const { initDb } = await import("../dist/storage/db.js");
    const { ensureRepo, upsertTask, recordTaskDecision } = await import("../dist/storage/tasks.js");
    const { computeItemSnapshot } = await import("../dist/lib/snapshot.js");
    const { reconcileRepo } = await import("../dist/scheduler/reconcile.js");

    const db = initDb(tmp);
    const oldItem = makeItem({ labels: ["bug"] });

    const repoId = ensureRepo(db, { provider: "github", owner: "test", name: "repo" });
    const taskId = upsertTask(db, repoId, "42", "issue");
    const oldSnapshot = computeItemSnapshot(oldItem);
    recordTaskDecision(db, taskId, oldSnapshot, '{"decision":"keep_open"}');
    db.prepare(
      "UPDATE tasks SET status = 'done', next_due_at = datetime('now', '-1 hour') WHERE id = ?",
    ).run(taskId);

    // Same item but labels changed
    const newItem = makeItem({ labels: ["bug", "enhancement"] });
    const provider = makeProvider([newItem]);
    const result = await reconcileRepo(db, baseRepo, cadence, provider);

    assert.equal(result.enqueued, 1);
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    assert.equal(task.status, "pending");
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
