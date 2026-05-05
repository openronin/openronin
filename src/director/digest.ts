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
//   • we haven't already fired a digest for today's local date.
//
// `now` is injectable for tests; production passes `new Date()`.
export function shouldRunDigest(
  digest: DigestConfig,
  lastDigestDate: string | null,
  now: Date = new Date(),
): boolean {
  if (!digest.enabled) return false;
  const hour = localHourInTz(now, digest.timezone);
  if (hour < digest.hour) return false;
  const today = localDateInTz(now, digest.timezone);
  return lastDigestDate !== today;
}

// Persist that we've fired today's digest. Called after a successful run
// (and skipped on failure so we'll retry on the next loop pass).
export function recordDigestFired(db: Db, repoId: number, today: string): void {
  db.prepare(`UPDATE director_budget_state SET last_digest_date = ? WHERE repo_id = ?`).run(
    today,
    repoId,
  );
}

export function getLastDigestDate(db: Db, repoId: number): string | null {
  const row = db
    .prepare(`SELECT last_digest_date FROM director_budget_state WHERE repo_id = ?`)
    .get(repoId) as { last_digest_date: string | null } | undefined;
  return row?.last_digest_date ?? null;
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
    llmResult = await engine.run({
      systemPrompt,
      userPrompt,
      timeoutMs: DIGEST_TIMEOUT_MS,
      model: "",
      expectJson: false,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    appendMessage(db, {
      repoId,
      role: "system",
      type: "error",
      body: `digest failed: ${detail}`,
      metadata: { repo: repoKey(repo), kind: "digest" },
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
  return { status: "ok", detail: `digest posted for ${today}`, costUsd: cost };
}
