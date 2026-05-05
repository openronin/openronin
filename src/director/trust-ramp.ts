// Trust ramp suggestions.
//
// Mode escalation (`dry_run` → `propose` → `semi_auto` → `full_auto`) is
// gated on operator trust. Most operators flip these by hand once and
// forget; if the director's track record is good, suggesting "should we
// promote you?" gets the conversation started — and gives the operator a
// concrete data-driven prompt instead of a vague feeling.
//
// We don't change the mode programmatically. Mode lives in the per-repo
// YAML and is hot-reloaded from there; mutating it from a SQLite overlay
// would split the source of truth. So this module produces a *suggestion*
// posted to the chat thread; the operator flips the YAML themselves.
//
// The suggestion fires at most once every TRUST_RAMP_COOLDOWN_DAYS so a
// silent operator isn't pestered.

import type { Db } from "../storage/db.js";
import { appendMessage } from "./chat.js";
import { sampleRecentOutcomes } from "./retrospective.js";
import type { DirectorMode } from "./types.js";

// Window guardrails — match retrospective so the operator sees consistent
// numbers across "trust ramp suggested" and "budget recalibrated" notes.
const PROMOTE_THRESHOLD = 0.9;
const PROMOTE_MIN_SAMPLE = 30;
const DEMOTE_THRESHOLD = 0.4;
const DEMOTE_MIN_SAMPLE = 10;
const TRUST_RAMP_COOLDOWN_DAYS = 7;

export type TrustRampSuggestion =
  | { kind: "promote"; from: DirectorMode; to: DirectorMode; rate: number; sampleSize: number }
  | { kind: "demote"; from: DirectorMode; to: DirectorMode; rate: number; sampleSize: number }
  | { kind: "hold"; reason: string };

const PROMOTE_NEXT: Partial<Record<DirectorMode, DirectorMode>> = {
  dry_run: "propose",
  propose: "semi_auto",
  semi_auto: "full_auto",
};
const DEMOTE_NEXT: Partial<Record<DirectorMode, DirectorMode>> = {
  full_auto: "semi_auto",
  semi_auto: "propose",
  propose: "dry_run",
};

// Pure decision: given current mode + recent outcomes, what should we do?
// Returns "hold" with a reason when the data doesn't justify a move.
export function evaluateTrustRamp(
  db: Db,
  repoId: number,
  currentMode: DirectorMode,
): TrustRampSuggestion {
  const sample = sampleRecentOutcomes(db, repoId);
  const counted = sample.executed + sample.failed + sample.rejected;
  if (sample.successRate === null) {
    return { kind: "hold", reason: "no terminal outcomes in window yet" };
  }

  if (sample.successRate >= PROMOTE_THRESHOLD && counted >= PROMOTE_MIN_SAMPLE) {
    const next = PROMOTE_NEXT[currentMode];
    if (next === undefined) {
      return { kind: "hold", reason: `already at ${currentMode} (cannot promote further)` };
    }
    return { kind: "promote", from: currentMode, to: next, rate: sample.successRate, sampleSize: counted };
  }

  if (sample.successRate <= DEMOTE_THRESHOLD && counted >= DEMOTE_MIN_SAMPLE) {
    const next = DEMOTE_NEXT[currentMode];
    if (next === undefined) {
      return { kind: "hold", reason: `already at ${currentMode} (cannot demote further)` };
    }
    return { kind: "demote", from: currentMode, to: next, rate: sample.successRate, sampleSize: counted };
  }

  return {
    kind: "hold",
    reason: `success_rate ${(sample.successRate * 100).toFixed(0)}% over ${counted} decisions — neither threshold met`,
  };
}

// Has the trust ramp suggester posted in the last cooldown window? Looks
// for our own marker in metadata. Cheap query — lookups by repo + ts.
export function trustRampOnCooldown(db: Db, repoId: number): boolean {
  const row = db
    .prepare(
      `SELECT id FROM director_messages
       WHERE repo_id = ?
         AND metadata IS NOT NULL
         AND json_extract(metadata, '$.kind') = 'trust_ramp'
         AND ts > datetime('now', '-${TRUST_RAMP_COOLDOWN_DAYS} days')
       ORDER BY id DESC LIMIT 1`,
    )
    .get(repoId);
  return row !== undefined;
}

// Render the suggestion into a human-readable chat message body. Plain
// text — the chat surface markdown-renders it.
function suggestionBody(suggestion: TrustRampSuggestion, language: string): string {
  if (suggestion.kind === "hold") return ""; // never posted
  const ru = language.toLowerCase().includes("russian") || language.toLowerCase().includes("рус");
  const verb = suggestion.kind === "promote" ? (ru ? "повысить" : "promote") : (ru ? "понизить" : "demote");
  const ratePct = (suggestion.rate * 100).toFixed(0);
  if (ru) {
    return [
      `**Предложение по уровню доверия.** За последние 14 дней: ${suggestion.sampleSize} решений с финальным исходом, success rate ${ratePct}%.`,
      "",
      `Считаю, что можно ${verb} режим: \`${suggestion.from}\` → \`${suggestion.to}\`.`,
      "",
      `Чтобы применить — поправь в YAML \`director.mode: ${suggestion.to}\`. Hot-reload сразу подхватит.`,
    ].join("\n");
  }
  return [
    `**Trust ramp suggestion.** Last 14 days: ${suggestion.sampleSize} terminal decisions, success rate ${ratePct}%.`,
    "",
    `I'd ${verb} from \`${suggestion.from}\` to \`${suggestion.to}\`.`,
    "",
    `To apply, edit your repo YAML \`director.mode: ${suggestion.to}\`. Hot-reload picks it up.`,
  ].join("\n");
}

// Post the suggestion to the chat thread (if any) and return what we
// posted. Returns null when held / on cooldown — the caller can surface
// that in service-loop logs without writing chat noise.
export function maybePostTrustRampSuggestion(
  db: Db,
  repoId: number,
  currentMode: DirectorMode,
  language: string,
): TrustRampSuggestion | null {
  if (trustRampOnCooldown(db, repoId)) return null;
  const suggestion = evaluateTrustRamp(db, repoId, currentMode);
  if (suggestion.kind === "hold") return null;
  appendMessage(db, {
    repoId,
    role: "director",
    type: "question",
    body: suggestionBody(suggestion, language),
    metadata: {
      kind: "trust_ramp",
      direction: suggestion.kind,
      from: suggestion.from,
      to: suggestion.to,
      rate: suggestion.rate,
      sampleSize: suggestion.sampleSize,
    },
  });
  return suggestion;
}
