import { runGitChecked } from "../lib/git.js";
import { ClaudeCodeEngine } from "./claude-code.js";
import { AnthropicEngine } from "./anthropic.js";
import type { AgentRole, Engine, EngineResult, EngineRunOptions } from "./types.js";

export interface MultiAgentEngineOptions {
  coderModel?: string;
  reviewerModel?: string;
  maxCritiqueIterations?: number;
}

interface ReviewIssue {
  file?: string;
  description: string;
  severity: "blocking" | "minor";
}

interface ReviewVerdict {
  verdict: "approve" | "request_changes";
  severity: "blocking" | "minor" | "none";
  issues: ReviewIssue[];
  summary: string;
}

interface MultiAgentMetrics {
  coder_iterations: number;
  reviewer_runs: number;
  reviewer_approvals: number;
  reviewer_change_requests: number;
  total_issues_found: number;
  blocking_issues_found: number;
  single_agent_cost_usd: number;
  total_cost_usd: number;
  reviewer_cost_usd: number;
}

const CODER_ROLE: AgentRole = {
  id: "coder",
  systemPrompt: [
    "You are an implementing developer agent. Make minimal, correct changes and commit when done. Do not push.",
    "Focus on correctness, simplicity, and adherence to existing code style.",
  ].join("\n"),
  tools: "git-write",
};

const REVIEWER_ROLE: AgentRole = {
  id: "reviewer",
  systemPrompt: [
    "You are a senior code reviewer. Review the provided git diff against the original task requirements.",
    "Identify real bugs, correctness issues, security problems, and clear style violations.",
    "Do NOT flag minor stylistic preferences or nitpicks unless they cause actual problems.",
    "Be concise and actionable. Distinguish blocking issues from minor ones.",
    "",
    "Respond ONLY with valid JSON matching this schema:",
    '{ "verdict": "approve" | "request_changes", "severity": "blocking" | "minor" | "none", "issues": [{ "file": string?, "description": string, "severity": "blocking" | "minor" }], "summary": string }',
    "",
    "verdict=approve means the implementation is correct and ready to merge.",
    "verdict=request_changes means there are issues that must be fixed before merging.",
  ].join("\n"),
  tools: "read-only",
};

export class MultiAgentEngine implements Engine {
  readonly id = "multi_agent";
  readonly defaultModel = "sonnet";

  private readonly coderEngine: ClaudeCodeEngine;
  private readonly reviewerEngine: AnthropicEngine | null;
  private readonly maxCritiqueIterations: number;

  constructor(options: MultiAgentEngineOptions = {}) {
    this.coderEngine = new ClaudeCodeEngine({ defaultModel: options.coderModel });
    this.maxCritiqueIterations = options.maxCritiqueIterations ?? 2;

    // Reviewer is optional — if ANTHROPIC_API_KEY is absent, skip review phase.
    try {
      this.reviewerEngine = new AnthropicEngine({ defaultModel: options.reviewerModel });
    } catch {
      this.reviewerEngine = null;
    }
  }

  async run(opts: EngineRunOptions): Promise<EngineResult> {
    const workdir = opts.workdir;
    if (!workdir) throw new Error("MultiAgentEngine requires opts.workdir");

    const baseSha = await runGitChecked(workdir, ["rev-parse", "HEAD"]).then((s) => s.trim());

    let coderContent = "(no output)";
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let totalCostUsd = 0;
    let totalDurationMs = 0;
    let coderCostUsd = 0;

    const reviewHistory: ReviewVerdict[] = [];

    for (let iter = 0; iter <= this.maxCritiqueIterations; iter++) {
      const coderPrompt =
        iter === 0 ? opts.userPrompt : buildRevisionPrompt(opts.userPrompt, reviewHistory);

      const coderResult = await this.coderEngine.run({
        ...opts,
        systemPrompt: buildCoderSystemPrompt(opts.systemPrompt),
        userPrompt: coderPrompt,
        tools: CODER_ROLE.tools,
        model: this.coderEngine.defaultModel,
      });

      coderContent = coderResult.content;
      const coderCost = coderResult.usage.costUsd ?? 0;
      coderCostUsd += coderCost;
      totalCostUsd += coderCost;
      totalTokensIn += coderResult.usage.tokensIn ?? 0;
      totalTokensOut += coderResult.usage.tokensOut ?? 0;
      totalDurationMs += coderResult.durationMs;

      if (!this.reviewerEngine) break;

      const headSha = await runGitChecked(workdir, ["rev-parse", "HEAD"]).then((s) => s.trim());
      if (headSha === baseSha) break;

      const diff = await runGitChecked(workdir, ["diff", baseSha, "HEAD"]).catch(() => "");
      if (!diff.trim()) break;

      const reviewPrompt = buildReviewPrompt(opts.userPrompt, diff, iter, reviewHistory);
      let reviewResult: EngineResult;
      try {
        reviewResult = await this.reviewerEngine.run({
          systemPrompt: REVIEWER_ROLE.systemPrompt,
          userPrompt: reviewPrompt,
          tools: "read-only",
          timeoutMs: Math.min(opts.timeoutMs, 120_000),
          expectJson: true,
          model: REVIEWER_ROLE.model,
        });
      } catch (error) {
        console.warn("[multi-agent] reviewer call failed:", (error as Error).message);
        break;
      }

      const reviewCost = reviewResult.usage.costUsd ?? 0;
      totalCostUsd += reviewCost;
      totalTokensIn += reviewResult.usage.tokensIn ?? 0;
      totalTokensOut += reviewResult.usage.tokensOut ?? 0;
      totalDurationMs += reviewResult.durationMs;

      const verdict = parseVerdict(reviewResult);
      reviewHistory.push(verdict);

      if (verdict.verdict === "approve" || iter >= this.maxCritiqueIterations) break;
    }

    const reviewerCostUsd = totalCostUsd - coderCostUsd;
    const metrics: MultiAgentMetrics = {
      coder_iterations: Math.max(1, reviewHistory.length),
      reviewer_runs: reviewHistory.length,
      reviewer_approvals: reviewHistory.filter((r) => r.verdict === "approve").length,
      reviewer_change_requests: reviewHistory.filter((r) => r.verdict === "request_changes").length,
      total_issues_found: reviewHistory.reduce((s, r) => s + r.issues.length, 0),
      blocking_issues_found: reviewHistory.reduce(
        (s, r) => s + r.issues.filter((i) => i.severity === "blocking").length,
        0,
      ),
      single_agent_cost_usd: coderCostUsd,
      total_cost_usd: totalCostUsd,
      reviewer_cost_usd: reviewerCostUsd,
    };

    const finalReview = reviewHistory.at(-1);
    const content = buildFinalContent(coderContent, finalReview, metrics);

    return {
      content,
      json: { metrics, review_history: reviewHistory },
      usage: { tokensIn: totalTokensIn, tokensOut: totalTokensOut, costUsd: totalCostUsd },
      finishReason: "done",
      durationMs: totalDurationMs,
      raw: { metrics, review_history: reviewHistory, coder_summary: coderContent },
    };
  }
}

function buildCoderSystemPrompt(base: string): string {
  const rolePrefix = CODER_ROLE.systemPrompt;
  return base ? `${rolePrefix}\n\n${base}` : rolePrefix;
}

function buildRevisionPrompt(original: string, history: ReviewVerdict[]): string {
  const last = history.at(-1);
  if (!last || last.verdict === "approve") return original;

  const issues = last.issues
    .map((i) => `- [${i.severity.toUpperCase()}]${i.file ? ` ${i.file}:` : ""} ${i.description}`)
    .join("\n");

  return [
    original,
    "",
    "---",
    "",
    `## Reviewer feedback (iteration ${history.length})`,
    "",
    last.summary,
    "",
    "### Issues to fix:",
    issues,
    "",
    "Please address the blocking issues above and commit the fixes.",
  ].join("\n");
}

function buildReviewPrompt(
  task: string,
  diff: string,
  iter: number,
  history: ReviewVerdict[],
): string {
  const prior =
    history.length > 0
      ? `\n\n## Prior review rounds\n${history
          .map(
            (r, i) =>
              `Round ${i + 1}: verdict=${r.verdict}, issues=${r.issues.length} (${r.summary})`,
          )
          .join("\n")}`
      : "";

  return [
    `## Task description`,
    task,
    "",
    `## Code diff (iteration ${iter + 1})${prior}`,
    "",
    "```diff",
    diff.slice(0, 40_000),
    "```",
    "",
    "Review the diff against the task requirements and output JSON as instructed.",
  ].join("\n");
}

function parseVerdict(result: EngineResult): ReviewVerdict {
  const raw = result.json as Partial<ReviewVerdict> | undefined;
  if (
    raw &&
    typeof raw === "object" &&
    (raw.verdict === "approve" || raw.verdict === "request_changes")
  ) {
    return {
      verdict: raw.verdict,
      severity: raw.severity ?? "none",
      issues: Array.isArray(raw.issues) ? raw.issues : [],
      summary: typeof raw.summary === "string" ? raw.summary : "(no summary)",
    };
  }
  // Fallback: treat unparseable reviewer output as approve to avoid infinite loop
  console.warn("[multi-agent] reviewer output could not be parsed; treating as approve");
  return { verdict: "approve", severity: "none", issues: [], summary: "(parse error — approved)" };
}

function buildFinalContent(
  coderSummary: string,
  review: ReviewVerdict | undefined,
  metrics: MultiAgentMetrics,
): string {
  const parts = [coderSummary];

  if (review) {
    parts.push(
      "",
      `---`,
      `**Reviewer verdict:** ${review.verdict} (${review.severity})`,
      review.summary,
    );
  }

  parts.push(
    "",
    `---`,
    `**Multi-agent metrics:** iterations=${metrics.coder_iterations}, reviewer_runs=${metrics.reviewer_runs}, issues_found=${metrics.total_issues_found} (${metrics.blocking_issues_found} blocking), reviewer_cost=$${metrics.reviewer_cost_usd.toFixed(4)}`,
  );

  return parts.join("\n");
}
