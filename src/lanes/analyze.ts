import { z } from "zod";
import type { VcsItem, ReviewComment } from "../providers/vcs.js";
import { GithubVcsProvider } from "../providers/github.js";
import { loadTemplate, renderTemplate } from "../prompts/registry.js";
import { runJob, type SupervisorContext } from "../supervisor/index.js";
import { ensureRepo, recordTaskDecision, upsertTask } from "../storage/tasks.js";
import { isBotMessage, pick, BOT_PREFIX } from "./messages.js";

export const AnalyzeSchema = z.object({
  state: z.enum(["ready", "needs_clarification"]),
  summary: z.string().default(""),
  // MIMO sometimes returns a bullet list as a JSON array; accept both shapes
  // and normalise to a markdown bullet string downstream.
  expanded_requirements: z
    .union([z.string(), z.array(z.string())])
    .transform((v) => (Array.isArray(v) ? v.map((s) => `- ${s}`).join("\n") : v))
    .default(""),
  files_likely_touched: z.array(z.string()).default([]),
  questions: z.array(z.string()).default([]),
  rationale: z.string().default(""),
});

export type AnalyzeDecision = z.infer<typeof AnalyzeSchema>;

export interface AnalyzeResult {
  outcome: "ready" | "needs_clarification" | "skipped_awaiting_answer" | "error";
  taskId: number;
  decision?: AnalyzeDecision;
  detail?: string;
  runId?: number;
}

export interface AnalyzeInput {
  ctx: SupervisorContext;
  item: VcsItem;
  timeoutMs?: number;
}

// Per-task storage shape that gates the patch lane. Stored under
// tasks.decision_json with lane="analyze".
export interface StoredAnalyzeState {
  lane: "analyze";
  state: "ready" | "needs_clarification";
  expanded_requirements?: string;
  summary?: string;
  asked_questions?: string[];
  asked_at?: string;
  iteration: number;
}

export async function runAnalyze(input: AnalyzeInput): Promise<AnalyzeResult> {
  const { ctx, item } = input;
  const repo = ctx.repo;
  const lang = pick(repo.language_for_communication);
  const repoId = ensureRepo(ctx.db, {
    provider: repo.provider,
    owner: repo.owner,
    name: repo.name,
  });
  const taskId = upsertTask(ctx.db, repoId, String(item.number), item.kind);

  const provider = new GithubVcsProvider();
  const ackRef = { owner: repo.owner, name: repo.name };

  // Fetch the full thread INCLUDING the bot's own previous comments. The
  // analyzer is a one-shot read; it does not generate new bot replies that
  // could trigger a webhook loop, so we don't need the isBotMessage filter
  // here. The model needs to see its own prior questions to know which
  // points the maintainer has already addressed.
  let allComments: ReviewComment[] = [];
  // Subset of the above that the human posted — used for the awaiting-answer
  // gate (so the bot doesn't re-process its own comments as "new replies").
  let humanComments: ReviewComment[] = [];
  try {
    allComments = await provider.listAllPrFeedback(ackRef, item.number);
    humanComments = allComments.filter((c) => !isBotMessage(c.body));
  } catch {
    // best-effort
  }

  // ---- Re-open detection ----------------------------------------------------
  // If the task has a previously closed pr_branches row AND there are human
  // comments newer than that row's updated_at, this is a follow-up round.
  // We fetch the merged PR metadata and inject it into the prompt.
  let previousRoundBlock = "";
  try {
    const closedBranch = ctx.db
      .prepare(
        `SELECT * FROM pr_branches WHERE task_id = ? AND status = 'closed' ORDER BY id DESC LIMIT 1`,
      )
      .get(taskId) as
      | {
          pr_number: number | null;
          pr_url: string | null;
          updated_at: string | null;
        }
      | undefined;

    if (closedBranch?.pr_number != null) {
      const closedAt = closedBranch.updated_at ? new Date(closedBranch.updated_at).getTime() : 0;
      const hasNewHumanComment = humanComments.some(
        (c) => new Date(c.createdAt).getTime() > closedAt,
      );

      if (hasNewHumanComment) {
        const prMeta = await provider.getPullRequestMeta(ackRef, closedBranch.pr_number);

        // Pull previously stored expanded_requirements from task decision_json.
        let prevRequirements = "";
        try {
          const taskRow = ctx.db
            .prepare("SELECT decision_json FROM tasks WHERE id = ?")
            .get(taskId) as { decision_json: string | null } | undefined;
          if (taskRow?.decision_json) {
            const stored = JSON.parse(taskRow.decision_json) as { expanded_requirements?: string };
            prevRequirements = stored.expanded_requirements ?? "";
          }
        } catch {
          // ignore
        }

        const fileList =
          prMeta.filesChanged.length > 0
            ? prMeta.filesChanged.map((f) => `- \`${f}\``).join("\n")
            : "(no files listed)";

        previousRoundBlock = `## Previous round (re-open follow-up)

This issue was previously worked on and the PR was merged. The maintainer has re-opened it with a follow-up request. **Do NOT re-analyse from scratch.** Focus on the new comments below (those posted after the previous PR was closed) as the delta to implement.

- **Merged PR:** [#${prMeta.number} — ${prMeta.title}](${prMeta.url})
- **Merge commit:** ${prMeta.mergeCommitSha ?? "(unknown)"}

### Files changed in previous round

${fileList}

### Previous expanded requirements

${prevRequirements || "(not recorded)"}

---`;
      }
    }
  } catch {
    // best-effort — if PR fetch fails, proceed as fresh task
  }

  // ---- Awaiting-answer short-circuit ----------------------------------------
  // If the bot already asked questions on this issue and the human hasn't
  // replied yet, do NOT re-run the analyzer — that's how duplicate question
  // comments get posted while the human is still typing their answer. The
  // signal is the awaiting_answer_label being on the issue AND the existence
  // of a stored asked_at timestamp with no newer non-bot comment.
  if (item.labels.includes(repo.awaiting_answer_label)) {
    const taskRow = ctx.db.prepare("SELECT decision_json FROM tasks WHERE id = ?").get(taskId) as
      | { decision_json: string | null }
      | undefined;
    let askedAt: string | undefined;
    try {
      const stored = taskRow?.decision_json
        ? (JSON.parse(taskRow.decision_json) as { asked_at?: string })
        : undefined;
      askedAt = stored?.asked_at;
    } catch {
      // ignore — fall through and treat as no record
    }
    const askedAtMs = askedAt ? new Date(askedAt).getTime() : 0;
    const newReply = humanComments.some((c) => new Date(c.createdAt).getTime() > askedAtMs);
    if (!newReply) {
      return {
        outcome: "skipped_awaiting_answer",
        taskId,
        detail: askedAt
          ? `awaiting_answer label set; no new comment since ${askedAt}`
          : "awaiting_answer label set; no record of when we asked",
      };
    }
    // New reply present — clear the label and proceed with a fresh analysis.
    try {
      await provider.removeLabel(ackRef, item.number, repo.awaiting_answer_label);
    } catch {
      // best-effort
    }
  }

  const template = loadTemplate("analyze-issue", repo, ctx.config.dataDir);
  const userPrompt = renderTemplate(template, {
    kind: item.kind === "pull_request" ? "pull request" : "issue",
    repo_full_name: `${repo.owner}/${repo.name}`,
    number: String(item.number),
    title: item.title,
    url: item.url,
    author: item.author,
    author_association: item.authorAssociation,
    labels: item.labels.join(", ") || "(none)",
    body: item.body || "(empty body)",
    existing_comments:
      allComments.length === 0
        ? "(no existing comments)"
        : allComments
            .map(
              (c) => `### ${c.author} (${c.source}) — ${c.createdAt}\n${c.body || "_(no body)_"}`,
            )
            .join("\n\n---\n\n"),
    language_for_communication: repo.language_for_communication,
    language_for_commits: repo.language_for_commits,
    language_for_code_identifiers: repo.language_for_code_identifiers,
    previous_round: previousRoundBlock,
  });

  try {
    const job = await runJob(ctx, {
      jobType: "analyze",
      lane: "analyze",
      taskId,
      engineOpts: {
        systemPrompt: [
          "You are a product analyst. Read the task and decide whether it is concrete enough to implement.",
          `Project language rules: write JSON values in ${repo.language_for_communication}.`,
          `Return strict JSON only. No prose outside the JSON.`,
        ].join("\n"),
        userPrompt,
        timeoutMs: input.timeoutMs ?? 90_000,
        expectJson: true,
      },
    });

    const parsed = AnalyzeSchema.safeParse(job.result.json ?? {});
    if (!parsed.success) {
      console.warn(
        `[analyze] schema mismatch for #${item.number}; issues=${JSON.stringify(parsed.error.issues)}; raw json=${JSON.stringify(job.result.json).slice(0, 800)}; raw content=${job.result.content.slice(0, 500)}`,
      );
    }
    const decision = parsed.success
      ? parsed.data
      : ({
          state: "needs_clarification",
          summary: "(analyzer returned malformed JSON)",
          expanded_requirements: "",
          files_likely_touched: [],
          questions: ["Analyzer не смог распарсить ответ — пожалуйста уточни задачу."],
          rationale: "fallback after JSON parse failure",
        } as AnalyzeDecision);

    // Persist into tasks.decision_json so worker.pickLane knows whether to gate or release patch.
    const stored: StoredAnalyzeState = {
      lane: "analyze",
      state: decision.state,
      iteration: 1,
      ...(decision.summary && { summary: decision.summary }),
      ...(decision.expanded_requirements && {
        expanded_requirements: decision.expanded_requirements,
      }),
      ...(decision.questions.length > 0 && {
        asked_questions: decision.questions,
        asked_at: new Date().toISOString(),
      }),
    };
    recordTaskDecision(ctx.db, taskId, job.result.content.slice(0, 16), JSON.stringify(stored));

    if (decision.state === "needs_clarification") {
      const body = renderQuestionsComment(lang, decision);
      try {
        await provider.postComment(ackRef, item.number, body);
      } catch (error) {
        console.warn(
          "[analyze] failed to post questions:",
          error instanceof Error ? error.message : error,
        );
      }
      // Mark the issue as awaiting an answer so we don't re-ask on the next
      // wake-up.
      try {
        await provider.addLabel(ackRef, item.number, repo.awaiting_answer_label);
      } catch {
        // best-effort
      }
      return {
        outcome: "needs_clarification",
        taskId,
        decision,
        detail: `${decision.questions.length} question(s) posted`,
        runId: job.runId,
      };
    }

    // state=ready: patch lane will use expanded_requirements as the task body.
    // Make sure no stale awaiting-* label lingers.
    try {
      await provider.removeLabel(ackRef, item.number, repo.awaiting_answer_label);
    } catch {
      // best-effort
    }
    if (repo.acknowledge_with_comment) {
      try {
        await provider.postComment(ackRef, item.number, renderReadyComment(lang, decision));
      } catch {
        // best-effort
      }
    }
    return {
      outcome: "ready",
      taskId,
      decision,
      detail: "task is concrete; patch lane will pick up next",
      runId: job.runId,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { outcome: "error", taskId, detail };
  }
}

function renderQuestionsComment(lang: ReturnType<typeof pick>, decision: AnalyzeDecision): string {
  const numbered = decision.questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
  return `${BOT_PREFIX} ${lang.analyze_questions_intro}

**${lang.analyze_summary_label}:** ${decision.summary || "—"}

${numbered}

${lang.analyze_questions_outro}`;
}

function renderReadyComment(lang: ReturnType<typeof pick>, decision: AnalyzeDecision): string {
  const files =
    decision.files_likely_touched.length > 0
      ? `\n\n**${lang.analyze_files_label}:** ${decision.files_likely_touched.join(", ")}`
      : "";
  return `${BOT_PREFIX} ${lang.analyze_ready_intro}

**${lang.analyze_summary_label}:** ${decision.summary}

**${lang.analyze_requirements_label}:**
${decision.expanded_requirements}${files}`;
}
