// Decision payload hashing + duplicate detection.
//
// The Director used to happily propose the same create_issue ("add per-repo
// cost view") tick after tick — the state snapshot didn't surface
// just-proposed-but-not-yet-merged work, and even when it did, the LLM's
// re-summary drifted enough that a naive equality check missed it.
//
// We address it with a normalised payload hash. The hash is intentionally
// lossy: it folds case, whitespace, leading articles, and trailing
// punctuation so cosmetic re-wordings collapse to the same bucket. The
// hash is computed and stored on every insert; before persisting a new
// decision we check whether a row with the same hash exists in
// (pending | executed) state within the last 7 days. If yes → outcome
// is recorded as 'skipped' with a duplicate-of-#N reason instead of
// being routed through the executor.
//
// Hashing is per-decision-type so e.g. "create_issue with title X" and
// "comment_on_issue with body X" never collide.

import { createHash } from "node:crypto";
import type { Db } from "../storage/db.js";

// 7-day lookback for dedup. Long enough to catch "the LLM re-proposes
// every other tick" loops; short enough that genuinely-identical work
// across weeks (which is rare and usually intentional) goes through.
export const DEDUP_LOOKBACK_DAYS = 7;

// Normalise free-form text for hashing: lowercase, collapse whitespace,
// strip a few common prefix/suffix patterns ("issue:", trailing periods,
// etc.) so cosmetic edits don't dodge the dedup.
export function normaliseText(s: unknown): string {
  if (typeof s !== "string") return "";
  return s
    .toLowerCase()
    .replace(/^\s*(issue|task|chore|todo)\s*[:\-]\s*/u, "")
    .replace(/\s+/gu, " ")
    .replace(/[\s.!?,;:—–-]+$/u, "")
    .trim();
}

function firstParagraph(s: unknown): string {
  if (typeof s !== "string") return "";
  const block = s.split(/\n\s*\n/u)[0] ?? "";
  return normaliseText(block);
}

function csv(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return [...new Set(value.map((v) => normaliseText(v)).filter(Boolean))].sort().join(",");
}

// Build a stable canonical string for a (decision_type, payload) pair.
// Returns null when the type is one for which dedup doesn't make sense
// (no_op, ask_user — both of which are cheap and idempotent already).
export function canonicalForHash(decisionType: string, payload: unknown): string | null {
  const p = (payload ?? {}) as Record<string, unknown>;
  switch (decisionType) {
    case "create_issue":
      return `create_issue|${normaliseText(p.title)}|${firstParagraph(p.body)}`;
    case "comment_on_issue":
      return `comment_on_issue|${p.issue_number ?? ""}|${normaliseText(p.body)}`;
    case "comment_on_pr":
      return `comment_on_pr|${p.pr_number ?? ""}|${normaliseText(p.body)}`;
    case "label_issue":
      return `label_issue|${p.issue_number ?? ""}|${csv(p.add)}|${csv(p.remove)}`;
    case "label_pr":
      return `label_pr|${p.pr_number ?? ""}|${csv(p.add)}|${csv(p.remove)}`;
    case "close_issue":
      return `close_issue|${p.issue_number ?? ""}`;
    case "approve_pr":
      return `approve_pr|${p.pr_number ?? ""}`;
    case "merge_pr":
      return `merge_pr|${p.pr_number ?? ""}`;
    case "amend_charter":
      return `amend_charter|${normaliseText(p.proposed_changes)}`;
    case "ask_user":
    case "no_op":
      return null;
    default:
      return null;
  }
}

export function hashPayload(decisionType: string, payload: unknown): string | null {
  const canon = canonicalForHash(decisionType, payload);
  if (!canon) return null;
  return createHash("sha256").update(canon).digest("hex").slice(0, 16);
}

// Look up a recent decision matching the same hash on the same repo.
// Returns the decision id if found, otherwise null. Excludes outcomes that
// don't represent a still-living proposal (rejected/expired/failed) — only
// pending and executed count, since those are the ones a duplicate would
// actually conflict with.
export function findRecentDuplicate(
  db: Db,
  repoId: number,
  payloadHash: string,
  lookbackDays: number = DEDUP_LOOKBACK_DAYS,
): number | null {
  const row = db
    .prepare(
      `SELECT id FROM director_decisions
       WHERE repo_id = ?
         AND payload_hash = ?
         AND outcome IN ('pending', 'executed')
         AND ts > datetime('now', ?)
       ORDER BY id DESC LIMIT 1`,
    )
    .get(repoId, payloadHash, `-${lookbackDays} days`) as { id: number } | undefined;
  return row ? row.id : null;
}
