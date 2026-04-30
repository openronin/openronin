import { z } from "zod";
import type { VcsItem } from "../providers/vcs.js";
import { loadTemplate, renderTemplate } from "../prompts/registry.js";
import { runJob, type SelectionOverride, type SupervisorContext } from "../supervisor/index.js";
import { ensureRepo, recordTaskDecision, upsertTask } from "../storage/tasks.js";
import { computeItemSnapshot } from "../lib/snapshot.js";

export const ReviewDecisionSchema = z.object({
  decision: z.enum(["close", "keep_open"]),
  close_reason: z
    .enum([
      "implemented_on_main",
      "cannot_reproduce",
      "duplicate_or_superseded",
      "not_actionable_in_repo",
      "incoherent",
      "stale_insufficient_info",
      "none",
    ])
    .default("none"),
  confidence: z.enum(["high", "medium", "low"]),
  summary: z.string(),
  evidence: z.array(z.string()).default([]),
  comment: z.string().default(""),
});

export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;

export interface ReviewRunInput {
  ctx: SupervisorContext;
  item: VcsItem;
  override?: SelectionOverride;
  timeoutMs?: number;
}

export interface ReviewRunOutput {
  decision: ReviewDecision;
  raw: string;
  usage: { tokensIn?: number; tokensOut?: number; costUsd?: number };
  durationMs: number;
  runId: number;
  taskId: number;
  engine: string;
  model: string;
}

export async function runReview(input: ReviewRunInput): Promise<ReviewRunOutput> {
  const { ctx, item } = input;
  const template = loadTemplate("review-item", ctx.repo, ctx.config.dataDir);
  const userPrompt = renderTemplate(template, {
    kind: item.kind === "pull_request" ? "pull request" : "issue",
    repo_full_name: `${ctx.repo.owner}/${ctx.repo.name}`,
    number: String(item.number),
    title: item.title,
    url: item.url,
    author: item.author,
    author_association: item.authorAssociation,
    labels: item.labels.join(", ") || "(none)",
    created_at: item.createdAt,
    updated_at: item.updatedAt,
    body: item.body || "(empty body)",
    protected_labels: ctx.repo.protected_labels.join(", ") || "(none)",
    language_for_communication: ctx.repo.language_for_communication,
    language_for_commits: ctx.repo.language_for_commits,
    language_for_code_identifiers: ctx.repo.language_for_code_identifiers,
  });

  const repoId = ensureRepo(ctx.db, {
    provider: ctx.repo.provider,
    owner: ctx.repo.owner,
    name: ctx.repo.name,
  });
  const taskId = upsertTask(ctx.db, repoId, String(item.number), item.kind);

  const job = await runJob(ctx, {
    jobType: "triage",
    lane: "review",
    taskId,
    ...(input.override && { override: input.override }),
    engineOpts: {
      systemPrompt: "Return strict JSON matching the requested shape. No prose outside JSON.",
      userPrompt,
      timeoutMs: input.timeoutMs ?? 120_000,
      expectJson: true,
    },
  });

  const decision = ReviewDecisionSchema.parse(job.result.json ?? safeFallback(job.result.content));

  // Hard rules — even if the model says close, drop it for protected items.
  const isMaintainer = ["OWNER", "MEMBER", "COLLABORATOR"].includes(item.authorAssociation);
  const hasProtectedLabel = item.labels.some((l) => ctx.repo.protected_labels.includes(l));
  if ((isMaintainer || hasProtectedLabel) && decision.decision === "close") {
    decision.decision = "keep_open";
    decision.close_reason = "none";
    decision.confidence = "low";
    decision.summary =
      `[guardrail] forced keep_open: ${isMaintainer ? "maintainer-authored" : "protected label"}. ` +
      decision.summary;
    decision.comment = "";
  }

  const snapshot = computeItemSnapshot(item);

  recordTaskDecision(ctx.db, taskId, snapshot, JSON.stringify(decision));

  return {
    decision,
    raw: job.result.content,
    usage: job.result.usage,
    durationMs: job.result.durationMs,
    runId: job.runId,
    taskId,
    engine: job.choice.engine.id,
    model: job.choice.model,
  };
}

function safeFallback(content: string): unknown {
  return {
    decision: "keep_open",
    close_reason: "none",
    confidence: "low",
    summary: `[parse-fallback] could not extract JSON; raw output preserved (${content.length} chars).`,
    evidence: [],
    comment: "",
  };
}
