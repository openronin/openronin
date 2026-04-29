import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("dist build artifacts exist", () => {
  assert.ok(existsSync("dist/index.js"), "dist/index.js must exist after build");
  assert.ok(existsSync("dist/server/healthz.js"), "dist/server/healthz.js must exist");
  assert.ok(existsSync("dist/cli/index.js"), "dist/cli/index.js must exist");
  assert.ok(existsSync("dist/providers/github.js"), "dist/providers/github.js must exist");
});

test("config loader produces a valid runtime config with defaults", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "aidev-test-"));
  try {
    process.env.OPENRONIN_DATA_DIR = tmp;
    const { loadConfig } = await import("../dist/config/loader.js");
    const config = loadConfig();
    assert.equal(config.dataDir, tmp);
    assert.equal(typeof config.global.server.port, "number");
    assert.equal(config.global.engines.defaults.triage.provider, "mimo");
    assert.equal(config.global.engines.defaults.patch.provider, "claude_code");
    assert.deepEqual(config.repos, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("repo config schema parses minimal input", async () => {
  const { RepoConfigSchema, repoConfigFilename } = await import("../dist/config/schema.js");
  const repo = RepoConfigSchema.parse({ owner: "acme", name: "example" });
  assert.equal(repo.provider, "github");
  assert.equal(repo.watched, true);
  assert.deepEqual(repo.lanes, ["triage"]);
  assert.equal(repoConfigFilename(repo), "github--acme--example.yaml");
});

test("DB initialises with expected schema and accepts repo sync", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "aidev-db-test-"));
  try {
    process.env.OPENRONIN_DATA_DIR = tmp;
    const { initDb } = await import("../dist/storage/db.js");
    const { syncReposFromConfig, listRepos } = await import("../dist/storage/repos.js");
    const { RepoConfigSchema } = await import("../dist/config/schema.js");

    const db = initDb(tmp);
    const repo = RepoConfigSchema.parse({ owner: "acme", name: "example" });
    syncReposFromConfig(db, [repo]);

    const rows = listRepos(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].owner, "acme");
    assert.equal(rows[0].watched, 1);

    // Sync with empty list — repo should become unwatched, not deleted
    syncReposFromConfig(db, []);
    const all = listRepos(db, { watchedOnly: false });
    assert.equal(all.length, 1);
    assert.equal(all[0].watched, 0);
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("GitHub webhook signature verification rejects bad signatures", async () => {
  process.env.GITHUB_TOKEN = "fake-token-for-test";
  const { GithubVcsProvider } = await import("../dist/providers/github.js");
  const provider = new GithubVcsProvider();
  const body = '{"action":"opened"}';
  const headers = { "x-hub-signature-256": "sha256=deadbeef".padEnd(71, "0") };
  assert.equal(provider.verifyWebhookSignature(headers, body, "secret"), false);
  assert.equal(provider.verifyWebhookSignature({}, body, "secret"), false);
});
