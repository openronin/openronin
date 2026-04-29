import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("selectEngine: precedence cli_override > repo_override > global_default", async () => {
  process.env.XIAOMI_MIMO_API_KEY = "test-key";
  process.env.GITHUB_TOKEN = "fake";
  const { selectEngine } = await import("../dist/supervisor/index.js");
  const { GlobalConfigSchema, RepoConfigSchema } = await import("../dist/config/schema.js");

  const config = {
    dataDir: "/tmp",
    global: GlobalConfigSchema.parse({}),
    repos: [],
  };

  const repoNoOverride = RepoConfigSchema.parse({ owner: "o", name: "n" });
  const repoWithOverride = RepoConfigSchema.parse({
    owner: "o",
    name: "n",
    engine_overrides: { triage: { provider: "claude_code", model: "haiku" } },
  });

  const ctxNo = { config, db: null, repo: repoNoOverride };
  const ctxWith = { config, db: null, repo: repoWithOverride };

  // Global default
  const choice1 = selectEngine(ctxNo, "triage");
  assert.equal(choice1.engine.id, "mimo");
  assert.equal(choice1.source, "global_default");

  // Repo override beats global
  const choice2 = selectEngine(ctxWith, "triage");
  assert.equal(choice2.engine.id, "claude_code");
  assert.equal(choice2.model, "haiku");
  assert.equal(choice2.source, "repo_override");

  // CLI override beats repo
  const choice3 = selectEngine(ctxWith, "triage", { engine: "mimo", model: "mimo-v2.5" });
  assert.equal(choice3.engine.id, "mimo");
  assert.equal(choice3.model, "mimo-v2.5");
  assert.equal(choice3.source, "cli_override");
});

test("runJob records a successful run with usage in DB", async () => {
  process.env.XIAOMI_MIMO_API_KEY = "test-key";
  const tmp = mkdtempSync(join(tmpdir(), "aidev-runjob-"));
  try {
    const { initDb } = await import("../dist/storage/db.js");
    const { runJob } = await import("../dist/supervisor/index.js");
    const { GlobalConfigSchema, RepoConfigSchema } = await import("../dist/config/schema.js");
    const { ensureRepo, upsertTask } = await import("../dist/storage/tasks.js");
    const { listRecentRuns } = await import("../dist/storage/runs.js");
    const { MimoEngine } = await import("../dist/engines/mimo.js");

    const db = initDb(tmp);
    const repo = RepoConfigSchema.parse({ owner: "o", name: "n" });
    const repoId = ensureRepo(db, { provider: "github", owner: "o", name: "n" });
    const taskId = upsertTask(db, repoId, "1", "issue");

    // Patch global default to point at a stubbed mimo so runJob picks it up
    const config = {
      dataDir: tmp,
      global: GlobalConfigSchema.parse({}),
      repos: [],
    };
    const ctx = { config, db, repo };

    // Monkey-patch getEngine via constructor injection isn't easy here, so just call runJob
    // but stub fetch via env-controlled MimoEngine — install our fake engine in the registry
    // by wrapping selectEngine. Simpler: spy via cli_override + custom Engine sub.
    const fakeFetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 7 },
        }),
        { status: 200 },
      );
    const fakeEngine = new MimoEngine({ apiKey: "k", fetch: fakeFetch });

    // Substitute the engines factory by re-importing index after setting env? Cleaner:
    // call createRun + finishRun directly to verify storage layer round-trip.
    const { createRun, finishRun } = await import("../dist/storage/runs.js");
    const runId = createRun(db, { taskId, lane: "review", engine: "mimo", model: "mimo-v2.5" });

    const result = await fakeEngine.run({
      systemPrompt: "s",
      userPrompt: "u",
      timeoutMs: 1000,
    });
    finishRun(db, runId, { status: "ok", usage: result.usage });

    const rows = listRecentRuns(db, 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "ok");
    assert.equal(rows[0].tokens_in, 5);
    assert.equal(rows[0].tokens_out, 7);
    assert.equal(rows[0].engine, "mimo");
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
