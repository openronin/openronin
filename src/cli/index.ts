import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { ensureDataDirs, loadConfig, resolveDataDir } from "../config/loader.js";
import { repoConfigFilename, RepoConfigSchema } from "../config/schema.js";
import { initDb } from "../storage/db.js";
import { listRepos, syncReposFromConfig } from "../storage/repos.js";
import { GithubVcsProvider } from "../providers/github.js";
import { getEngine, type EngineProviderId } from "../engines/index.js";
import { runReview } from "../lanes/review.js";
import { writeReviewReport } from "../storage/reports.js";
import { repoKey, type RepoConfig } from "../config/schema.js";
import { listRecentRuns } from "../storage/runs.js";
import { reconcileRepo } from "../scheduler/reconcile.js";
import { drain } from "../scheduler/worker.js";
import { queueStats } from "../scheduler/queue.js";
import { randomBytes } from "node:crypto";
import { runPatch } from "../lanes/patch.js";
import { runPrDialog } from "../lanes/pr-dialog.js";
import { listPrBranches } from "../storage/pr-branches.js";

export type CliResult = { exitCode: number };

export async function runCli(argv: string[]): Promise<CliResult> {
  const [cmd, ...rest] = argv;
  const args = parseArgs(rest);

  switch (cmd) {
    case "init":
      return cmdInit();
    case "config:show":
      return cmdConfigShow();
    case "repo:add":
      return cmdRepoAdd(args);
    case "repo:list":
      return cmdRepoList(args);
    case "repo:sync":
      return cmdRepoSync();
    case "github:whoami":
      return cmdGithubWhoami();
    case "engine:test":
      return cmdEngineTest(args);
    case "review:item":
      return cmdReviewItem(args);
    case "patch:item":
      return cmdPatchItem(args);
    case "pr-dialog:run":
      return cmdPrDialogRun(args);
    case "pr:list":
      return cmdPrList(args);
    case "runs:list":
      return cmdRunsList(args);
    case "scheduler:tick":
      return cmdSchedulerTick(args);
    case "scheduler:status":
      return cmdSchedulerStatus();
    case "repo:connect-webhook":
      return cmdRepoConnectWebhook(args);
    case "help":
    case "--help":
    case "-h":
      return cmdHelp();
    default:
      console.error(`Unknown command: ${cmd ?? "(none)"}\n`);
      return cmdHelp(2);
  }
}

function cmdHelp(exitCode = 0): CliResult {
  console.log(`openronin CLI

Usage:
  openronin [server]                         Start the daemon (default)
  openronin init                             Create a default global config
  openronin config:show                      Print the resolved runtime config as JSON
  openronin repo:add --provider <id> --owner <o> --name <n> [--watched|--no-watched]
                                               Add a watched repo (writes YAML, syncs DB)
  openronin repo:list [--all]                List repos (default: only watched)
  openronin repo:sync                        Resync YAML repos into the SQLite cache
  openronin github:whoami                    Verify GITHUB_TOKEN by calling /user
  openronin engine:test --provider <mimo|claude_code> [--model <m>] [--prompt "..."]
                                               Send a hello prompt and print the response + usage
  openronin review:item --owner <o> --name <n> --number <N> [--engine <id>] [--model <m>]
                                               Run one review on a single GitHub issue/PR and write
                                               a report under $OPENRONIN_DATA_DIR/reports/...
  openronin patch:item --owner <o> --name <n> --number <N>
                                               Run the patch lane on one issue: clone repo, run
                                               Claude Code worker, push branch, open a draft PR
  openronin pr-dialog:run --owner <o> --name <n> --pr <N>
                                               Run one PR-dialog iteration: read new review feedback,
                                               apply changes via Claude Code, push, comment on PR
  openronin pr:list [--limit N]              Show recently created/managed PRs from the patch lane
  openronin runs:list [--limit N]            Show recent runs (engine, tokens, cost, status)
  openronin scheduler:tick [--owner <o> --name <n>] [--drain N]
                                               Reconcile watched repos (or one) and drain N tasks
  openronin scheduler:status                 Print queue stats (pending/due/running/done/error)
  openronin repo:connect-webhook --owner <o> --name <n> [--base-url <u>]
                                               Generate a secret + register a GitHub webhook for the repo
  openronin help                             Show this help

Env:
  OPENRONIN_DATA_DIR    State directory (default: ./.dev-data)
  OPENRONIN_PORT        Server port (default: 8090)
  GITHUB_TOKEN      PAT for GitHub provider
`);
  return { exitCode };
}

function cmdInit(): CliResult {
  const dataDir = resolveDataDir();
  ensureDataDirs(dataDir);
  const path = resolve(dataDir, "config", "openronin.yaml");
  if (existsSync(path)) {
    console.log(`Config already exists at ${path} — nothing to do.`);
    return { exitCode: 0 };
  }
  const template = `# openronin global config
# This file is auto-loaded from $OPENRONIN_DATA_DIR/config/openronin.yaml
# Per-repo configs live in $OPENRONIN_DATA_DIR/config/repos/<provider>--<owner>--<name>.yaml

server:
  port: 8090
  base_url: http://localhost:8090

engines:
  defaults:
    triage:
      provider: mimo
      model: mimo-v2.5
    deep_review:
      provider: claude_code
      model: sonnet
    patch:
      provider: claude_code
      model: sonnet
    pr_dialog:
      provider: claude_code
      model: sonnet

cadence:
  hot: 5m
  default: 1h
  cold: 24h

cost_caps:
  per_task_usd: 2.0
  per_day_usd: 50.0

scheduler:
  reconcile_interval: 15m   # how often we sweep watched repos for due items / new PR feedback
  drain_interval: 30s       # how often the worker drains the queue
  drain_batch_size: 5       # max tasks per drain tick
`;
  writeFileSync(path, template, { mode: 0o600 });
  console.log(`Wrote ${path}`);
  return { exitCode: 0 };
}

function cmdConfigShow(): CliResult {
  const config = loadConfig();
  console.log(JSON.stringify(config, null, 2));
  return { exitCode: 0 };
}

function cmdRepoAdd(args: ParsedArgs): CliResult {
  const provider = args.string("provider", "github");
  const owner = args.requireString("owner");
  const name = args.requireString("name");
  const watched = !args.bool("no-watched");

  const repo = RepoConfigSchema.parse({ provider, owner, name, watched });

  const dataDir = resolveDataDir();
  ensureDataDirs(dataDir);
  const path = resolve(dataDir, "config", "repos", repoConfigFilename(repo));
  if (existsSync(path)) {
    console.error(`Repo config already exists: ${path}`);
    return { exitCode: 1 };
  }
  writeFileSync(path, YAML.stringify(repo), { mode: 0o600 });
  console.log(`Wrote ${path}`);

  return cmdRepoSync();
}

function cmdRepoSync(): CliResult {
  const config = loadConfig();
  const db = initDb(config.dataDir);
  syncReposFromConfig(db, config.repos);
  const rows = listRepos(db);
  console.log(`Synced ${config.repos.length} YAML repo(s); DB has ${rows.length} row(s).`);
  return { exitCode: 0 };
}

function cmdRepoList(args: ParsedArgs): CliResult {
  const config = loadConfig();
  const db = initDb(config.dataDir);
  syncReposFromConfig(db, config.repos);
  const rows = listRepos(db, { watchedOnly: !args.bool("all") });
  if (rows.length === 0) {
    console.log("No repos. Add one with: openronin repo:add --owner X --name Y");
    return { exitCode: 0 };
  }
  for (const row of rows) {
    const flag = row.watched ? "[*]" : "[ ]";
    console.log(`${flag} ${row.provider}:${row.owner}/${row.name}`);
  }
  return { exitCode: 0 };
}

async function cmdEngineTest(args: ParsedArgs): Promise<CliResult> {
  const providerStr = args.requireString("provider");
  if (providerStr !== "mimo" && providerStr !== "claude_code") {
    console.error(`Invalid --provider: ${providerStr} (expected mimo or claude_code)`);
    return { exitCode: 2 };
  }
  const provider = providerStr as EngineProviderId;
  const model = args.string("model", "");
  const prompt = args.string("prompt", "Reply with the single word: pong.");
  const timeoutMs = Number(args.string("timeout-ms", "60000"));

  try {
    const engine = getEngine(provider);
    console.log(`[engine:test] provider=${engine.id} model=${model || engine.defaultModel}`);
    const result = await engine.run({
      systemPrompt: "You are a terse smoke-test endpoint. Answer briefly.",
      userPrompt: prompt,
      timeoutMs,
      ...(model && { model }),
    });
    console.log(`--- response ---\n${result.content}\n--- usage ---`);
    console.log(JSON.stringify(result.usage, null, 2));
    console.log(
      `finishReason: ${result.finishReason ?? "(none)"}, durationMs: ${result.durationMs}`,
    );
    return { exitCode: 0 };
  } catch (error) {
    console.error("engine:test failed:", error instanceof Error ? error.message : error);
    return { exitCode: 1 };
  }
}

async function cmdReviewItem(args: ParsedArgs): Promise<CliResult> {
  const owner = args.requireString("owner");
  const name = args.requireString("name");
  const number = Number(args.requireString("number"));
  const engineFlag = args.string("engine", "");
  const modelFlag = args.string("model", "");

  const config = loadConfig();
  const repo =
    config.repos.find((r) => r.owner === owner && r.name === name) ??
    RepoConfigSchema.parse({ owner, name, watched: false });

  console.log(
    `[review:item] repo=${repoKey(repo)} number=${number} cli-override=${engineFlag || "(none)"}/${modelFlag || "(none)"}`,
  );

  try {
    const provider = new GithubVcsProvider();
    const item = await provider.getItem({ owner: repo.owner, name: repo.name }, number);
    console.log(
      `[review:item] fetched ${item.kind} "${item.title}" by ${item.author} (${item.authorAssociation}), labels=[${item.labels.join(", ")}]`,
    );

    const db = initDb(config.dataDir);
    const override =
      engineFlag === "mimo" || engineFlag === "claude_code"
        ? {
            engine: engineFlag as EngineProviderId,
            ...(modelFlag && { model: modelFlag }),
          }
        : undefined;

    const review = await runReview({
      ctx: { config, db, repo },
      item,
      ...(override && { override }),
    });

    const path = writeReviewReport({
      dataDir: config.dataDir,
      repo,
      item,
      decision: review.decision,
      engineId: review.engine,
      model: review.model,
      usage: review.usage,
      durationMs: review.durationMs,
    });

    console.log(
      `[review:item] decision=${review.decision.decision} reason=${review.decision.close_reason} confidence=${review.decision.confidence}`,
    );
    console.log(
      `[review:item] engine=${review.engine}/${review.model} tokens in=${review.usage.tokensIn} out=${review.usage.tokensOut} cost=${review.usage.costUsd ?? "(n/a)"} duration=${review.durationMs}ms`,
    );
    console.log(`[review:item] runId=${review.runId} taskId=${review.taskId}`);
    console.log(`[review:item] report: ${path}`);
    return { exitCode: 0 };
  } catch (error) {
    console.error("review:item failed:", error instanceof Error ? error.message : error);
    return { exitCode: 1 };
  }
}

function cmdRunsList(args: ParsedArgs): CliResult {
  const limit = Number(args.string("limit", "20"));
  const config = loadConfig();
  const db = initDb(config.dataDir);
  const rows = listRecentRuns(db, limit);
  if (rows.length === 0) {
    console.log("No runs yet.");
    return { exitCode: 0 };
  }
  for (const row of rows) {
    const cost = row.cost_usd != null ? `$${row.cost_usd.toFixed(4)}` : "$-";
    const tokens = `${row.tokens_in ?? "-"}/${row.tokens_out ?? "-"}`;
    const status = row.status.padEnd(7);
    console.log(
      `#${row.id.toString().padStart(4)} ${row.started_at} task=${row.task_id} lane=${row.lane.padEnd(8)} ${row.engine}/${row.model ?? "?"} ${status} tokens=${tokens} cost=${cost}`,
    );
  }
  return { exitCode: 0 };
}

async function cmdSchedulerTick(args: ParsedArgs): Promise<CliResult> {
  const config = loadConfig();
  const db = initDb(config.dataDir);
  syncReposFromConfig(db, config.repos);
  const drainLimit = Number(args.string("drain", "5"));
  const ownerFilter = args.string("owner", "");
  const nameFilter = args.string("name", "");

  const targets = config.repos.filter(
    (r) =>
      r.watched &&
      (!ownerFilter || r.owner === ownerFilter) &&
      (!nameFilter || r.name === nameFilter),
  );
  if (targets.length === 0) {
    console.log("No watched repos match the filter.");
    return { exitCode: 0 };
  }

  for (const repo of targets) {
    try {
      const result = await reconcileRepo(db, repo, config.global.cadence);
      console.log(
        `[reconcile] ${result.repo}: scanned=${result.scanned} enqueued=${result.enqueued}`,
      );
    } catch (error) {
      console.error(
        `[reconcile] ${repo.owner}/${repo.name} failed:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  const drained = await drain(db, config, drainLimit);
  if (drained.length === 0) {
    console.log("[drain] queue empty, nothing to do");
  } else {
    for (const r of drained) {
      console.log(`[drain] task=#${r.taskId} status=${r.status} detail=${r.detail ?? ""}`);
    }
  }
  console.log("[stats]", JSON.stringify(queueStats(db)));
  return { exitCode: 0 };
}

function cmdSchedulerStatus(): CliResult {
  const config = loadConfig();
  const db = initDb(config.dataDir);
  console.log(JSON.stringify(queueStats(db), null, 2));
  return { exitCode: 0 };
}

async function cmdRepoConnectWebhook(args: ParsedArgs): Promise<CliResult> {
  const owner = args.requireString("owner");
  const name = args.requireString("name");
  const config = loadConfig();
  const db = initDb(config.dataDir);

  const baseUrl = args.string("base-url", config.global.server.baseUrl);

  const repoRow = db
    .prepare("SELECT id FROM repos WHERE provider = 'github' AND owner = ? AND name = ?")
    .get(owner, name) as { id: number } | undefined;
  if (!repoRow) {
    console.error(`Repo ${owner}/${name} not in DB. Run 'openronin repo:add' first.`);
    return { exitCode: 1 };
  }

  const secret = randomBytes(32).toString("hex");
  const callbackUrl = `${baseUrl.replace(/\/+$/, "")}/webhooks/github/${repoRow.id}`;

  // Persist the secret so the webhook handler can verify signatures.
  db.prepare(
    "INSERT INTO webhook_secrets (repo_id, secret) VALUES (?, ?) ON CONFLICT(repo_id) DO UPDATE SET secret = excluded.secret",
  ).run(repoRow.id, secret);

  // Register the webhook on GitHub.
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error(
      "GITHUB_TOKEN not set; secret persisted but webhook NOT registered. Re-run with token.",
    );
    return { exitCode: 1 };
  }

  const response = await fetch(`https://api.github.com/repos/${owner}/${name}/hooks`, {
    method: "POST",
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "openronin/0.0.1",
    },
    body: JSON.stringify({
      name: "web",
      active: true,
      events: ["issues", "issue_comment", "pull_request", "pull_request_review"],
      config: { url: callbackUrl, content_type: "json", secret, insecure_ssl: "0" },
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    console.error(`GitHub API error ${response.status}: ${text.slice(0, 300)}`);
    return { exitCode: 1 };
  }
  let id: number | undefined;
  try {
    id = (JSON.parse(text) as { id?: number }).id;
  } catch {
    /* ignore */
  }
  if (id !== undefined) {
    db.prepare("UPDATE webhook_secrets SET webhook_id = ? WHERE repo_id = ?").run(
      String(id),
      repoRow.id,
    );
  }
  console.log(`Webhook registered. id=${id ?? "?"} url=${callbackUrl}`);
  return { exitCode: 0 };
}

async function cmdPatchItem(args: ParsedArgs): Promise<CliResult> {
  const owner = args.requireString("owner");
  const name = args.requireString("name");
  const number = Number(args.requireString("number"));

  const config = loadConfig();
  const repo = config.repos.find((r) => r.owner === owner && r.name === name);
  if (!repo) {
    console.error(`Repo ${owner}/${name} not in config. Run 'openronin repo:add' first.`);
    return { exitCode: 1 };
  }
  if (!repo.lanes.includes("patch")) {
    console.error(`Patch lane is not enabled for ${owner}/${name}. Add 'patch' to its lanes:.`);
    return { exitCode: 1 };
  }

  console.log(`[patch:item] starting on ${owner}/${name}#${number}`);
  console.log(
    `[patch:item] base=${repo.patch_default_base} max_diff_lines=${repo.max_diff_lines} draft=${repo.draft_pr}`,
  );

  const db = initDb(config.dataDir);
  try {
    const provider = new GithubVcsProvider();
    const item = await provider.getItem({ owner, name }, number);
    console.log(`[patch:item] item="${item.title}" by ${item.author} (${item.authorAssociation})`);

    const result = await runPatch({ ctx: { config, db, repo }, item });

    console.log(`[patch:item] outcome=${result.outcome} branch=${result.branch}`);
    if (result.diffStats) {
      console.log(
        `[patch:item] diff: ${result.diffStats.filesChanged.length} files, +${result.diffStats.linesAdded}/-${result.diffStats.linesRemoved}`,
      );
    }
    if (result.detail) console.log(`[patch:item] detail: ${result.detail}`);
    if (result.prUrl) console.log(`[patch:item] PR: ${result.prUrl}`);
    return { exitCode: result.outcome === "pr_opened" ? 0 : 1 };
  } catch (error) {
    console.error("patch:item failed:", error instanceof Error ? error.message : error);
    return { exitCode: 1 };
  }
}

async function cmdPrDialogRun(args: ParsedArgs): Promise<CliResult> {
  const owner = args.requireString("owner");
  const name = args.requireString("name");
  const prNumber = Number(args.requireString("pr"));

  const config = loadConfig();
  const repo = config.repos.find((r) => r.owner === owner && r.name === name);
  if (!repo) {
    console.error(`Repo ${owner}/${name} not in config.`);
    return { exitCode: 1 };
  }
  if (!repo.lanes.includes("pr_dialog")) {
    console.error(`pr_dialog lane is not enabled for ${owner}/${name}.`);
    return { exitCode: 1 };
  }

  console.log(`[pr-dialog:run] ${owner}/${name}#${prNumber}`);
  const db = initDb(config.dataDir);
  try {
    const provider = new GithubVcsProvider();
    const item = await provider.getItem({ owner, name }, prNumber);
    if (item.kind !== "pull_request") {
      console.error(`#${prNumber} is not a PR.`);
      return { exitCode: 1 };
    }
    const result = await runPrDialog({ ctx: { config, db, repo }, item });
    console.log(
      `[pr-dialog:run] outcome=${result.outcome} iter=${result.iteration} branch=${result.branch}`,
    );
    if (result.diffStats) {
      console.log(
        `[pr-dialog:run] diff: ${result.diffStats.filesChanged.length} files, +${result.diffStats.linesAdded}/-${result.diffStats.linesRemoved}`,
      );
    }
    if (result.detail) console.log(`[pr-dialog:run] detail: ${result.detail}`);
    return { exitCode: result.outcome === "error" ? 1 : 0 };
  } catch (error) {
    console.error("pr-dialog:run failed:", error instanceof Error ? error.message : error);
    return { exitCode: 1 };
  }
}

function cmdPrList(args: ParsedArgs): CliResult {
  const limit = Number(args.string("limit", "20"));
  const config = loadConfig();
  const db = initDb(config.dataDir);
  const rows = listPrBranches(db, limit);
  if (rows.length === 0) {
    console.log("No PRs yet.");
    return { exitCode: 0 };
  }
  for (const r of rows) {
    const pr = r.pr_number ? `#${r.pr_number}` : "(no pr)";
    console.log(
      `[${r.status.padEnd(18)}] ${r.created_at} task=${r.task_id} branch=${r.branch} ${pr} ${r.pr_url ?? ""}`,
    );
  }
  return { exitCode: 0 };
}

async function cmdGithubWhoami(): Promise<CliResult> {
  try {
    const provider = new GithubVcsProvider();
    const login = await provider.whoami();
    console.log(`Authenticated as: ${login}`);
    return { exitCode: 0 };
  } catch (error) {
    console.error("github:whoami failed:", error instanceof Error ? error.message : error);
    return { exitCode: 1 };
  }
}

interface ParsedArgs {
  string(name: string, fallback?: string): string;
  requireString(name: string): string;
  bool(name: string): boolean;
}

function parseArgs(rest: string[]): ParsedArgs {
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token || !token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return {
    string(name, fallback) {
      const v = flags[name];
      if (typeof v === "string") return v;
      if (fallback !== undefined) return fallback;
      throw new Error(`Missing --${name}`);
    },
    requireString(name) {
      const v = flags[name];
      if (typeof v !== "string") throw new Error(`Missing --${name} <value>`);
      return v;
    },
    bool(name) {
      return flags[name] === true || flags[name] === "true";
    },
  };
}
