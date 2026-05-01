// Director service entry point.
//
// Run as a separate systemd unit (`openronin-director.service`) alongside
// the main openronin service. Shares the same code, DB, and OPENRONIN_DATA_DIR.
//
//   ExecStart=node dist/index.js director:run
//
// FOUNDATION SCOPE: this entry point currently runs a no-op tick loop —
// every cadence_hours it writes a `tick_log` message into the chat saying
// "tick fired, no-op (foundation phase)". The real LLM-driven tick lands
// in PR #22.

import { loadConfig, watchConfig } from "../config/loader.js";
import type { RepoConfig, RuntimeConfig } from "../config/schema.js";
import { repoKey } from "../config/schema.js";
import { initDb, type Db } from "../storage/db.js";
import { syncReposFromConfig } from "../storage/repos.js";
import { ensureBudgetState, rolloverDayIfNeeded, markTick, checkBudgetGate } from "./budget.js";
import { appendMessage } from "./chat.js";
import { captureCharterVersion } from "./charter.js";
import { recordDecision } from "./decisions.js";
import type { DirectorConfig } from "./types.js";

const SERVICE_LOOP_INTERVAL_MS = 60_000; // wake up every minute
const KILL_SWITCH_ENV = "OPENRONIN_DIRECTOR_DISABLED";

type RepoLookup = {
  repoId: number;
  repo: RepoConfig;
  director: DirectorConfig;
};

function listRepoIdsByKey(db: Db): Map<string, number> {
  const rows = db
    .prepare(`SELECT id, provider, owner, name FROM repos WHERE watched = 1`)
    .all() as { id: number; provider: string; owner: string; name: string }[];
  const out = new Map<string, number>();
  for (const r of rows) {
    out.set(`${r.provider}--${r.owner}--${r.name}`, r.id);
  }
  return out;
}

function listDirectorEnabledRepos(db: Db, config: RuntimeConfig): RepoLookup[] {
  const idByKey = listRepoIdsByKey(db);
  const out: RepoLookup[] = [];
  for (const repo of config.repos) {
    const director = repo.director;
    if (!director || !director.enabled || director.mode === "disabled") continue;
    if (!director.charter) continue; // no charter → silently skip (safe default)
    const id = idByKey.get(repoKey(repo));
    if (id === undefined) continue;
    out.push({ repoId: id, repo, director });
  }
  return out;
}

function shouldTickNow(state: { lastTickAt: string | null }, cadenceHours: number): boolean {
  if (!state.lastTickAt) return true;
  const last = Date.parse(state.lastTickAt + "Z"); // sqlite text is UTC
  if (Number.isNaN(last)) return true;
  const elapsedMs = Date.now() - last;
  return elapsedMs >= cadenceHours * 3600_000;
}

async function tickNoOp(db: Db, target: RepoLookup): Promise<void> {
  const { repoId, repo, director } = target;
  if (!director.charter) return;

  rolloverDayIfNeeded(db, repoId);
  const state = ensureBudgetState(db, repoId, director.budget);

  const gate = checkBudgetGate(state, director.budget);
  if (!gate.ok) {
    appendMessage(db, {
      repoId,
      role: "system",
      type: "tick_log",
      body: `tick skipped: ${gate.reason}`,
      metadata: { repo: repoKey(repo), mode: director.mode },
    });
    return;
  }

  const charterVersion = captureCharterVersion(db, repoId, director.charter);

  const decision = recordDecision(db, {
    repoId,
    decisionType: "no_op",
    rationale:
      "Foundation tick: scheduler+chat+charter+budget infrastructure is wired. " +
      "Real LLM-driven planning lands in PR #22. This entry confirms the loop " +
      "ran end-to-end (charter parsed, budget gate passed, message appended).",
    charterVersion,
    stateSnapshot: {
      mode: director.mode,
      cadenceHours: director.cadence_hours,
      charterVersion,
      spentTodayUsd: state.spentTodayUsd,
      spentTodayThinkUsd: state.spentTodayThinkUsd,
      failureStreak: state.failureStreak,
    },
    outcome: "dry_run",
  });

  appendMessage(db, {
    repoId,
    role: "director",
    type: "tick_log",
    body: `tick fired (mode=${director.mode}, charter v${charterVersion}). Foundation phase: no planning yet.`,
    metadata: { repo: repoKey(repo), decisionId: decision.id },
    decisionId: decision.id,
  });

  markTick(db, repoId);
}

let stopping = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loopOnce(db: Db, config: RuntimeConfig): Promise<void> {
  const targets = listDirectorEnabledRepos(db, config);
  for (const t of targets) {
    if (stopping) return;
    rolloverDayIfNeeded(db, t.repoId);
    const state = ensureBudgetState(db, t.repoId, t.director.budget);
    if (!shouldTickNow(state, t.director.cadence_hours)) continue;
    try {
      await tickNoOp(db, t);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      try {
        appendMessage(db, {
          repoId: t.repoId,
          role: "system",
          type: "error",
          body: `tick threw: ${detail}`,
          metadata: { repo: repoKey(t.repo), stack: err instanceof Error ? err.stack : null },
        });
      } catch {
        // chat write failed too — just log
      }
      // eslint-disable-next-line no-console
      console.error(`[director] tick error on ${repoKey(t.repo)}:`, err);
    }
  }
}

export async function runDirectorService(): Promise<void> {
  if (process.env[KILL_SWITCH_ENV] === "1") {
    // eslint-disable-next-line no-console
    console.log(`[director] disabled via ${KILL_SWITCH_ENV}=1; idling.`);
    while (!stopping) {
      await sleep(SERVICE_LOOP_INTERVAL_MS);
    }
    return;
  }

  let config = loadConfig();
  const db = initDb(config.dataDir);
  syncReposFromConfig(db, config.repos);

  watchConfig(config.dataDir, () => {
    try {
      config = loadConfig({ dataDir: config.dataDir });
      syncReposFromConfig(db, config.repos);
      // eslint-disable-next-line no-console
      console.log(
        `[director] config reloaded; ${listDirectorEnabledRepos(db, config).length} director-enabled repo(s)`,
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[director] config reload error:", err);
    }
  });

  const onSignal = (sig: string): void => {
    // eslint-disable-next-line no-console
    console.log(`[director] received ${sig}; stopping.`);
    stopping = true;
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));

  // eslint-disable-next-line no-console
  console.log(
    `[director] started (pid ${process.pid}); ${listDirectorEnabledRepos(db, config).length} enabled repo(s); ` +
      `loop every ${SERVICE_LOOP_INTERVAL_MS / 1000}s.`,
  );

  while (!stopping) {
    try {
      await loopOnce(db, config);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[director] loop error:", err);
    }
    if (stopping) break;
    await sleep(SERVICE_LOOP_INTERVAL_MS);
  }

  // eslint-disable-next-line no-console
  console.log("[director] stopped cleanly.");
  db.close();
}
