// Conflict resolution lane.
//
// When auto-merge finds a PR with mergeable=false, instead of bailing we
// optionally call into here. The flow is:
//
//   1. Set up a workdir on the PR branch (cloning if necessary).
//   2. Fetch the base ref and start a rebase onto it.
//   3. If the rebase hits conflicts, hand the conflicted files to Claude
//      Code with a tightly-scoped system prompt: "edit files in place to
//      remove markers; do not commit, do not run git". Then validate the
//      files no longer contain markers, `git add` them, and continue the
//      rebase.
//   4. Loop until the rebase finishes or we exhaust a cap.
//   5. Force-push (with-lease) the rebased branch.
//
// All side effects on GitHub (comments, force-push) happen in the caller —
// this module is pure git + agent. That keeps the unit testable and the
// security review small.

import type { VcsItem } from "../providers/vcs.js";
import { runJob, type SupervisorContext } from "../supervisor/index.js";
import { loadTemplate, renderTemplate } from "../prompts/registry.js";
import {
  addPaths,
  clone,
  cleanupWorkdir,
  continueRebase,
  fetchRef,
  fileHasConflictMarkers,
  forcePushWithLease,
  getCurrentSha,
  rebaseAbort,
  rebaseInProgress,
  setBotIdentity,
  startRebaseOnto,
  syncToRemoteBranch,
} from "../lib/git.js";
import { existsSync } from "node:fs";

export type ConflictResolveOutcome =
  | "rebased" // success — branch force-pushed
  | "no_conflicts" // rebase was clean, nothing to do
  | "agent_failed" // engine call errored
  | "still_conflicted" // agent left markers in some file
  | "push_failed" // force-push rejected
  | "rebase_aborted" // rebase failed for non-conflict reasons
  | "max_attempts" // exceeded resolve_conflicts_max_attempts
  | "config_disabled" // auto_merge.resolve_conflicts=false
  | "error"; // unexpected

export interface ConflictResolveResult {
  outcome: ConflictResolveOutcome;
  detail?: string;
  resolvedFiles: string[];
  newHeadSha?: string;
  agentSummary?: string;
  runIds: number[];
}

export interface ConflictResolveInput {
  ctx: SupervisorContext;
  item: VcsItem; // the PR
  branch: string;
  baseRef: string; // e.g. "main"
  workdir: string;
  remoteUrl: string;
  authedUrl: string;
  token: string;
  taskId: number; // for runs accounting
  // If pr_dialog already cloned the workdir for this run we can skip the
  // clone step. Set to true in the new-feedback path; false in the
  // no-new-feedback path.
  workdirReady: boolean;
  previousSummary: string;
  // Hard cap on rebase-pause iterations within a single attempt. Different
  // from resolve_conflicts_max_attempts (which counts attempts ACROSS
  // pr_dialog runs).
  maxRebaseSteps?: number;
}

const DEFAULT_MAX_REBASE_STEPS = 8;

export async function attemptRebaseResolve(
  input: ConflictResolveInput,
): Promise<ConflictResolveResult> {
  const {
    ctx,
    item,
    branch,
    baseRef,
    workdir,
    remoteUrl,
    authedUrl,
    token,
    taskId,
    workdirReady,
    previousSummary,
  } = input;
  const repo = ctx.repo;
  const maxRebaseSteps = input.maxRebaseSteps ?? DEFAULT_MAX_REBASE_STEPS;
  const runIds: number[] = [];
  const resolvedFiles: string[] = [];
  let agentSummary = "";

  // -- 1. Workdir set-up ---------------------------------------------------
  try {
    if (!workdirReady || !existsSync(workdir)) {
      // Fresh clone of the PR branch.
      await clone({ url: authedUrl, workdir, branch, depth: 100 });
      await setBotIdentity(workdir);
    } else if (rebaseInProgress(workdir)) {
      // Defensive: a previous run aborted mid-rebase and didn't clean up.
      // Get back to a sane state before we start fresh.
      await rebaseAbort(workdir);
    }
  } catch (error) {
    return {
      outcome: "error",
      detail: `workdir setup failed: ${errMsg(error)}`,
      resolvedFiles,
      runIds,
    };
  }

  // -- 2. Fetch base + branch and align local to remote --------------------
  let preRebaseRemoteSha: string;
  try {
    await fetchRef(workdir, baseRef);
    await fetchRef(workdir, branch);
    await syncToRemoteBranch(workdir, branch);
    preRebaseRemoteSha = await getCurrentSha(workdir);
  } catch (error) {
    return {
      outcome: "error",
      detail: `fetch/sync failed: ${errMsg(error)}`,
      resolvedFiles,
      runIds,
    };
  }

  // -- 3. Loop: try rebase, ask agent on conflict, continue ----------------
  let step = await startRebaseOnto(workdir, `origin/${baseRef}`);
  if (step.ok) {
    // Nothing to do. Could happen if mergeable=false was a stale GitHub
    // signal that resolved itself — return the no-op outcome so the caller
    // re-checks PR state instead of force-pushing identical commits.
    return { outcome: "no_conflicts", resolvedFiles, runIds };
  }
  if (!step.conflictedFiles) {
    return {
      outcome: "rebase_aborted",
      detail: step.diagnostic ?? "rebase failed for non-conflict reason",
      resolvedFiles,
      runIds,
    };
  }

  const template = loadTemplate("conflict-resolve", repo, ctx.config.dataDir);

  for (let i = 0; i < maxRebaseSteps; i++) {
    const conflicted = step.conflictedFiles!;

    const userPrompt = renderTemplate(template, {
      repo_full_name: `${repo.owner}/${repo.name}`,
      branch,
      base_ref: baseRef,
      pr_number: String(item.number),
      pr_title: item.title,
      previous_summary: previousSummary || "(no previous summary)",
      conflicted_files_list: conflicted.map((p) => `- \`${p}\``).join("\n"),
      language_for_communication: repo.language_for_communication,
      language_for_commits: repo.language_for_commits,
      language_for_code_identifiers: repo.language_for_code_identifiers,
    });

    let job;
    try {
      job = await runJob(ctx, {
        jobType: "patch",
        lane: "conflict_resolve",
        taskId,
        engineOpts: {
          systemPrompt: [
            "You resolve merge conflicts in a git working tree. The rebase is paused; your job is to edit the listed files in place so they no longer contain conflict markers, then exit.",
            "Hard rules:",
            " - Do NOT run any git command (no commit, no rebase --continue, no add).",
            " - Do NOT touch files that are not in the conflicted list.",
            " - Do NOT add TODOs, placeholders, or 'TODO: human review' notes.",
            " - Preserve surrounding code style.",
            " - Each conflicted file must end up free of <<<<<<<, =======, >>>>>>> markers.",
            `Project language rules: communication in ${repo.language_for_communication}, code identifiers in ${repo.language_for_code_identifiers}.`,
          ].join("\n"),
          userPrompt,
          workdir,
          tools: "git-write",
          timeoutMs: 20 * 60 * 1000,
          maxBudgetUsd: ctx.config.global.cost_caps.per_task_usd,
        },
      });
    } catch (error) {
      await rebaseAbort(workdir);
      return {
        outcome: "agent_failed",
        detail: `engine call failed: ${errMsg(error)}`,
        resolvedFiles,
        runIds,
      };
    }
    runIds.push(job.runId);
    if (!agentSummary && job.result.content) agentSummary = job.result.content;

    // -- Validate: each file must be marker-free now ----------------------
    const stillConflicted: string[] = [];
    for (const path of conflicted) {
      if (fileHasConflictMarkers(workdir, path)) stillConflicted.push(path);
    }
    if (stillConflicted.length > 0) {
      await rebaseAbort(workdir);
      return {
        outcome: "still_conflicted",
        detail: `agent left conflict markers in: ${stillConflicted.join(", ")}`,
        resolvedFiles,
        runIds,
        agentSummary,
      };
    }

    for (const p of conflicted) {
      if (!resolvedFiles.includes(p)) resolvedFiles.push(p);
    }

    // -- Defensive: if agent disregarded instructions and finished the
    // rebase itself, treat it as success — skip add/continue and go push.
    const agentFinishedRebase = !rebaseInProgress(workdir);

    // -- Stage what the agent edited and continue --------------------------
    if (!agentFinishedRebase) {
      try {
        await addPaths(workdir, conflicted);
      } catch (error) {
        await rebaseAbort(workdir);
        return {
          outcome: "error",
          detail: `git add failed: ${errMsg(error)}`,
          resolvedFiles,
          runIds,
          agentSummary,
        };
      }

      step = await continueRebase(workdir);
    } else {
      step = { ok: true };
    }
    if (step.ok) {
      // Rebase finished cleanly.
      let newHeadSha: string | undefined;
      try {
        newHeadSha = await getCurrentSha(workdir);
      } catch {
        // ignore — we still treat this as success
      }
      try {
        await forcePushWithLease(workdir, remoteUrl, branch, token, preRebaseRemoteSha);
      } catch (error) {
        return {
          outcome: "push_failed",
          detail: errMsg(error),
          resolvedFiles,
          runIds,
          agentSummary,
          ...(newHeadSha && { newHeadSha }),
        };
      }
      return {
        outcome: "rebased",
        resolvedFiles,
        runIds,
        agentSummary,
        ...(newHeadSha && { newHeadSha }),
      };
    }
    if (!step.conflictedFiles) {
      return {
        outcome: "rebase_aborted",
        detail: step.diagnostic ?? "rebase --continue failed for non-conflict reason",
        resolvedFiles,
        runIds,
        agentSummary,
      };
    }
    // Otherwise: another batch of conflicts on the next commit being
    // re-applied. Loop and ask the agent again.
  }

  // Exceeded the per-attempt step cap.
  await rebaseAbort(workdir);
  return {
    outcome: "max_attempts",
    detail: `rebase did not converge in ${maxRebaseSteps} steps`,
    resolvedFiles,
    runIds,
    agentSummary,
  };
}

// Whitelisted cleanup helper for callers that want to drop the workdir
// after a failed attempt (e.g. push_failed).
export function discardWorkdir(workdir: string): void {
  cleanupWorkdir(workdir);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
