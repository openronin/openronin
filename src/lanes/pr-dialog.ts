import { Octokit } from "@octokit/rest";
import type { VcsItem, ReviewComment } from "../providers/vcs.js";
import { GithubVcsProvider } from "../providers/github.js";
import { loadTemplate, renderTemplate } from "../prompts/registry.js";
import { runJob, type SupervisorContext } from "../supervisor/index.js";
import { ensureRepo, recordTaskDecision, upsertTask } from "../storage/tasks.js";
import { bumpIteration, getPrBranchByPrNumber, recordPrBranch } from "../storage/pr-branches.js";
import { isBotMessage, pick, BOT_PREFIX } from "./messages.js";
import { parseSqliteUtc } from "../lib/time.js";
import { attemptRebaseResolve } from "./conflict-resolve.js";
import { bumpConflictResolutions, updateBranchHeadSha } from "../storage/pr-branches.js";
import { z } from "zod";
import {
  cleanupWorkdir,
  clone,
  commitAll,
  diffStats,
  getCurrentSha,
  pushBranchWithToken,
  runGitChecked,
  setBotIdentity,
  workdirFor,
  type DiffStats,
} from "../lib/git.js";

export type PrDialogOutcome =
  | "pushed"
  | "no_new_feedback"
  | "no_changes"
  | "guardrail_blocked"
  | "max_iterations"
  | "needs_human"
  | "error";

export interface PrDialogResult {
  outcome: PrDialogOutcome;
  taskId: number;
  branch: string;
  prNumber: number;
  iteration: number;
  detail?: string;
  agentSummary?: string;
  diffStats?: DiffStats;
  runId?: number;
}

export interface PrDialogInput {
  ctx: SupervisorContext;
  item: VcsItem;
  timeoutMs?: number;
}

export async function runPrDialog(input: PrDialogInput): Promise<PrDialogResult> {
  const { ctx, item } = input;
  const repo = ctx.repo;

  if (!repo.lanes.includes("pr_dialog")) {
    return {
      outcome: "error",
      taskId: -1,
      branch: "",
      prNumber: item.number,
      iteration: 0,
      detail: "pr_dialog lane not enabled",
    };
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token)
    return {
      outcome: "error",
      taskId: -1,
      branch: "",
      prNumber: item.number,
      iteration: 0,
      detail: "GITHUB_TOKEN not set",
    };

  const repoId = ensureRepo(ctx.db, {
    provider: repo.provider,
    owner: repo.owner,
    name: repo.name,
  });
  const taskId = upsertTask(ctx.db, repoId, String(item.number), item.kind);

  // pr_branches was created against the SOURCE ISSUE's task — look it up by PR number scoped to this repo.
  const prRow = getPrBranchByPrNumber(ctx.db, repoId, item.number);
  if (!prRow) {
    return {
      outcome: "error",
      taskId,
      branch: "",
      prNumber: item.number,
      iteration: 0,
      detail: "no pr_branches row — this PR was not opened by openronin",
    };
  }
  if (prRow.iterations >= repo.pr_dialog_max_iterations) {
    return {
      outcome: "max_iterations",
      taskId,
      branch: prRow.branch,
      prNumber: item.number,
      iteration: prRow.iterations,
      detail: `max iterations reached (${prRow.iterations}/${repo.pr_dialog_max_iterations}) — needs human`,
    };
  }

  const branch = prRow.branch;
  const lang = pick(repo.language_for_communication);
  const workdir = workdirFor(
    ctx.config.dataDir,
    `${repo.provider}__${repo.owner}`,
    repo.name,
    taskId,
  );
  const remoteUrl = `https://github.com/${repo.owner}/${repo.name}.git`;
  const authedUrl = `https://x-access-token:${token}@github.com/${repo.owner}/${repo.name}.git`;
  const provider = new GithubVcsProvider();

  try {
    // 1. Pull all PR feedback and filter to "since last iteration".
    // We use prRow.updated_at as the cutoff; everything strictly after it is "new".
    const since = prRow.updated_at ?? prRow.created_at;
    const allFeedback = await provider.listAllPrFeedback(
      { owner: repo.owner, name: repo.name },
      item.number,
    );
    const newFeedback = allFeedback.filter(
      (c) =>
        new Date(c.createdAt).getTime() > parseSqliteUtc(since).getTime() &&
        !repo.pr_dialog_skip_authors.includes(c.author) &&
        !isBotMessage(c.body),
    );
    if (newFeedback.length === 0) {
      // Even without new feedback, give auto-merge a chance: an earlier iteration
      // may have left the PR in a 'CI still running' state that has since gone green.
      let mergeNote = "";
      if (repo.auto_merge.enabled) {
        const previousSummary = decisionSummary(prRow.task_id, ctx) ?? "";
        mergeNote = await tryAutoMerge({
          ctx,
          item,
          prBranch: prRow,
          provider,
          workdir,
          remoteUrl,
          authedUrl,
          token,
          taskId,
          workdirReady: false,
          previousSummary,
        });
      }
      return {
        outcome: "no_new_feedback",
        taskId,
        branch,
        prNumber: item.number,
        iteration: prRow.iterations,
        detail: mergeNote
          ? `nothing new since ${since}; ${mergeNote.replace(/^🤖 openronin:\s*/, "")}`
          : `nothing new since ${since}`,
      };
    }

    // -- Visible acknowledgment on each piece of new feedback. --
    const ackRef = { owner: repo.owner, name: repo.name };
    for (const c of newFeedback) {
      await safeAck(async () => {
        if (c.source === "issue_comment") {
          await provider.addReactionToComment(ackRef, Number(c.id), "eyes");
        } else if (c.source === "review_comment") {
          await provider.addReactionToReviewComment(ackRef, Number(c.id), "eyes");
        }
      });
    }

    // 2. Clone the PR branch into a fresh worktree.
    await clone({ url: authedUrl, workdir, branch, depth: 50 });
    await setBotIdentity(workdir);
    const baseSha = await getCurrentSha(workdir);

    // 3. Render dialog prompt.
    const previousSummary = decisionSummary(prRow.task_id, ctx) ?? "(no previous summary)";
    const template = loadTemplate("pr-dialog", repo, ctx.config.dataDir);
    const userPrompt = renderTemplate(template, {
      kind: item.kind === "pull_request" ? "pull request" : "issue",
      repo_full_name: `${repo.owner}/${repo.name}`,
      pr_number: String(item.number),
      number: String(item.number),
      title: item.title,
      body: item.body || "(empty body)",
      branch,
      iteration: String(prRow.iterations + 1),
      max_iterations: String(repo.pr_dialog_max_iterations),
      previous_summary: previousSummary,
      review_feedback: formatFeedback(newFeedback),
      protected_paths: repo.protected_paths.join(", "),
      max_diff_lines: String(repo.max_diff_lines),
      language_for_communication: repo.language_for_communication,
      language_for_commits: repo.language_for_commits,
      language_for_code_identifiers: repo.language_for_code_identifiers,
    });

    // 4. Run Claude Code worker on this branch.
    const job = await runJob(ctx, {
      jobType: "pr_dialog",
      lane: "pr_dialog",
      taskId,
      engineOpts: {
        systemPrompt: [
          "You are addressing reviewer feedback on a PR you opened earlier. Stay on this branch. Make minimal, correct changes and commit. Do not push.",
          `Project language rules — these override your defaults:`,
          `  - Write commit messages in ${repo.language_for_commits}.`,
          `  - Write your final response (iteration summary) in ${repo.language_for_communication}.`,
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

    // 5. Validate worktree + new commits.
    const headSha = await getCurrentSha(workdir);
    const dirty = await diffStats(workdir);
    if (dirty.hasChanges) {
      const detail = `worktree dirty after agent run (${dirty.filesChanged.length} files, +${dirty.linesAdded} -${dirty.linesRemoved}); rejecting.`;
      // Don't bump the iteration counter — this isn't a real round; nothing changed
      // in the PR. Only successful pushes count toward the budget.
      recordPrBranch(ctx.db, {
        taskId,
        branch,
        baseSha: prRow.base_sha ?? undefined,
        headSha,
        prNumber: item.number,
        prUrl: prRow.pr_url ?? undefined,
        status: "dirty",
      });
      return {
        outcome: "guardrail_blocked",
        taskId,
        branch,
        prNumber: item.number,
        iteration: prRow.iterations + 1,
        diffStats: dirty,
        detail,
        agentSummary,
        runId: job.runId,
      };
    }

    if (headSha === baseSha) {
      // Agent declined to commit — usually means push-back. Mark needs_human.
      // Don't burn an iteration: the user might add clarifying feedback and
      // we should still be able to engage. Only successful pushes count.
      recordPrBranch(ctx.db, {
        taskId: prRow.task_id,
        branch,
        baseSha: prRow.base_sha ?? undefined,
        headSha,
        prNumber: item.number,
        prUrl: prRow.pr_url ?? undefined,
        status: "needs_human",
      });
      // Post the agent's explanation to the PR so the human can read it.
      await postPrComment(
        token,
        repo.owner,
        repo.name,
        item.number,
        lang.no_action_needed(agentSummary),
      );
      recordTaskDecision(
        ctx.db,
        taskId,
        baseSha.slice(0, 16),
        JSON.stringify({
          lane: "pr_dialog",
          outcome: "needs_human",
          iteration: prRow.iterations + 1,
        }),
      );
      return {
        outcome: "needs_human",
        taskId,
        branch,
        prNumber: item.number,
        iteration: prRow.iterations + 1,
        detail: "agent did not commit; explanation posted to PR",
        agentSummary,
        runId: job.runId,
      };
    }

    // 6. Guardrails on the new commits only.
    const newStats = await committedDiffStats(workdir, baseSha);
    const blocked = checkGuardrails(newStats, repo.protected_paths, repo.max_diff_lines);
    if (blocked) {
      // Guardrail rejection doesn't burn an iteration either — nothing was pushed.
      recordPrBranch(ctx.db, {
        taskId: prRow.task_id,
        branch,
        baseSha: prRow.base_sha ?? undefined,
        headSha,
        prNumber: item.number,
        prUrl: prRow.pr_url ?? undefined,
        status: "guardrail_blocked",
      });
      await postPrComment(
        token,
        repo.owner,
        repo.name,
        item.number,
        lang.iteration_blocked(blocked),
      );
      return {
        outcome: "guardrail_blocked",
        taskId,
        branch,
        prNumber: item.number,
        iteration: prRow.iterations + 1,
        diffStats: newStats,
        detail: blocked,
        agentSummary,
        runId: job.runId,
      };
    }

    // 7. Push (no force needed — we only added commits).
    await pushBranchWithToken(workdir, remoteUrl, branch, token);
    bumpIteration(ctx.db, prRow.id);
    recordPrBranch(ctx.db, {
      taskId: prRow.task_id,
      branch,
      baseSha: prRow.base_sha ?? undefined,
      headSha,
      prNumber: item.number,
      prUrl: prRow.pr_url ?? undefined,
      status: "open",
    });

    // 8a. Parse the agent's per-comment replies, post each as a thread reply,
    //     react with +1 / resolve threads only for replies marked 'addressed'.
    const replies = parseAgentReplies(agentSummary);
    const feedbackById = new Map(newFeedback.map((c) => [String(c.id), c] as const));
    const addressedReviewCommentIds: number[] = [];
    for (const r of replies) {
      const original = feedbackById.get(String(r.comment_id));
      if (!original) continue; // unknown id — skip
      const replyBody = `${BOT_PREFIX} ${r.body}`;
      try {
        if (original.source === "review_comment") {
          await provider.replyToReviewComment(ackRef, item.number, Number(original.id), replyBody);
        } else {
          // issue_comment / review summaries: no native threading. Post a quoted reply.
          const quote = original.body
            .split("\n")
            .slice(0, 4)
            .map((l) => `> ${l}`)
            .join("\n");
          await provider.postComment(
            ackRef,
            item.number,
            `${BOT_PREFIX} в ответ на @${original.author}:\n${quote}\n\n${r.body}`,
          );
        }
      } catch (error) {
        console.warn("[pr-dialog] reply failed:", error instanceof Error ? error.message : error);
      }
      const reactContent = r.kind === "addressed" ? "+1" : "eyes";
      await safeAck(async () => {
        if (original.source === "issue_comment") {
          await provider.addReactionToComment(ackRef, Number(original.id), reactContent);
        } else if (original.source === "review_comment") {
          await provider.addReactionToReviewComment(ackRef, Number(original.id), reactContent);
          if (r.kind === "addressed") addressedReviewCommentIds.push(Number(original.id));
        }
      });
    }

    // For any feedback items the agent did NOT mention in replies, still react 👀
    // so the human sees the agent at least saw the comment.
    const mentionedIds = new Set(replies.map((r) => String(r.comment_id)));
    for (const c of newFeedback) {
      if (mentionedIds.has(String(c.id))) continue;
      await safeAck(async () => {
        if (c.source === "issue_comment")
          await provider.addReactionToComment(ackRef, Number(c.id), "eyes");
        else if (c.source === "review_comment")
          await provider.addReactionToReviewComment(ackRef, Number(c.id), "eyes");
      });
    }

    // Resolve only the threads we actually addressed (not questions / pushback).
    if (addressedReviewCommentIds.length > 0) {
      await safeAck(async () => {
        const n = await provider.resolveReviewThreadsForComments(
          ackRef,
          item.number,
          addressedReviewCommentIds,
        );
        if (n > 0) console.log(`[pr-dialog] resolved ${n} review thread(s) on PR #${item.number}`);
      });
    }

    // Use the agent's structured summary if it provided one; else fall back to the raw text.
    const overallSummary = parseAgentSummary(agentSummary) ?? agentSummary;

    // 8b. Auto-merge gate (opt-in per repo). Only attempts when:
    //   - this iteration was a successful push
    //   - the agent has no open questions / pushback in its replies
    //   - PR is mergeable, no unresolved threads, CI green (per config)
    let autoMergeNote = "";
    if (
      repo.auto_merge.enabled &&
      replies.length > 0 &&
      replies.every((r) => r.kind === "addressed")
    ) {
      autoMergeNote = await tryAutoMerge({
        ctx,
        item,
        prBranch: prRow,
        provider,
        workdir,
        remoteUrl,
        authedUrl,
        token,
        taskId,
        workdirReady: true,
        previousSummary: agentSummary || "",
      });
    }

    // 8c. Post a comment on the PR summarising what changed in this iteration.
    await postPrComment(
      token,
      repo.owner,
      repo.name,
      item.number,
      lang.iteration_pushed(
        prRow.iterations + 1,
        overallSummary,
        newStats.filesChanged.length,
        newStats.linesAdded,
        newStats.linesRemoved,
      ) + (autoMergeNote ? `\n\n---\n\n${autoMergeNote}` : ""),
    );

    recordTaskDecision(
      ctx.db,
      taskId,
      headSha.slice(0, 16),
      JSON.stringify({
        lane: "pr_dialog",
        outcome: "pushed",
        iteration: prRow.iterations + 1,
        prNumber: item.number,
      }),
    );

    return {
      outcome: "pushed",
      taskId,
      branch,
      prNumber: item.number,
      iteration: prRow.iterations + 1,
      diffStats: newStats,
      detail: `iteration ${prRow.iterations + 1} pushed`,
      agentSummary,
      runId: job.runId,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      outcome: "error",
      taskId,
      branch,
      prNumber: item.number,
      iteration: prRow.iterations,
      detail,
    };
  } finally {
    cleanupWorkdir(workdir);
  }
}

function checkGuardrails(
  stats: DiffStats,
  protectedPaths: string[],
  maxDiffLines: number,
): string | undefined {
  const total = stats.linesAdded + stats.linesRemoved;
  if (total > maxDiffLines) {
    return `iteration diff too large: ${total} lines > max ${maxDiffLines}`;
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

function formatFeedback(feedback: ReviewComment[]): string {
  return feedback
    .map((c) => {
      const where = c.path ? ` on \`${c.path}${c.line ? ":" + c.line : ""}\`` : "";
      const state = c.reviewState ? ` (state: ${c.reviewState})` : "";
      return `### comment_id: ${c.id} · source: ${c.source}\n**${c.author}**${state}${where} — ${c.createdAt}\n\n${c.body || "_(no body)_"}`;
    })
    .join("\n\n---\n\n");
}

// Iteration / needs-human / blocked comments are now built from messages.ts
// using the repo's language_for_communication and the BOT_PREFIX so the
// feedback filter (isBotMessage) reliably catches them.

async function postPrComment(
  token: string,
  owner: string,
  repoName: string,
  prNumber: number,
  body: string,
): Promise<void> {
  const octokit = new Octokit({ auth: token, userAgent: "openronin/0.0.1" });
  await octokit.issues.createComment({ owner, repo: repoName, issue_number: prNumber, body });
}

function decisionSummary(_taskId: number, _ctx: SupervisorContext): string | undefined {
  // Placeholder — could pull from tasks.decision_json. Keeping it simple.
  return undefined;
}

// Force-push helper kept here in case future logic needs to rewrite history.
// Not used in the additive flow; commit-and-fast-forward is enough.
export async function forcePushBranch(
  workdir: string,
  remoteUrl: string,
  branch: string,
  token: string,
): Promise<void> {
  const auth = remoteUrl.replace(/^https:\/\//, `https://x-access-token:${token}@`);
  await runGitChecked(workdir, ["push", "--force-with-lease", auth, `${branch}:${branch}`]);
}

// Re-export so tests can patch.
export const _internal = { commitAll };

// Auto-merge context. Constructed at each call site so the function has
// everything it needs to (a) check GitHub state and (b) attempt a rebase
// to resolve conflicts.
interface AutoMergeArgs {
  ctx: SupervisorContext;
  item: VcsItem;
  prBranch: import("../storage/pr-branches.js").PrBranchRow;
  provider: GithubVcsProvider;
  workdir: string;
  remoteUrl: string;
  authedUrl: string;
  token: string;
  workdirReady: boolean;
  previousSummary: string;
  taskId: number;
}

// Attempt auto-merge. Returns a short note describing what happened, posted
// as a comment by the caller (or empty string if config is disabled/no-op).
async function tryAutoMerge(args: AutoMergeArgs): Promise<string> {
  const { ctx, item, prBranch, provider } = args;
  const repo = ctx.repo;
  const lang = pick(repo.language_for_communication);
  const repoRef = { owner: repo.owner, name: repo.name };
  const prBranchId = prBranch.id;

  let pr;
  // Tracks whether this auto-merge invocation just performed a force-push
  // via conflict resolution. If so, the post-rebase CI check has to be
  // more cautious: GitHub may not have scheduled the workflow yet, and we
  // mustn't merge while CI is in 'no_checks' limbo.
  let justRebased = false;
  try {
    pr = await provider.getPullRequest(repoRef, item.number);
  } catch (error) {
    return lang.auto_merge_blocked(
      `не удалось получить состояние PR: ${error instanceof Error ? error.message : error}`,
    );
  }

  if (pr.state === "closed") return ""; // already done

  if (pr.draft && repo.auto_merge.unblock_draft) {
    try {
      await provider.markReadyForReview(repoRef, item.number);
    } catch (error) {
      return lang.auto_merge_blocked(
        `не удалось снять draft: ${error instanceof Error ? error.message : error}`,
      );
    }
  } else if (pr.draft) {
    return lang.auto_merge_blocked("PR в draft и unblock_draft=false");
  }

  // GitHub computes mergeable async; null means 'still computing'. Wait once.
  if (pr.mergeable === null) {
    await new Promise((res) => setTimeout(res, 2000));
    try {
      pr = await provider.getPullRequest(repoRef, item.number);
    } catch {
      // ignore — fall through with stale data
    }
  }
  if (pr.mergeable === false) {
    // ---- Try to auto-resolve conflicts via rebase + agent ---------------
    if (!repo.auto_merge.resolve_conflicts) {
      return lang.auto_merge_blocked("обнаружены конфликты слияния");
    }
    if (prBranch.conflict_resolutions_count >= repo.auto_merge.resolve_conflicts_max_attempts) {
      return lang.conflict_resolve_capped(repo.auto_merge.resolve_conflicts_max_attempts);
    }
    const baseRef = pr.baseRef ?? repo.patch_default_base ?? "main";

    // Acknowledge in the PR thread before we burn engine time.
    try {
      await provider.postComment(repoRef, item.number, lang.conflict_resolve_started(baseRef));
    } catch {
      // best-effort — non-fatal
    }

    const resolveResult = await attemptRebaseResolve({
      ctx,
      item,
      branch: prBranch.branch,
      baseRef,
      workdir: args.workdir,
      remoteUrl: args.remoteUrl,
      authedUrl: args.authedUrl,
      token: args.token,
      taskId: args.taskId,
      workdirReady: args.workdirReady,
      previousSummary: args.previousSummary,
    });
    // Only count attempts that actually engaged the agent. A "no_conflicts"
    // result means GitHub's mergeable signal was stale — no resolution
    // happened, so don't burn one of the budgeted attempts.
    if (resolveResult.outcome !== "no_conflicts") {
      bumpConflictResolutions(ctx.db, prBranchId);
    }
    console.log(
      `[conflict-resolve] PR #${item.number}: outcome=${resolveResult.outcome}` +
        (resolveResult.detail ? ` detail="${resolveResult.detail.slice(0, 600)}"` : "") +
        ` files=${resolveResult.resolvedFiles.length}` +
        (resolveResult.newHeadSha ? ` newSha=${resolveResult.newHeadSha.slice(0, 7)}` : ""),
    );

    if (resolveResult.outcome === "rebased") {
      justRebased = true;
      if (resolveResult.newHeadSha) {
        updateBranchHeadSha(ctx.db, prBranchId, resolveResult.newHeadSha);
      }
      // Post a per-PR audit trail of what we changed.
      try {
        const fileList =
          resolveResult.resolvedFiles.length > 0
            ? "\n\n**Затронутые файлы:**\n" +
              resolveResult.resolvedFiles.map((f) => `- \`${f}\``).join("\n")
            : "";
        const summary = resolveResult.agentSummary
          ? `\n\n**Что сделал агент:**\n${resolveResult.agentSummary.slice(0, 1500)}`
          : "";
        await provider.postComment(
          repoRef,
          item.number,
          lang.conflict_resolve_succeeded(
            resolveResult.resolvedFiles.length,
            resolveResult.newHeadSha ?? pr.headSha,
          ) +
            fileList +
            summary,
        );
      } catch {
        // best-effort
      }
      // Refetch PR state. GitHub needs a moment to recompute mergeable
      // after our force-push.
      await new Promise((res) => setTimeout(res, 3000));
      try {
        pr = await provider.getPullRequest(repoRef, item.number);
      } catch {
        return lang.auto_merge_blocked("после rebase не удалось перезапросить состояние PR");
      }
      if (pr.mergeable === null) {
        await new Promise((res) => setTimeout(res, 3000));
        try {
          pr = await provider.getPullRequest(repoRef, item.number);
        } catch {
          // proceed with stale data
        }
      }
      if (pr.mergeable === false) {
        return lang.conflict_resolve_failed("после rebase GitHub всё ещё считает PR неmergeable");
      }
      // Fall through to the rest of the gate (threads, CI, merge).
    } else if (resolveResult.outcome === "no_conflicts") {
      // GitHub had stale data — refresh and continue.
      try {
        pr = await provider.getPullRequest(repoRef, item.number);
      } catch {
        // proceed with stale data
      }
    } else {
      const detail = resolveResult.detail ?? `outcome=${resolveResult.outcome}`;
      const failMsg = lang.conflict_resolve_failed(detail);
      // Post the failure as a PR comment so the audit trail is complete —
      // the no_new_feedback caller doesn't surface mergeNote to GitHub.
      try {
        await provider.postComment(repoRef, item.number, failMsg);
      } catch {
        // best-effort
      }
      return failMsg;
    }
  }

  let unresolved = 0;
  try {
    unresolved = await provider.getUnresolvedThreadCount(repoRef, item.number);
  } catch {
    // best-effort
  }
  if (unresolved > 0) {
    return lang.auto_merge_blocked(`на PR ${unresolved} нерезолвед thread'ов`);
  }

  if (repo.auto_merge.require_checks_pass) {
    let combined = "no_checks";
    try {
      combined = await provider.getCombinedStatus(repoRef, pr.headSha);
    } catch {
      // best-effort
    }
    // If we *just* force-pushed (post-conflict-resolve), GitHub may not have
    // scheduled the CI run yet — getCombinedStatus would return "no_checks".
    // Treat that as pending and bail; the next reconcile cycle (after CI
    // had time to register) will re-evaluate. This prevents merging code
    // that hasn't been re-tested after our rebase.
    if (justRebased && combined === "no_checks") {
      // Brief poll so we don't always punt to the next reconcile cycle when
      // CI just needs a few seconds to enqueue.
      for (let i = 0; i < 6 && combined === "no_checks"; i++) {
        await new Promise((res) => setTimeout(res, 5000));
        try {
          combined = await provider.getCombinedStatus(repoRef, pr.headSha);
        } catch {
          // ignore — will fall through
        }
      }
      if (combined === "no_checks") {
        return lang.auto_merge_blocked("CI ещё не запущен после rebase — попробую позже");
      }
    }
    if (combined === "pending") return lang.auto_merge_blocked("CI ещё выполняется");
    if (combined === "failure" || combined === "error") {
      return lang.auto_merge_blocked("CI завершился с ошибкой");
    }
    // 'success' or remaining 'no_checks' (no workflows configured) proceed
  }

  try {
    const result = await provider.mergePullRequest(repoRef, item.number, repo.auto_merge.strategy);
    if (!result.merged) {
      return lang.auto_merge_blocked("GitHub отказал в мердже");
    }
    ctx.db
      .prepare("UPDATE pr_branches SET status = ?, updated_at = datetime('now') WHERE id = ?")
      .run("closed", prBranchId);
    return lang.auto_merged(repo.auto_merge.strategy, result.sha ?? pr.headSha);
  } catch (error) {
    return lang.auto_merge_blocked(`merge API: ${error instanceof Error ? error.message : error}`);
  }
}

async function safeAck(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    console.warn("[pr-dialog] ack failed:", error instanceof Error ? error.message : error);
  }
}

const ReplySchema = z.object({
  comment_id: z.union([z.string(), z.number()]).transform((v) => String(v)),
  kind: z.enum(["addressed", "question", "pushback"]),
  body: z.string(),
});
const RepliesPayloadSchema = z.object({
  replies: z.array(ReplySchema).default([]),
  summary: z.string().optional(),
});

type Reply = z.infer<typeof ReplySchema>;

// Pull the fenced ```openronin-replies block out of the agent's response.
// Returns an empty array when the block is missing or invalid (older runs / agent
// that didn't follow the schema).
function parseAgentReplies(text: string): Reply[] {
  const block = extractFenced(text);
  if (!block) return [];
  try {
    const parsed = RepliesPayloadSchema.parse(JSON.parse(block));
    return parsed.replies;
  } catch {
    return [];
  }
}

function parseAgentSummary(text: string): string | undefined {
  const block = extractFenced(text);
  if (!block) return undefined;
  try {
    const parsed = RepliesPayloadSchema.parse(JSON.parse(block));
    return parsed.summary;
  } catch {
    return undefined;
  }
}

function extractFenced(text: string): string | undefined {
  const m = text.match(/```openronin-replies\s*\n([\s\S]*?)\n```/);
  return m?.[1];
}
