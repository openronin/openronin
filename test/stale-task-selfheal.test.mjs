// 404-driven self-heal: a task pointing at an issue/PR that no longer
// exists on the current owner gets parked permanently instead of polling
// forever. Production hit this on the openronin/openronin rename — issues
// #38 and #39 produced ~10 GET /pulls/.../reviews 404s per minute until
// we manually patched the DB.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initDb } from "../dist/storage/db.js";
import { processOne } from "../dist/scheduler/worker.js";
import { upsertTask } from "../dist/storage/tasks.js";
import { enqueue } from "../dist/scheduler/queue.js";

function getTaskRow(db, id) {
  return db.prepare("SELECT id, status, next_due_at FROM tasks WHERE id = ?").get(id);
}

// GithubVcsProvider construction throws without GITHUB_TOKEN — set a
// dummy value so we can monkey-patch the prototype's getItem.
process.env.GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "test-dummy-token";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "openronin-stale-test-"));
  const db = initDb(dir);
  // Minimal repo row + matching config so worker.findRepo resolves.
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

const baseRepoConfig = {
  provider: "github",
  owner: "openronin",
  name: "openronin",
  watched: true,
  lanes: ["triage"],
  cadence: undefined,
  protected_labels: [],
  skip_authors: [],
  allowed_close_reasons: [],
  engine_overrides: {},
  prompt_overrides: {},
  patch_trigger_label: "openronin:do-it",
  patch_default_base: "main",
  protected_paths: [],
  max_diff_lines: 500,
  draft_pr: true,
  patch_multi_max_critique_iterations: 2,
  pr_dialog_max_iterations: 10,
  pr_dialog_skip_authors: [],
  auto_merge: {
    enabled: false,
    strategy: "squash",
    require_checks_pass: true,
    unblock_draft: true,
    resolve_conflicts: true,
    resolve_conflicts_max_attempts: 3,
  },
  deploy: {
    mode: "disabled",
    trigger_branch: "main",
    bot_login: "openronin[bot]",
    require_bot_push: true,
    commands: [],
  },
  language_for_communication: "English",
  language_for_commits: "English",
  language_for_code_identifiers: "English",
  in_progress_label: "openronin:in-progress",
  awaiting_answer_label: "openronin:awaiting-answer",
  awaiting_action_label: "openronin:awaiting-action",
  acknowledge_with_reaction: true,
  acknowledge_with_comment: true,
  director: { enabled: false },
};

// Stub out the GithubVcsProvider via the env-key path: with no GITHUB_TOKEN
// the provider construction throws. We can't easily mock the import inside
// worker.ts without a DI hook. Instead, isolate isVcs404 via a direct test
// against the worker's catch path: we inject a "fetch" failure by setting
// a known-bad GITHUB_TOKEN and observing a 401-style failure ≠ 404 →
// task is markError'd but with a regular delay. Then we directly assert
// on isVcs404 logic by re-exporting it... actually that's a private
// function. Simpler: cover the predicate via a tiny isolated test that
// imports the same code shape. For end-to-end behaviour, the manual SQL
// fix in production already validated the path; what's tested here is
// the isVcs404 detector and the markError-with-long-delay flag.

test("worker: 404 from VCS parks the task with a year-long retry delay", async () => {
  const { db, dir, repoId } = freshDb();
  try {
    // Build the runtime config the worker expects.
    const config = {
      dataDir: dir,
      global: {
        server: { port: 8090, baseUrl: "http://localhost:8090", adminUser: "admin" },
        engines: { defaults: {} },
        cadence: { hot: "5m", default: "1h", cold: "24h" },
        cost_caps: { per_task_usd: 5, per_day_usd: 50 },
        rate_limit_cooldown: "30m",
        scheduler: { reconcile_interval: "15m", drain_interval: "30s", drain_batch_size: 5 },
        telegram: { allowed_user_ids: [], poll_timeout_seconds: 30 },
      },
      repos: [baseRepoConfig],
    };
    const taskId = upsertTask(db, repoId, "9999", "issue");
    enqueue(db, taskId, "normal", null);

    // Stub provider.getItem to throw a 404. We monkey-patch GithubVcsProvider
    // by replacing the prototype method before processOne runs.
    const githubMod = await import("../dist/providers/github.js");
    const orig = githubMod.GithubVcsProvider.prototype.getItem;
    githubMod.GithubVcsProvider.prototype.getItem = function () {
      const err = new Error("HttpError: Not Found");
      err.status = 404;
      throw err;
    };
    try {
      const result = await processOne(db, config);
      assert.ok(result);
      assert.equal(result.status, "error");
      assert.equal(result.detail, "vcs-404");

      const after = getTaskRow(db, taskId);
      // markError sets status=pending with next_due_at far in the future
      // — a year out for our 404 case. The stored value is already ISO
      // with a trailing Z, so feed it straight to Date.
      const nextMs = new Date(after.next_due_at).getTime();
      assert.ok(
        nextMs > Date.now() + 364 * 24 * 60 * 60 * 1000,
        `expected next_due_at >= 364d out, got ${after.next_due_at}`,
      );
    } finally {
      githubMod.GithubVcsProvider.prototype.getItem = orig;
    }
  } finally {
    cleanup(dir);
  }
});

test("worker: non-404 errors keep their normal short retry", async () => {
  const { db, dir, repoId } = freshDb();
  try {
    const config = {
      dataDir: dir,
      global: {
        server: { port: 8090, baseUrl: "http://localhost:8090", adminUser: "admin" },
        engines: { defaults: {} },
        cadence: { hot: "5m", default: "1h", cold: "24h" },
        cost_caps: { per_task_usd: 5, per_day_usd: 50 },
        rate_limit_cooldown: "30m",
        scheduler: { reconcile_interval: "15m", drain_interval: "30s", drain_batch_size: 5 },
        telegram: { allowed_user_ids: [], poll_timeout_seconds: 30 },
      },
      repos: [baseRepoConfig],
    };
    const taskId = upsertTask(db, repoId, "1234", "issue");
    enqueue(db, taskId, "normal", null);

    const githubMod = await import("../dist/providers/github.js");
    const orig = githubMod.GithubVcsProvider.prototype.getItem;
    githubMod.GithubVcsProvider.prototype.getItem = function () {
      const err = new Error("HttpError: Internal Server Error");
      err.status = 500;
      throw err;
    };
    try {
      const result = await processOne(db, config);
      assert.ok(result);
      assert.equal(result.status, "error");
      assert.notEqual(result.detail, "vcs-404");

      const after = getTaskRow(db, taskId);
      // Default error retry — within hours, NOT a year out. ISO with Z.
      const nextMs = new Date(after.next_due_at).getTime();
      assert.ok(
        nextMs < Date.now() + 24 * 60 * 60 * 1000,
        `expected next_due_at within 24h, got ${after.next_due_at}`,
      );
    } finally {
      githubMod.GithubVcsProvider.prototype.getItem = orig;
    }
  } finally {
    cleanup(dir);
  }
});
