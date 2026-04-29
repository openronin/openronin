import { Octokit } from "@octokit/rest";
import { existsSync, readFileSync } from "node:fs";
import type { VcsItem } from "../providers/vcs.js";
import { loadTemplate, renderTemplate } from "../prompts/registry.js";
import { runJob, type SupervisorContext } from "../supervisor/index.js";
import { ensureRepo, recordTaskDecision, upsertTask } from "../storage/tasks.js";
import { recordPrBranch } from "../storage/pr-branches.js";
import { GithubVcsProvider } from "../providers/github.js";
import { pick } from "./messages.js";
import {
  checkoutNewBranch,
  cleanupWorkdir,
  clone,
  commitAll,
  diffStats,
  getCurrentSha,
  pushBranchWithToken,
  scrubSecrets,
  setBotIdentity,
  slugify,
  workdirFor,
  type DiffStats,
} from "../lib/git.js";
import { getPrBranchByPrNumber } from "../storage/pr-branches.js";

export type PatchOutcome = "pr_opened" | "no_changes" | "guardrail_blocked" | "error";

export interface PatchResult {
  outcome: PatchOutcome;
  taskId: number;
  branch: string;
  baseSha?: string;
  headSha?: string;
  prNumber?: number;
  prUrl?: string;
  diffStats?: DiffStats;
  detail?: string;
  agentSummary?: string;
  runId?: number;
}

export interface PatchInput {
  ctx: SupervisorContext;
  item: VcsItem;
  timeoutMs?: number;
}

export async function runPatch(input: PatchInput): Promise<PatchResult> {
  const { ctx, item } = input;
  const repo = ctx.repo;

  if (!repo.lanes.includes("patch")) {
    return {
      outcome: "error",
      taskId: -1,
      branch: "",
      detail: "patch lane not enabled for this repo",
    };
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) return { outcome: "error", taskId: -1, branch: "", detail: "GITHUB_TOKEN not set" };

  const repoId = ensureRepo(ctx.db, {
    provider: repo.provider,
    owner: repo.owner,
    name: repo.name,
  });
  const taskId = upsertTask(ctx.db, repoId, String(item.number), item.kind);
  const baseBranch = `openronin/${item.number}-${slugify(item.title) || "task"}`;
  // If a prior closed (merged) pr_branches row exists for this task, this is a
  // follow-up round. Append an incrementing suffix to avoid branch-name collisions.
  const closedCount = (
    ctx.db
      .prepare(`SELECT COUNT(*) AS cnt FROM pr_branches WHERE task_id = ? AND status = 'closed'`)
      .get(taskId) as { cnt: number }
  ).cnt;
  const branch = closedCount > 0 ? `${baseBranch}-${closedCount + 1}` : baseBranch;

  // Idempotency: if we already have an active PR for this issue, don't re-run.
  // CRITICAL: this check must happen BEFORE any acknowledgment is posted —
  // posting a comment fires another webhook event and would re-enter this lane
  // forever.
  const existing = ctx.db
    .prepare(
      `SELECT pb.* FROM pr_branches pb WHERE pb.task_id = ? AND pb.status IN ('created','open') ORDER BY pb.id DESC LIMIT 1`,
    )
    .get(taskId) as { id: number; pr_number: number | null; pr_url: string | null } | undefined;
  if (existing) {
    return {
      outcome: "no_changes",
      taskId,
      branch,
      ...(existing.pr_number != null && { prNumber: existing.pr_number }),
      ...(existing.pr_url != null && { prUrl: existing.pr_url }),
      detail: "task already has an active PR; skipping",
    };
  }

  // -- Visible acknowledgment so the human sees we picked it up. --
  const provider = new GithubVcsProvider();
  const lang = pick(repo.language_for_communication);
  const ackRef = { owner: repo.owner, name: repo.name };
  await safeAck(async () => {
    if (repo.acknowledge_with_reaction) {
      await provider.addReactionToIssue(ackRef, item.number, "eyes");
    }
    await provider.ensureLabelExists(
      ackRef,
      repo.in_progress_label,
      "fbca04",
      "openronin is working on this",
    );
    await provider.addLabel(ackRef, item.number, repo.in_progress_label);
    if (repo.acknowledge_with_comment) {
      await provider.postComment(ackRef, item.number, lang.taking_in_progress);
    }
  });
  const workdir = workdirFor(
    ctx.config.dataDir,
    `${repo.provider}__${repo.owner}`,
    repo.name,
    taskId,
  );
  const remoteUrl = `https://github.com/${repo.owner}/${repo.name}.git`;
  const authedUrl = `https://x-access-token:${token}@github.com/${repo.owner}/${repo.name}.git`;
  const finalize = async (): Promise<void> => {
    await safeAck(() => provider.removeLabel(ackRef, item.number, repo.in_progress_label));
  };

  try {
    // 1. Clone fresh into worktree (token in URL so private repos work)
    await clone({ url: authedUrl, workdir, branch: repo.patch_default_base, depth: 50 });
    await setBotIdentity(workdir);
    const baseSha = await getCurrentSha(workdir);

    // 2. New branch
    await checkoutNewBranch(workdir, branch);

    // 3. Render prompt + run Claude Code worker
    const template = loadTemplate("patch-task", repo, ctx.config.dataDir);
    // If the analyze lane already wrote expanded requirements, prepend them so
    // the implementing agent sees the unambiguous version of the task.
    const analyzeStored = ctx.db
      .prepare("SELECT decision_json FROM tasks WHERE id = ?")
      .get(taskId) as { decision_json: string | null } | undefined;
    let expandedBody = item.body || "(empty body)";
    if (analyzeStored?.decision_json) {
      try {
        const stored = JSON.parse(analyzeStored.decision_json) as {
          lane?: string;
          state?: string;
          summary?: string;
          expanded_requirements?: string;
        };
        if (stored.lane === "analyze" && stored.state === "ready" && stored.expanded_requirements) {
          expandedBody = `${item.body || ""}

---

## Analyst's expanded requirements

**Understanding:** ${stored.summary ?? "(none)"}

${stored.expanded_requirements}`;
        }
      } catch {
        // ignore
      }
    }

    const userPrompt = renderTemplate(template, {
      kind: item.kind === "pull_request" ? "pull request" : "issue",
      repo_full_name: `${repo.owner}/${repo.name}`,
      number: String(item.number),
      title: item.title,
      url: item.url,
      author: item.author,
      author_association: item.authorAssociation,
      labels: item.labels.join(", ") || "(none)",
      body: expandedBody,
      protected_paths: repo.protected_paths.join(", "),
      max_diff_lines: String(repo.max_diff_lines),
      language_for_communication: repo.language_for_communication,
      language_for_commits: repo.language_for_commits,
      language_for_code_identifiers: repo.language_for_code_identifiers,
    });

    const job = await runJob(ctx, {
      jobType: "patch",
      lane: "patch",
      taskId,
      engineOpts: {
        systemPrompt: [
          "You are an implementing developer agent. Make minimal, correct changes and commit when done. Do not push.",
          `Project language rules — these override your defaults:`,
          `  - Write commit messages in ${repo.language_for_commits}.`,
          `  - Write your final response (PR summary) in ${repo.language_for_communication}.`,
          `  - Use ${repo.language_for_code_identifiers} for code identifiers and inline strings.`,
          `Do NOT default to English just because the prompt is framed in English.`,
        ].join("\n"),
        userPrompt,
        workdir,
        tools: "git-write",
        timeoutMs: input.timeoutMs ?? 30 * 60 * 1000,
        maxBudgetUsd: ctx.config.global.cost_caps.per_task_usd,
      },
    });
    const agentSummary = job.result.content || "(agent produced no summary)";

    // 4. Compare HEAD against base — Claude is expected to have committed.
    let headSha = await getCurrentSha(workdir);
    const stats = await diffStats(workdir);

    if (stats.hasChanges) {
      // Worktree dirty — agent forgot to commit some edits. This happens
      // on big features where the agent staged some files but not all.
      // Recovery strategy:
      //   1. Log the outstanding files so a human can audit.
      //   2. If none of them are in protected_paths → wrap them in one
      //      catch-all commit and continue. A noisy PR is better than a
      //      lost session.
      //   3. If any IS in protected_paths → reject (a guardrail file
      //      slipping in is exactly what we want to block).
      console.warn(
        `[patch] dirty workdir for #${item.number} — files: ${stats.filesChanged.join(", ").slice(0, 600)}`,
      );
      const protectedHit = stats.filesChanged.find((f) =>
        repo.protected_paths.some((p) => f === p || f.startsWith(p)),
      );
      if (!protectedHit) {
        try {
          await commitAll(workdir, "[openronin] include leftover edits from previous step");
          // Re-check; should be clean now.
          const after = await diffStats(workdir);
          if (!after.hasChanges) {
            headSha = await getCurrentSha(workdir);
            console.log(
              `[patch] auto-committed leftover edits for #${item.number}: ${stats.filesChanged.length} file(s), HEAD=${headSha.slice(0, 7)}`,
            );
            // Continue lane logic with updated headSha.
            stats.hasChanges = false;
            stats.filesChanged = [];
          }
        } catch (error) {
          console.warn(
            `[patch] auto-commit failed for #${item.number}: ${error instanceof Error ? error.message : error}`,
          );
        }
      }
    }
    if (stats.hasChanges) {
      const detail = `worktree dirty after agent run (${stats.filesChanged.length} files, +${stats.linesAdded} -${stats.linesRemoved}); rejecting.`;
      await safeAck(() => provider.postComment(ackRef, item.number, lang.patch_blocked(detail)));
      await safeAck(() => provider.addLabel(ackRef, item.number, repo.awaiting_action_label));
      await finalize();
      recordPrBranch(ctx.db, {
        taskId,
        branch,
        baseSha,
        headSha,
        status: "dirty",
        lastError: detail,
      });
      recordTaskDecision(
        ctx.db,
        taskId,
        headSha.slice(0, 16),
        JSON.stringify({ lane: "patch", outcome: "guardrail_blocked", detail }),
      );
      return {
        outcome: "guardrail_blocked",
        taskId,
        branch,
        baseSha,
        headSha,
        diffStats: stats,
        detail,
        agentSummary,
        runId: job.runId,
      };
    }

    if (headSha === baseSha) {
      const detail = "agent made no commits";
      await safeAck(() => provider.postComment(ackRef, item.number, lang.patch_failed(detail)));
      await safeAck(() => provider.addLabel(ackRef, item.number, repo.awaiting_action_label));
      await finalize();
      recordPrBranch(ctx.db, { taskId, branch, baseSha, headSha, status: "no_changes" });
      recordTaskDecision(
        ctx.db,
        taskId,
        baseSha.slice(0, 16),
        JSON.stringify({ lane: "patch", outcome: "no_changes", detail }),
      );
      return {
        outcome: "no_changes",
        taskId,
        branch,
        baseSha,
        headSha,
        detail,
        agentSummary,
        runId: job.runId,
      };
    }

    // 5. Guardrails on the committed diff
    const committedStats = await committedDiffStats(workdir, baseSha);
    const blocked = checkGuardrails(committedStats, repo.protected_paths, repo.max_diff_lines);
    if (blocked) {
      await safeAck(() => provider.postComment(ackRef, item.number, lang.patch_blocked(blocked)));
      await safeAck(() => provider.addLabel(ackRef, item.number, repo.awaiting_action_label));
      await finalize();
      recordPrBranch(ctx.db, {
        taskId,
        branch,
        baseSha,
        headSha,
        status: "guardrail_blocked",
        lastError: blocked,
      });
      recordTaskDecision(
        ctx.db,
        taskId,
        headSha.slice(0, 16),
        JSON.stringify({ lane: "patch", outcome: "guardrail_blocked", detail: blocked }),
      );
      return {
        outcome: "guardrail_blocked",
        taskId,
        branch,
        baseSha,
        headSha,
        diffStats: committedStats,
        detail: blocked,
        agentSummary,
        runId: job.runId,
      };
    }

    // 6. Push
    await pushBranchWithToken(workdir, remoteUrl, branch, token);

    // 7. Open PR
    const octokit = new Octokit({ auth: token, userAgent: "openronin/0.0.1" });
    const prTitle = `[openronin] ${item.title}`.slice(0, 200);
    const prBody = renderPrBody(item, agentSummary, committedStats);
    const created = await octokit.pulls.create({
      owner: repo.owner,
      repo: repo.name,
      head: branch,
      base: repo.patch_default_base,
      title: prTitle,
      body: prBody,
      draft: repo.draft_pr,
    });
    const prNumber = created.data.number;
    const prUrl = created.data.html_url;

    recordPrBranch(ctx.db, {
      taskId,
      branch,
      baseSha,
      headSha,
      prNumber,
      prUrl,
      status: "open",
    });
    recordTaskDecision(
      ctx.db,
      taskId,
      headSha.slice(0, 16),
      JSON.stringify({ lane: "patch", outcome: "pr_opened", prNumber, prUrl }),
    );

    // Acknowledge completion on the source issue: comment with PR link, drop
    // the in-progress AND trigger label so a webhook event on this issue
    // doesn't re-trigger the patch lane.
    if (repo.acknowledge_with_comment) {
      await safeAck(() => provider.postComment(ackRef, item.number, lang.pr_opened(prNumber)));
    }
    await safeAck(() => provider.removeLabel(ackRef, item.number, repo.patch_trigger_label));
    await safeAck(() => provider.removeLabel(ackRef, item.number, repo.awaiting_answer_label));
    await safeAck(() => provider.removeLabel(ackRef, item.number, repo.awaiting_action_label));
    await finalize();

    return {
      outcome: "pr_opened",
      taskId,
      branch,
      baseSha,
      headSha,
      prNumber,
      prUrl,
      diffStats: committedStats,
      detail: `PR #${prNumber} opened`,
      agentSummary,
      runId: job.runId,
    };
  } catch (error) {
    const detail = scrubSecrets(error instanceof Error ? error.message : String(error));
    recordPrBranch(ctx.db, { taskId, branch, status: "error" });
    await safeAck(() => provider.postComment(ackRef, item.number, lang.patch_failed(detail)));
    await finalize();
    return { outcome: "error", taskId, branch, detail };
  } finally {
    cleanupWorkdir(workdir);
  }
}

// Acks should never break the lane. Log + swallow.
async function safeAck(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    console.warn("[patch] ack failed:", error instanceof Error ? error.message : error);
  }
}

function checkGuardrails(
  stats: DiffStats,
  protectedPaths: string[],
  maxDiffLines: number,
): string | undefined {
  const total = stats.linesAdded + stats.linesRemoved;
  if (total > maxDiffLines) {
    return `diff too large: ${total} lines > max ${maxDiffLines}`;
  }
  for (const file of stats.filesChanged) {
    for (const protectedPath of protectedPaths) {
      if (file === protectedPath || file.startsWith(protectedPath)) {
        return `touches protected path: ${file} (matched ${protectedPath})`;
      }
    }
  }
  return undefined;
}

async function committedDiffStats(workdir: string, baseSha: string): Promise<DiffStats> {
  const { runGitChecked } = await import("../lib/git.js");
  const filesRaw = await runGitChecked(workdir, ["diff", "--name-only", baseSha, "HEAD"]);
  const files = filesRaw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const numstat = await runGitChecked(workdir, ["diff", "--numstat", baseSha, "HEAD"]);
  let added = 0;
  let removed = 0;
  for (const line of numstat.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2) {
      const a = Number(parts[0]);
      const r = Number(parts[1]);
      if (!Number.isNaN(a)) added += a;
      if (!Number.isNaN(r)) removed += r;
    }
  }
  return {
    hasChanges: files.length > 0,
    filesChanged: files,
    linesAdded: added,
    linesRemoved: removed,
  };
}

function renderPrBody(item: VcsItem, summary: string, stats: DiffStats): string {
  return `🤖 openronin: автоматический PR.

Closes #${item.number}.

This PR was opened automatically by [openronin](https://github.com/openronin/openronin) in response to issue #${item.number}.

## Agent summary

${summary}

## Diff stats

- Files changed: ${stats.filesChanged.length}
- Lines: +${stats.linesAdded} / -${stats.linesRemoved}

---
*Marked as draft for human review. The agent (claude_code) wrote this; please review before merging.*`;
}

// Used for tests / debugging — keep alongside.
export function _readWorkdirFile(workdir: string, path: string): string | undefined {
  const full = `${workdir}/${path}`;
  return existsSync(full) ? readFileSync(full, "utf8") : undefined;
}
