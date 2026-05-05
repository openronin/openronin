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
import { ensureBudgetState, rolloverDayIfNeeded } from "./budget.js";
import { appendMessage, unansweredUserDirectives } from "./chat.js";
import { runTick, type TickReason } from "./tick.js";
import { releaseTick, tryAcquireTick } from "./active-tick.js";
import { getLastDigestDate, runDigest, shouldRunDigest } from "./digest.js";
import { maybePostTrustRampSuggestion } from "./trust-ramp.js";
import { expireStalePending } from "./decisions.js";
import { runOutcomeFollowupSweep } from "./outcome-followup.js";
import { GithubVcsProvider } from "../providers/github.js";
import { MimoEngine } from "../engines/mimo.js";
import type { DirectorConfig } from "./types.js";

// Wake up every 10s — tight enough that a user chat message is reacted to
// in <30s in the typical case, loose enough that an idle director burns
// almost no CPU. Cadence-based scheduled ticks (6h+) are cheap to check.
const SERVICE_LOOP_INTERVAL_MS = 10_000;

// Outcome follow-up runs once per hour per repo. Throttled in-process via
// this Map — keyed by repoId, value is the last sweep timestamp. Survives
// across loop iterations because the module-level binding outlives them.
const FOLLOWUP_INTERVAL_MS = 60 * 60 * 1000;
const lastFollowupAt = new Map<number, number>();
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

function isPastCadence(state: { lastTickAt: string | null }, cadenceHours: number): boolean {
  if (!state.lastTickAt) return true;
  const last = Date.parse(state.lastTickAt + "Z"); // sqlite text is UTC
  if (Number.isNaN(last)) return true;
  const elapsedMs = Date.now() - last;
  return elapsedMs >= cadenceHours * 3600_000;
}

// Why fire a tick right now? Reactive (user wrote in chat) wins over
// scheduled (cadence elapsed). Returns null if we should stay idle.
//
// "Reactive" means: at least one user message exists that the director
// hasn't responded to yet. The DB helper does the right thing — it only
// returns user messages with no later director-role message, so once a
// tick produces a status reply, the queue empties for that user.
function pickTickReason(
  db: Db,
  repoId: number,
  state: { lastTickAt: string | null },
  cadenceHours: number,
): TickReason | null {
  if (unansweredUserDirectives(db, repoId).length > 0) return "user_message";
  if (isPastCadence(state, cadenceHours)) return "scheduled";
  return null;
}

async function executeTick(
  db: Db,
  target: RepoLookup,
  dataDir: string,
  reason: TickReason,
): Promise<void> {
  // Acquire the per-repo lock. This makes parallel ticks structurally
  // impossible (a webhook-driven trigger landing during a scheduled tick
  // would otherwise produce duplicate decisions) and doubles as the
  // "thinking…" indicator the admin chat polls for.
  if (!tryAcquireTick(db, target.repoId, reason)) {
    // Another worker is already ticking this repo. Skip silently — the
    // running tick will pick up any new chat messages on its next pass.
    return;
  }
  try {
    const result = await runTick({
      db,
      repoId: target.repoId,
      repo: target.repo,
      director: target.director,
      dataDir,
      reason,
    });
    // eslint-disable-next-line no-console
    console.log(
      `[director] tick on ${repoKey(target.repo)} (${reason}): ${result.status} — ${result.detail} ` +
        `(${result.decisionsLogged} decisions, $${result.costUsd.toFixed(4)})`,
    );
  } finally {
    releaseTick(db, target.repoId);
  }
}

let stopping = false;

// Interruptible sleep — SIGTERM-aware. The naive `setTimeout` blocks the
// service loop for the full 10s even after `stopping = true`, which on
// every deploy added up to ~10s of "service refusing to die" before
// systemd's 120s timeout eventually SIGKILLs us. Splitting the wait into
// 250ms slices shrinks worst-case shutdown lag to a quarter-second.
function sleep(ms: number): Promise<void> {
  if (ms <= 250) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise((resolve) => {
    let elapsed = 0;
    const tick = (): void => {
      if (stopping || elapsed >= ms) {
        resolve();
        return;
      }
      const slice = Math.min(250, ms - elapsed);
      elapsed += slice;
      setTimeout(tick, slice);
    };
    tick();
  });
}

async function maybeRunDigest(db: Db, target: RepoLookup, dataDir: string): Promise<void> {
  // Digest fires at most once per local-TZ day per repo. shouldRunDigest is
  // pure — it checks the configured hour against the current wall-clock in
  // the configured TZ, plus the persisted last-digest-date string.
  const last = getLastDigestDate(db, target.repoId);
  if (!shouldRunDigest(target.director.digest, last)) return;
  // Use the same per-repo lock as planning ticks so a digest doesn't
  // race with a chat-triggered planning tick.
  if (!tryAcquireTick(db, target.repoId, "morning_digest")) return;
  try {
    const result = await runDigest({
      db,
      repoId: target.repoId,
      repo: target.repo,
      digest: target.director.digest,
      persona: target.director.charter?.persona,
      language: target.director.language,
      dataDir,
      // Digest is intentionally cheap — MIMO only. Failing over to a
      // pricier engine would defeat the point of the daily digest.
      engineFactory: () =>
        new MimoEngine({
          defaultModel: process.env.OPENRONIN_DIRECTOR_DIGEST_MODEL ?? "mimo-v2.5-pro",
        }),
    });
    // eslint-disable-next-line no-console
    console.log(
      `[director] digest on ${repoKey(target.repo)}: ${result.status} — ${result.detail} ` +
        `($${result.costUsd.toFixed(4)})`,
    );
  } finally {
    releaseTick(db, target.repoId);
  }
}

async function loopOnce(db: Db, config: RuntimeConfig): Promise<void> {
  const targets = listDirectorEnabledRepos(db, config);
  for (const t of targets) {
    if (stopping) return;
    rolloverDayIfNeeded(db, t.repoId);
    // Expire pending proposals untouched for >7d — silent cleanup so a
    // ghost queue doesn't block reactivity ("X proposals pending" never
    // dropping). Cheap UPDATE with a date predicate; runs every loop
    // iteration but only does work when there's something to expire.
    try {
      const expired = expireStalePending(db, t.repoId);
      if (expired > 0) {
        appendMessage(db, {
          repoId: t.repoId,
          role: "system",
          type: "tick_log",
          body: `expired ${expired} pending proposal(s) untouched for >7d`,
          metadata: { repo: repoKey(t.repo), kind: "expire_pending", count: expired },
        });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[director] expire-pending error on ${repoKey(t.repo)}:`, err);
    }
    const state = ensureBudgetState(db, t.repoId, t.director.budget);
    // Digest runs out-of-band from the planning cadence — the user wants
    // morning context every day, even if the planning cadence is 6h+.
    try {
      await maybeRunDigest(db, t, config.dataDir);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[director] digest error on ${repoKey(t.repo)}:`, err);
    }
    if (stopping) return;
    // Outcome follow-up — once per hour per repo, polls VCS for the
    // resulting state of recent executed create_issue decisions. Cheap
    // when there's nothing to observe; capped at 5 decisions per sweep
    // when there is. Surfaced on the per-decision trace UI.
    try {
      const last = lastFollowupAt.get(t.repoId) ?? 0;
      if (Date.now() - last >= FOLLOWUP_INTERVAL_MS) {
        lastFollowupAt.set(t.repoId, Date.now());
        const result = await runOutcomeFollowupSweep(
          db,
          t.repoId,
          t.repo.owner,
          t.repo.name,
          new GithubVcsProvider(),
        );
        if (result.observed > 0 || result.errored > 0) {
          // eslint-disable-next-line no-console
          console.log(
            `[director] follow-up sweep on ${repoKey(t.repo)}: ` +
              `${result.observed} observed, ${result.errored} errored`,
          );
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[director] follow-up sweep error on ${repoKey(t.repo)}:`, err);
    }
    if (stopping) return;
    // Trust ramp check is cheap (one SQL aggregate + one cooldown lookup);
    // running it on every loop tick is fine. The cooldown inside the
    // helper means it posts to chat at most once a week per repo.
    try {
      const suggestion = maybePostTrustRampSuggestion(
        db,
        t.repoId,
        t.director.mode,
        t.director.language,
      );
      if (suggestion) {
        // eslint-disable-next-line no-console
        console.log(
          `[director] trust-ramp on ${repoKey(t.repo)}: ${suggestion.kind} ` +
            `${suggestion.from} → ${suggestion.to} ` +
            `(rate=${suggestion.rate.toFixed(2)}, n=${suggestion.sampleSize})`,
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[director] trust-ramp error on ${repoKey(t.repo)}:`, err);
    }
    if (stopping) return;
    const reason = pickTickReason(db, t.repoId, state, t.director.cadence_hours);
    if (!reason) continue;
    try {
      await executeTick(db, t, config.dataDir, reason);
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

  // Keep a handle so we can stop the file watcher on shutdown — otherwise
  // the fs.watch keepalive prevents Node from exiting after the main loop
  // returns.
  const stopWatchConfig = watchConfig(config.dataDir, () => {
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

  // Telegram bridge — opt-in via env, no-op if not configured.
  const { startDirectorTelegramBridgeIfConfigured } = await import("./telegram.js");
  const tgBridge = startDirectorTelegramBridgeIfConfigured(db, () => config);
  if (tgBridge) {
    // Wire SIGTERM to stop the bridge so it stops polling promptly.
    process.on("SIGTERM", () => tgBridge.stop());
    process.on("SIGINT", () => tgBridge.stop());
  }

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

  // Tear down the I/O handles that keep the event loop alive otherwise.
  // Without these, the process would log "stopped cleanly" but linger
  // until systemd's TimeoutStopSec fires SIGKILL — the original 120s
  // production hang we're fixing.
  try {
    stopWatchConfig();
  } catch {
    // best-effort; we're shutting down anyway
  }
  db.close();
  // eslint-disable-next-line no-console
  console.log("[director] stopped cleanly.");
  // Belt-and-braces: even after closing watchers and the DB, a stuck
  // AbortSignal.timeout() inside an aborted Telegram fetch can still hold
  // a timer ref in older Node builds. Force-exit so the deploy never has
  // to wait for systemd's SIGKILL.
  process.exit(0);
}
