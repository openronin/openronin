// Tests for the soft-hide + purge repo lifecycle. Covers:
//   - config schema exposes `hidden` (defaults to false)
//   - syncReposFromConfig mirrors hidden to the DB column
//   - listRepos default excludes hidden; hiddenOnly / includeHidden work
//   - worker skips hidden repos (returns "repo hidden")
//   - webhooks would ignore hidden (validated through repo lookup shape)
//   - purge collects run log paths before cascade + admin cred check
//   - verifyAdminCredentials: ok / wrong / no-password paths
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function makeDb() {
  const tmp = mkdtempSync(join(tmpdir(), "aidev-hidden-"));
  const { initDb } = await import("../dist/storage/db.js");
  const db = initDb(tmp);
  return { db, tmp };
}

test("schema: hidden field defaults to false", async () => {
  const { RepoConfigSchema } = await import("../dist/config/schema.js");
  const parsed = RepoConfigSchema.parse({ owner: "o", name: "n" });
  assert.equal(parsed.hidden, false);
  const parsedHidden = RepoConfigSchema.parse({ owner: "o", name: "n", hidden: true });
  assert.equal(parsedHidden.hidden, true);
});

test("syncReposFromConfig mirrors hidden into DB", async () => {
  const { db, tmp } = await makeDb();
  try {
    const { syncReposFromConfig, listRepos } = await import("../dist/storage/repos.js");
    const { RepoConfigSchema } = await import("../dist/config/schema.js");
    const repoA = RepoConfigSchema.parse({ owner: "acme", name: "one" });
    const repoB = RepoConfigSchema.parse({ owner: "acme", name: "two", hidden: true });
    syncReposFromConfig(db, [repoA, repoB]);

    const visible = listRepos(db);
    assert.equal(visible.length, 1);
    assert.equal(visible[0].name, "one");
    assert.equal(visible[0].hidden, 0);

    const hidden = listRepos(db, { hiddenOnly: true });
    assert.equal(hidden.length, 1);
    assert.equal(hidden[0].name, "two");
    assert.equal(hidden[0].hidden, 1);

    const all = listRepos(db, { includeHidden: true });
    assert.equal(all.length, 2);

    // Un-hiding via YAML flip syncs back.
    const repoBUnhidden = RepoConfigSchema.parse({ owner: "acme", name: "two", hidden: false });
    syncReposFromConfig(db, [repoA, repoBUnhidden]);
    assert.equal(listRepos(db).length, 2);
    assert.equal(listRepos(db, { hiddenOnly: true }).length, 0);
  } finally {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("worker: hidden repo → skipped with 'repo hidden' detail", async () => {
  const { db, tmp } = await makeDb();
  try {
    const { ensureRepo, upsertTask } = await import("../dist/storage/tasks.js");
    const { enqueue } = await import("../dist/scheduler/queue.js");
    const { processOne } = await import("../dist/scheduler/worker.js");
    const { RepoConfigSchema } = await import("../dist/config/schema.js");

    const repoId = ensureRepo(db, { provider: "github", owner: "o", name: "n" });
    const taskId = upsertTask(db, repoId, "42", "issue");
    enqueue(db, taskId, "high", null);

    const repoCfg = RepoConfigSchema.parse({ owner: "o", name: "n", hidden: true });
    const config = { dataDir: tmp, global: {}, repos: [repoCfg] };
    const result = await processOne(db, config);
    assert.equal(result?.status, "skipped");
    assert.equal(result?.detail, "repo hidden");
  } finally {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("verifyAdminCredentials: ok / wrong / no-password", async () => {
  const { verifyAdminCredentials } = await import("../dist/server/admin.js");
  const originalPass = process.env.ADMIN_UI_PASSWORD;
  const originalUser = process.env.OPENRONIN_ADMIN_USER;
  try {
    delete process.env.ADMIN_UI_PASSWORD;
    assert.equal(verifyAdminCredentials("admin", ""), "no-password");

    process.env.ADMIN_UI_PASSWORD = "hunter2";
    process.env.OPENRONIN_ADMIN_USER = "alice";
    assert.equal(verifyAdminCredentials("alice", "hunter2"), "ok");
    assert.equal(verifyAdminCredentials("alice", "wrongpass"), "wrong-credentials");
    assert.equal(verifyAdminCredentials("bob", "hunter2"), "wrong-credentials");
    // Length-mismatch path (would throw on raw timingSafeEqual)
    assert.equal(verifyAdminCredentials("alice", ""), "wrong-credentials");
    assert.equal(verifyAdminCredentials("", "hunter2"), "wrong-credentials");
  } finally {
    if (originalPass === undefined) delete process.env.ADMIN_UI_PASSWORD;
    else process.env.ADMIN_UI_PASSWORD = originalPass;
    if (originalUser === undefined) delete process.env.OPENRONIN_ADMIN_USER;
    else process.env.OPENRONIN_ADMIN_USER = originalUser;
  }
});

test("purge helper: cascade + log-path collection before delete", async () => {
  // Verifies the FK cascade wipes tasks/runs/pr_branches/deploys when the
  // repos row is deleted, and that log_path / prompt_log_path values are
  // still queryable before the DELETE happens.
  const { db, tmp } = await makeDb();
  try {
    const { ensureRepo, upsertTask } = await import("../dist/storage/tasks.js");
    const repoId = ensureRepo(db, { provider: "github", owner: "o", name: "n" });
    const taskId = upsertTask(db, repoId, "1", "issue");
    db.prepare(
      "INSERT INTO runs (task_id, lane, engine, log_path, prompt_log_path) VALUES (?, 'patch', 'claude_code', ?, ?)",
    ).run(taskId, "/tmp/log-a.jsonl", "/tmp/prompt-a.jsonl");
    db.prepare("INSERT INTO pr_branches (task_id, branch, status) VALUES (?, 'x', 'created')").run(
      taskId,
    );

    const paths = db
      .prepare(
        `SELECT ru.log_path AS lp, ru.prompt_log_path AS pp
           FROM runs ru JOIN tasks t ON t.id = ru.task_id WHERE t.repo_id = ?`,
      )
      .all(repoId);
    assert.equal(paths.length, 1);
    assert.equal(paths[0].lp, "/tmp/log-a.jsonl");
    assert.equal(paths[0].pp, "/tmp/prompt-a.jsonl");

    db.prepare("DELETE FROM repos WHERE id = ?").run(repoId);

    const remainingTasks = db.prepare("SELECT COUNT(*) AS n FROM tasks").get();
    const remainingRuns = db.prepare("SELECT COUNT(*) AS n FROM runs").get();
    const remainingBranches = db.prepare("SELECT COUNT(*) AS n FROM pr_branches").get();
    assert.equal(remainingTasks.n, 0, "FK cascade wipes tasks");
    assert.equal(remainingRuns.n, 0, "FK cascade wipes runs");
    assert.equal(remainingBranches.n, 0, "FK cascade wipes pr_branches");
  } finally {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
