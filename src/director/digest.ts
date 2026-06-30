// Daily morning digest — once-per-day "good morning" status update.
//
// Different from a planning tick:
//   • cheap engine (MIMO over Sonnet) — purely status, never decisions
//   • doesn't burn the propose-budget (think_daily_usd is still charged)
//   • posts ONE chat message, no decisions, no executor invocation
//   • triggers on a wall-clock schedule (digest.hour, digest.timezone),
//     not on the planning cadence
//
// The trigger predicate (`shouldRunDigest`) is pure & string-only — given
// the configured hour, timezone, and the stored last-digest-date, it
// returns true iff today's digest hasn't fired yet AND we're past the
// configured hour in the local timezone. Service loop calls it on every
// wake-up; cheap.

import type { Db } from "../storage/db.js";
import type { RepoConfig } from "../config/schema.js";
import { repoKey } from "../config/schema.js";
import type { DigestConfig, Persona } from "./types.js";
import { PersonaSchema } from "./types.js";
import { appendMessage } from "./chat.js";
import { captureStateSnapshot } from "./state.js";
import { recordThinkSpend } from "./budget.js";
import type { Engine } from "../engines/types.js";
import { loadTemplate, renderTemplate } from "../prompts/registry.js";

// ── TZ-aware date helpers (no Date math) ─────────────────────────────────
// Intl.DateTimeFormat is the only stable way to get "what's the local hour
// in Europe/Moscow right now" without pulling in Luxon. Bad timezone names
// throw here; we catch and fall back to UTC silently rather than wedge.
//
// Both helpers are cheap (the formatter is constructed per-call but the
// digest tick fires at most once a day, so it doesn't matter).

export function localDateInTz(d: Date, tz: string): string {
  try {
    // en-CA produces YYYY-MM-DD which we want for stable string comparison.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  }
}

export function localHourInTz(d: Date, tz: string): number {
  try {
    const txt = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(d);
    return parseInt(txt, 10);
  } catch {
    return d.getUTCHours();
  }
}

// Pure predicate: should we fire a digest right now?
//
// Returns true when:
//   • digest.enabled, AND
//   • we're past the configured hour today in the configured timezone, AND
//   • we haven't already fired a digest for today's local date, AND
//   • we're past the backoff deadline (or no backoff is active).
//
// `now` is injectable for tests; production passes `new Date()`.
// `nextAttemptAt` is the UTC ISO timestamp written by a prior failed
// attempt's exponential backoff — null means no backoff active.
export function shouldRunDigest(
  digest: DigestConfig,
  lastDigestDate: string | null,
  now: Date = new Date(),
  nextAttemptAt: string | null = null,
): boolean {
  if (!digest.enabled) return false;
  if (nextAttemptAt) {
    const next = Date.parse(nextAttemptAt);
    if (!Number.isNaN(next) && now.getTime() < next) return false;
  }
  const hour = localHourInTz(now, digest.timezone);
  if (hour < digest.hour) return false;
  const today = localDateInTz(now, digest.timezone);
  return lastDigestDate !== today;
}

// Persist that we've fired today's digest. Called after a successful run
// (and skipped on transient failure so we'll retry after the backoff).
export function recordDigestFired(db: Db, repoId: number, today: string): void {
  db.prepare(`UPDATE director_budget_state SET last_digest_date = ? WHERE repo_id = ?`).run(
    today,
    repoId,
  );
}

export function getLastDigestDate(db: Db, repoId: number): string | null {
  return getDigestRetryState(db, repoId).lastDate;
}

// Read both the last fired date AND the backoff state for the digest.
// shouldRunDigest needs both — the predicate gates on either of them being
// "already done for today" or "still within backoff window".
export function getDigestRetryState(
  db: Db,
  repoId: number,
): { lastDate: string | null; nextAttemptAt: string | null; failureCount: number } {
  const row = db
    .prepare(
      `SELECT last_digest_date, digest_next_attempt_at, digest_failure_count
       FROM director_budget_state WHERE repo_id = ?`,
    )
    .get(repoId) as
    | {
        last_digest_date: string | null;
        digest_next_attempt_at: string | null;
        digest_failure_count: number | null;
      }
    | undefined;
  return {
    lastDate: row?.last_digest_date ?? null,
    nextAttemptAt: row?.digest_next_attempt_at ?? null,
    failureCount: row?.digest_failure_count ?? 0,
  };
}

// Exponential backoff for the digest retry loop. Starts at 1 minute,
// doubles each failure, capped at 1 hour. The cap is intentional: a stuck
// MIMO model name shouldn't produce more than one error message per hour
// (cf. issue #79: ~25 errors in 5 min).
const DIGEST_BACKOFF_BASE_MS = 60_000;
const DIGEST_BACKOFF_MAX_MS = 60 * 60_000;

export function computeDigestBackoffMs(failureCount: number): number {
  const exponent = Math.max(0, failureCount - 1);
  const ms = DIGEST_BACKOFF_BASE_MS * 2 ** exponent;
  return Math.min(ms, DIGEST_BACKOFF_MAX_MS);
}

// Classify a digest error message as "retrying won't help today" — typically
// MIMO rejecting the configured model with HTTP 400. The digest then skips
// for the rest of the day rather than burning backoff slots on a request
// that will fail identically every time.
export function isUnsupportedModelError(detail: string): boolean {
  return /not supported model/i.test(detail);
}

function recordDigestFailure(
  db: Db,
  repoId: number,
  nextAttemptAt: string,
): { failureCount: number } {
  db.prepare(
    `UPDATE director_budget_state
     SET digest_failure_count = digest_failure_count + 1,
         digest_next_attempt_at = ?
     WHERE repo_id = ?`,
  ).run(nextAttemptAt, repoId);
  const row = db
    .prepare(`SELECT digest_failure_count FROM director_budget_state WHERE repo_id = ?`)
    .get(repoId) as { digest_failure_count: number };
  return { failureCount: row.digest_failure_count };
}

function resetDigestRetryState(db: Db, repoId: number): void {
  db.prepare(
    `UPDATE director_budget_state
     SET digest_failure_count = 0,
         digest_next_attempt_at = NULL
     WHERE repo_id = ?`,
  ).run(repoId);
}

// ── Digest tick runner ──────────────────────────────────────────────────

const DIGEST_TIMEOUT_MS = 60_000;

export type DigestRunOptions = {
  db: Db;
  repoId: number;
  repo: RepoConfig;
  digest: DigestConfig;
  persona: Persona | undefined;
  language: string;
  dataDir: string;
  // Cheap engine — MIMO by default. Test override.
  engineFactory: () => Engine;
  // Inject "now" for tests.
  now?: Date;
};

export type DigestRunResult = {
  status: "ok" | "skipped" | "error";
  detail: string;
  costUsd: number;
};

export async function runDigest(opts: DigestRunOptions): Promise<DigestRunResult> {
  const { db, repoId, repo, digest, language, dataDir } = opts;
  const persona = opts.persona ?? PersonaSchema.parse({});
  const now = opts.now ?? new Date();
  const today = localDateInTz(now, digest.timezone);

  const state = captureStateSnapshot(db, repoId, repo.owner, repo.name);
  const template = loadTemplate("director-digest", repo, dataDir);
  const userPrompt = renderTemplate(template, {
    owner: repo.owner,
    name: repo.name,
    today,
    timezone: digest.timezone,
    persona_name: persona.name,
    language,
    state_json: JSON.stringify(state, null, 2),
  });
  const systemPrompt =
    `You are ${persona.name}, the ${persona.role} for ${repo.owner}/${repo.name}. ` +
    `Voice: ${persona.voice}. ` +
    "Produce a SHORT morning digest — 4–8 lines, plain prose with optional bullet list. " +
    "No JSON, no decisions, no markdown headers. " +
    "Highlight only what changed overnight or what needs attention now. " +
    "If nothing of note happened, say so honestly in one sentence.";

  const engine = opts.engineFactory();
  let llmResult;
  try {
    // engine.run requires a non-empty model name on most providers — passing
    // "" sends an empty `model` field to MIMO which rejects it as
    // "Not supported model". Use the engine's defaultModel so the call
    // honours whatever the factory was configured with.
    llmResult = await engine.run({
      systemPrompt,
      userPrompt,
      timeoutMs: DIGEST_TIMEOUT_MS,
      model: engine.defaultModel,
      expectJson: false,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Permanent classification: the configured model is rejected by MIMO,
    // so retrying with the same config will fail identically. Post ONE
    // notification of unavailability, mark today as fired so the loop
    // stops retrying for the rest of the day, and reset the backoff state.
    // Tomorrow's wake-up will attempt again — by then the operator has
    // had a chance to fix the model name.
    if (isUnsupportedModelError(detail)) {
      appendMessage(db, {
        repoId,
        role: "system",
        type: "error",
        body:
          `digest unavailable: ${detail}. ` +
          `Configured digest model is not supported by MIMO — set OPENRONIN_DIRECTOR_DIGEST_MODEL ` +
          `to a valid model (e.g. mimo-v2.5-pro). Skipping digest for ${today}.`,
        metadata: {
          repo: repoKey(repo),
          kind: "digest",
          today,
          classification: "model_unavailable",
        },
      });
      recordDigestFired(db, repoId, today);
      resetDigestRetryState(db, repoId);
      return { status: "error", detail, costUsd: 0 };
    }
    // Transient failure: bump the failure count, push next_attempt_at out
    // with exponential backoff, and post a single "failed, will retry"
    // message. Without this, the service loop would re-invoke runDigest
    // every 10s until midnight (issue #79).
    const prior = getDigestRetryState(db, repoId).failureCount;
    const projected = prior + 1;
    const nextAttemptMs = now.getTime() + computeDigestBackoffMs(projected);
    const nextAttemptIso = new Date(nextAttemptMs).toISOString();
    const { failureCount } = recordDigestFailure(db, repoId, nextAttemptIso);
    appendMessage(db, {
      repoId,
      role: "system",
      type: "error",
      body: `digest failed (attempt ${failureCount}): ${detail}. Next retry at ${nextAttemptIso}.`,
      metadata: {
        repo: repoKey(repo),
        kind: "digest",
        failureCount,
        nextAttemptAt: nextAttemptIso,
      },
    });
    return { status: "error", detail, costUsd: 0 };
  }

  const cost = llmResult.usage.costUsd ?? 0;
  recordThinkSpend(db, repoId, cost);

  appendMessage(db, {
    repoId,
    role: "director",
    type: "status",
    body: llmResult.content.trim(),
    metadata: {
      repo: repoKey(repo),
      kind: "digest",
      today,
      timezone: digest.timezone,
      tokensIn: llmResult.usage.tokensIn,
      tokensOut: llmResult.usage.tokensOut,
      costUsd: cost,
    },
  });
  recordDigestFired(db, repoId, today);
  resetDigestRetryState(db, repoId);
  return { status: "ok", detail: `digest posted for ${today}`, costUsd: cost };
}
