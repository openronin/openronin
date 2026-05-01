// Director — autonomous PM layer.
//
// The Director is a separate systemd service (`openronin-director.service`)
// that shares the same code, DB, and data dir as the main openronin service
// but acts in a different role: it watches project state and decides what
// to do next, instead of waiting for human-supplied issues.
//
// This file defines the shapes that flow through the Director loop. The
// Director never edits source files directly — code mutations stay with the
// Claude Code worker, exactly like everywhere else. The Director only emits
// decisions (create issue, comment, approve merge, …) which are then carried
// out via the existing VcsProvider and lane infrastructure.

import { z } from "zod";

// ── Modes ────────────────────────────────────────────────────────────────
// Spectrum, not toggle. We ramp up confidence by stepping through these.
export const DirectorModeSchema = z.enum([
  "disabled",
  "dry_run", // think aloud, write to chat, never act
  "propose", // create artifacts only after explicit chat-approval
  "semi_auto", // act, except merges still need approval
  "full_auto", // act on everything, escalate only on failures
]);
export type DirectorMode = z.infer<typeof DirectorModeSchema>;

// ── Authority ────────────────────────────────────────────────────────────
// Per-decision-type permission. The composition `mode × authority` decides
// whether a particular decision is executed automatically, queued for human
// approval, or refused.
export const DirectorAuthoritySchema = z
  .object({
    can_create_issues: z.boolean().default(true),
    can_label: z.boolean().default(true),
    can_close_issues: z.boolean().default(false),
    can_comment: z.boolean().default(true),
    can_approve_pr: z.boolean().default(true),
    can_merge: z.boolean().default(false),
    can_modify_charter: z.boolean().default(false),
  })
  .default({});
export type DirectorAuthority = z.infer<typeof DirectorAuthoritySchema>;

// ── Charter ──────────────────────────────────────────────────────────────
// The Director's "constitution" for a repo. Static base in YAML; runtime
// overlays come from the chat thread (e.g. `directive` messages can adjust
// priorities). Hashed so every decision can pin exactly which version of
// the charter it was produced under.
export const CharterPrioritySchema = z.object({
  id: z.string().min(1),
  weight: z.number().min(0).max(1),
  rubric: z.string().min(1),
});
export type CharterPriority = z.infer<typeof CharterPrioritySchema>;

export const CharterSchema = z.object({
  vision: z.string().min(1),
  priorities: z.array(CharterPrioritySchema).min(1),
  out_of_bounds: z.array(z.string()).default([]),
  out_of_bounds_paths: z.array(z.string()).default([]),
  definition_of_done: z.array(z.string()).default([]),
  notes: z.string().optional(),
});
export type Charter = z.infer<typeof CharterSchema>;

// ── Budget ───────────────────────────────────────────────────────────────
// Adaptive: starts conservative, climbs on good outcomes, shrinks on bad.
// Two separate cost streams:
//   • project budget — what the Director's spawned issues cost the worker
//   • think budget   — what the Director itself spends on Claude calls
// Failure-streak gate is independent of budget.
export const BudgetConfigSchema = z
  .object({
    initial_daily_usd: z.number().nonnegative().default(2.0),
    initial_weekly_usd: z.number().nonnegative().default(10.0),
    max_daily_usd: z.number().nonnegative().default(10.0),
    max_weekly_usd: z.number().nonnegative().default(50.0),
    think_daily_usd: z.number().nonnegative().default(1.0),
    pause_on_failure_streak: z.number().int().nonnegative().default(3),
    good_outcome_quarantine_days: z.number().int().positive().default(7),
  })
  .default({});
export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;

export type BudgetState = {
  repoId: number;
  dailyCapUsd: number;
  weeklyCapUsd: number;
  spentTodayUsd: number;
  spentWeekUsd: number;
  spentTodayThinkUsd: number;
  failureStreak: number;
  lastTickAt: string | null;
  lastResetDay: string | null;
  paused: boolean;
  pauseReason: string | null;
};

// ── Director config (per-repo block, lives in repo YAML) ─────────────────
export const DirectorConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    mode: DirectorModeSchema.default("dry_run"),
    cadence_hours: z.number().positive().default(6),
    bot_prefix: z.string().default("👔 director:"),
    charter: CharterSchema.optional(),
    budget: BudgetConfigSchema,
    authority: DirectorAuthoritySchema,
  })
  .default({});
export type DirectorConfig = z.infer<typeof DirectorConfigSchema>;

// ── Messages ─────────────────────────────────────────────────────────────
// The chat thread is the live communication channel between user and
// Director. Each tick reads recent messages, each decision writes a
// status/proposal/report message back. Approvals queue is just messages
// of type `proposal` whose decision_id is still in outcome=pending.
export const MessageRoleSchema = z.enum(["director", "user", "system"]);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const MessageTypeSchema = z.enum([
  "status",
  "proposal",
  "question",
  "directive",
  "answer",
  "veto",
  "report",
  "tick_log",
  "error",
]);
export type MessageType = z.infer<typeof MessageTypeSchema>;

export type DirectorMessage = {
  id: number;
  repoId: number;
  ts: string;
  role: MessageRole;
  type: MessageType;
  body: string;
  metadata: Record<string, unknown> | null;
  parentId: number | null;
  decisionId: number | null;
};

export type NewDirectorMessage = {
  repoId: number;
  role: MessageRole;
  type: MessageType;
  body: string;
  metadata?: Record<string, unknown> | null;
  parentId?: number | null;
  decisionId?: number | null;
};

// ── Decisions ────────────────────────────────────────────────────────────
// Structured output the LLM produces each tick. Each decision is persisted
// before any side-effect, so the audit trail is complete even if the
// service crashes mid-execution.
export const DecisionTypeSchema = z.enum([
  "no_op", // tick produced nothing actionable
  "create_issue",
  "comment_on_issue",
  "comment_on_pr",
  "label_issue",
  "label_pr",
  "close_issue", // requires authority.can_close_issues
  "approve_pr", // approves via review (no merge)
  "merge_pr", // merges (gated by mode + authority.can_merge)
  "ask_user", // post a question into the chat, expect answer
  "amend_charter", // requires authority.can_modify_charter
]);
export type DecisionType = z.infer<typeof DecisionTypeSchema>;

export const DecisionOutcomeSchema = z.enum([
  "pending",
  "executed",
  "rejected", // human said no in chat
  "expired", // sat in queue too long
  "failed", // tried to execute, side-effect blew up
  "dry_run", // mode was dry_run, decision logged but never attempted
  "skipped", // gated out by authority/budget/charter
]);
export type DecisionOutcome = z.infer<typeof DecisionOutcomeSchema>;

export type Decision = {
  id: number;
  repoId: number;
  ts: string;
  decisionType: DecisionType;
  rationale: string;
  charterVersion: number | null;
  stateSnapshot: unknown;
  payload: unknown;
  outcome: DecisionOutcome;
  outcomeTs: string | null;
  outcomeDetails: string | null;
  costUsd: number;
};

export type NewDecision = {
  repoId: number;
  decisionType: DecisionType;
  rationale: string;
  charterVersion?: number | null;
  stateSnapshot?: unknown;
  payload?: unknown;
  outcome?: DecisionOutcome;
  costUsd?: number;
};

// ── Tick result ──────────────────────────────────────────────────────────
export type TickReason = "scheduled" | "manual" | "user_message" | "pr_event" | "issue_event";

export type TickContext = {
  reason: TickReason;
  triggeredBy?: string;
};

export type TickResult = {
  status: "ok" | "skipped" | "paused" | "error";
  detail: string;
  decisionsLogged: number;
  costUsd: number;
};
