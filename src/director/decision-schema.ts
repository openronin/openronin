// Zod schemas for the structured output the Director's LLM tick produces.
//
// The LLM is instructed to emit a single JSON object matching `TickOutputSchema`.
// Each `decision` carries a discriminated `type` plus a type-specific `payload`
// shape. Anything that fails validation is rejected — the tick falls back to
// a no_op + an `error`-typed message in chat, so the audit trail stays clean.

import { z } from "zod";

// ── Per-decision payloads ────────────────────────────────────────────────

const CreateIssuePayload = z.object({
  title: z.string().min(5).max(200),
  body: z.string().min(20),
  labels: z.array(z.string()).default([]),
  priority: z.enum(["low", "normal", "high"]).default("normal"),
});
export type CreateIssuePayload = z.infer<typeof CreateIssuePayload>;

const CommentOnIssuePayload = z.object({
  issue_number: z.number().int().positive(),
  body: z.string().min(10),
});

const CommentOnPrPayload = z.object({
  pr_number: z.number().int().positive(),
  body: z.string().min(10),
});

const LabelIssuePayload = z.object({
  issue_number: z.number().int().positive(),
  add: z.array(z.string()).default([]),
  remove: z.array(z.string()).default([]),
});

const LabelPrPayload = z.object({
  pr_number: z.number().int().positive(),
  add: z.array(z.string()).default([]),
  remove: z.array(z.string()).default([]),
});

const CloseIssuePayload = z.object({
  issue_number: z.number().int().positive(),
  reason: z.string().min(10),
});

const ApprovePrPayload = z.object({
  pr_number: z.number().int().positive(),
  body: z.string().optional(),
});

const MergePrPayload = z.object({
  pr_number: z.number().int().positive(),
  strategy: z.enum(["merge", "squash", "rebase"]).default("squash"),
});

const AskUserPayload = z.object({
  question: z.string().min(10),
  context: z.string().optional(),
});

const AmendCharterPayload = z.object({
  proposed_changes: z.string().min(20),
  rationale: z.string().min(20),
});

// ── Decision union (discriminated by `type`) ─────────────────────────────

const DecisionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("no_op"),
    rationale: z.string().min(10),
  }),
  z.object({
    type: z.literal("create_issue"),
    rationale: z.string().min(10),
    priority_id: z.string().optional(),
    payload: CreateIssuePayload,
  }),
  z.object({
    type: z.literal("comment_on_issue"),
    rationale: z.string().min(10),
    priority_id: z.string().optional(),
    payload: CommentOnIssuePayload,
  }),
  z.object({
    type: z.literal("comment_on_pr"),
    rationale: z.string().min(10),
    priority_id: z.string().optional(),
    payload: CommentOnPrPayload,
  }),
  z.object({
    type: z.literal("label_issue"),
    rationale: z.string().min(10),
    priority_id: z.string().optional(),
    payload: LabelIssuePayload,
  }),
  z.object({
    type: z.literal("label_pr"),
    rationale: z.string().min(10),
    priority_id: z.string().optional(),
    payload: LabelPrPayload,
  }),
  z.object({
    type: z.literal("close_issue"),
    rationale: z.string().min(10),
    priority_id: z.string().optional(),
    payload: CloseIssuePayload,
  }),
  z.object({
    type: z.literal("approve_pr"),
    rationale: z.string().min(10),
    priority_id: z.string().optional(),
    payload: ApprovePrPayload,
  }),
  z.object({
    type: z.literal("merge_pr"),
    rationale: z.string().min(10),
    priority_id: z.string().optional(),
    payload: MergePrPayload,
  }),
  z.object({
    type: z.literal("ask_user"),
    rationale: z.string().min(10),
    priority_id: z.string().optional(),
    payload: AskUserPayload,
  }),
  z.object({
    type: z.literal("amend_charter"),
    rationale: z.string().min(10),
    priority_id: z.string().optional(),
    payload: AmendCharterPayload,
  }),
]);
export type ParsedDecision = z.infer<typeof DecisionSchema>;

// ── Top-level tick output ────────────────────────────────────────────────

export const TickOutputSchema = z.object({
  observations: z
    .string()
    .min(20)
    .describe("Plain-text summary of the project state. 2-3 sentences."),
  reasoning: z
    .string()
    .min(20)
    .describe("Why these decisions, citing which charter priorities they serve. 1-2 paragraphs."),
  decisions: z
    .array(DecisionSchema)
    .min(1)
    .max(10)
    .describe("0-10 actions to take. Use a single no_op when nothing is worth doing."),
});
export type TickOutput = z.infer<typeof TickOutputSchema>;

export function parseTickOutput(
  raw: unknown,
): { ok: true; value: TickOutput } | { ok: false; error: string } {
  const parsed = TickOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.message };
  }
  return { ok: true, value: parsed.data };
}
