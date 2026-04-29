import type { Db } from "../storage/db.js";
import type { RuntimeConfig, RepoConfig } from "../config/schema.js";
import { GithubVcsProvider } from "../providers/github.js";
import { runReview } from "../lanes/review.js";
import { runPatch } from "../lanes/patch.js";
import { runPatchMulti } from "../lanes/patch-multi.js";
import { runPrDialog } from "../lanes/pr-dialog.js";
import { runAnalyze } from "../lanes/analyze.js";
import { isBotMessage } from "../lanes/messages.js";
import { writeReviewReport } from "../storage/reports.js";
import { dequeue, markDone, markError, requeuePaused, type QueuedTask } from "./queue.js";
import { isPaused } from "../lib/pause.js";
import { computeNextDueAt, parseDurationMs } from "./cadence.js";
import { CostCapExceeded } from "../supervisor/index.js";
import { RateLimited } from "../engines/types.js";
import { ensureRepo } from "../storage/tasks.js";
import { getPrBranchByPrNumber, getPrBranchByTask } from "../storage/pr-branches.js";

// Statuses on pr_branches that mean "this attempt is parked, don't redo it
// from scratch on the next reconcile". Lifted only by human action (label
// removal / new comment that webhook re-enqueues / explicit retry button).
const TERMINAL_BRANCH_STATUSES = new Set([
  "guardrail_blocked",
  "dirty",
  "no_changes",
  "needs_human",
  // "error" is set by the patch lane's catch block (e.g. clone failed,
  // setIdentity failed, agent threw before producing a commit). Without
  // this entry we'd loop the same failure every reconcile cycle.
  "error",
]);

export interface WorkResult {
  taskId: number;
  status: "ok" | "error" | "skipped";
  lane?: "triage" | "analyze" | "patch" | "patch_multi" | "pr_dialog";
  detail?: string;
}

export async function processOne(
  db: Db,
  config: RuntimeConfig,
  opts: { repoId?: number } = {},
): Promise<WorkResult | undefined> {
  const task = dequeue(db, undefined, opts);
  if (!task) return undefined;

  if (isPaused(config.dataDir)) {
    requeuePaused(db, task.id);
    return { taskId: task.id, status: "skipped", detail: "paused" };
  }

  const repo = findRepo(config, task);
  if (!repo) {
    markError(db, task.id, "repo not in current config (unwatched)", 24 * 60 * 60 * 1000);
    return { taskId: task.id, status: "skipped", detail: "repo not in config" };
  }

  try {
    const provider = new GithubVcsProvider();
    const item = await provider.getItem(
      { owner: repo.owner, name: repo.name },
      Number(task.external_id),
    );

    const repoId = ensureRepo(db, { provider: repo.provider, owner: repo.owner, name: repo.name });

    // If the item is a closed PR we created, update pr_branches.status so the
    // dashboard / reconcile / pickLane see it as closed.
    if (item.kind === "pull_request" && item.state === "closed") {
      const ourBranch = getPrBranchByPrNumber(db, repoId, Number(task.external_id));
      if (ourBranch && ourBranch.status !== "closed") {
        db.prepare(
          "UPDATE pr_branches SET status = ?, updated_at = datetime('now') WHERE id = ?",
        ).run("closed", ourBranch.id);
      }
    }

    const lane = pickLane(repo, item, db, repoId, Number(task.external_id));
    if (!lane) {
      markDone(
        db,
        task.id,
        computeNextDueAt(new Date().toISOString(), repo.cadence ?? config.global.cadence),
      );
      return { taskId: task.id, status: "skipped", detail: "no applicable lane" };
    }

    if (lane === "analyze") {
      const result = await runAnalyze({ ctx: { config, db, repo }, item });
      const next =
        result.outcome === "ready"
          ? new Date(Date.now() + 1000).toISOString() // re-process almost immediately so patch picks up
          : computeNextDueAt(new Date().toISOString(), repo.cadence ?? config.global.cadence);
      markDone(db, task.id, next);
      // If state=ready, also enqueue right away so patch lane runs without waiting for cadence.
      if (result.outcome === "ready") {
        enqueueImmediate(db, task.id);
      }
      return {
        taskId: task.id,
        status: result.outcome === "error" ? "error" : "ok",
        lane,
        detail: `${result.outcome}${result.decision ? ` (${result.decision.questions.length}q)` : ""}`,
      };
    }

    if (lane === "patch") {
      const result = await runPatch({ ctx: { config, db, repo }, item });
      // Park terminal outcomes (guardrail / dirty / no_changes) for 24h so a
      // misrouted reconcile can't burn cost in a tight loop. The pickLane
      // gate above is the primary defence; this is belt-and-braces.
      const parked = result.outcome === "guardrail_blocked" || result.outcome === "no_changes";
      const next = parked
        ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        : computeNextDueAt(item.createdAt, repo.cadence ?? config.global.cadence);
      markDone(db, task.id, next);
      return {
        taskId: task.id,
        status: result.outcome === "error" ? "error" : "ok",
        lane,
        detail: `${result.outcome}${result.prNumber ? ` (PR #${result.prNumber})` : ""}`,
      };
    }

    if (lane === "patch_multi") {
      const result = await runPatchMulti({ ctx: { config, db, repo }, item });
      const parked = result.outcome === "guardrail_blocked" || result.outcome === "no_changes";
      const next = parked
        ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        : computeNextDueAt(item.createdAt, repo.cadence ?? config.global.cadence);
      markDone(db, task.id, next);
      return {
        taskId: task.id,
        status: result.outcome === "error" ? "error" : "ok",
        lane,
        detail: `${result.outcome}${result.prNumber ? ` (PR #${result.prNumber})` : ""}`,
      };
    }

    if (lane === "pr_dialog") {
      const result = await runPrDialog({ ctx: { config, db, repo }, item });
      const next = computeNextDueAt(
        new Date().toISOString(),
        repo.cadence ?? config.global.cadence,
      );
      markDone(db, task.id, next);
      return {
        taskId: task.id,
        status: result.outcome === "error" ? "error" : "ok",
        lane,
        detail: `${result.outcome} iter=${result.iteration}`,
      };
    }

    const review = await runReview({ ctx: { config, db, repo }, item });
    writeReviewReport({
      dataDir: config.dataDir,
      repo,
      item,
      decision: review.decision,
      engineId: review.engine,
      model: review.model,
      usage: review.usage,
      durationMs: review.durationMs,
    });
    const next = computeNextDueAt(item.createdAt, repo.cadence ?? config.global.cadence);
    markDone(db, task.id, next);
    return { taskId: task.id, status: "ok", lane, detail: review.decision.decision };
  } catch (error) {
    if (error instanceof CostCapExceeded) {
      markError(db, task.id, error.message, 60 * 60 * 1000);
      return { taskId: task.id, status: "error", detail: "cost-cap" };
    }
    if (error instanceof RateLimited) {
      // Cooldown = max(time until parsed reset, configured cooldown).
      // Without a parsed reset we fall back to the configured value.
      const cooldownMs = parseDurationMs(config.global.rate_limit_cooldown);
      const untilResetMs = error.resetAt ? Math.max(0, error.resetAt.getTime() - Date.now()) : 0;
      const delayMs = Math.max(cooldownMs, untilResetMs);
      markError(db, task.id, error.message, delayMs);
      return {
        taskId: task.id,
        status: "error",
        detail: `rate-limit (cooldown ${Math.round(delayMs / 60000)}m)`,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    markError(db, task.id, message);
    return { taskId: task.id, status: "error", detail: message.slice(0, 120) };
  }
}

export async function drain(db: Db, config: RuntimeConfig, limit: number): Promise<WorkResult[]> {
  const out: WorkResult[] = [];
  for (let i = 0; i < limit; i++) {
    const result = await processOne(db, config);
    if (!result) break;
    out.push(result);
  }
  return out;
}

// Like drain() but only pulls tasks from one repo. Used by the per-repo
// scheduler workers so a long-running call in one repo doesn't block work
// in another.
export async function drainRepo(
  db: Db,
  config: RuntimeConfig,
  repoId: number,
  limit: number,
): Promise<WorkResult[]> {
  const out: WorkResult[] = [];
  for (let i = 0; i < limit; i++) {
    const result = await processOne(db, config, { repoId });
    if (!result) break;
    out.push(result);
  }
  return out;
}

function pickLane(
  repo: RepoConfig,
  item: { kind: "issue" | "pull_request"; labels: string[]; state: "open" | "closed" },
  db: Db,
  repoId: number,
  externalId: number,
): "analyze" | "patch" | "patch_multi" | "pr_dialog" | "triage" | undefined {
  if (item.state === "closed") return undefined;

  if (item.kind === "pull_request") {
    if (!repo.lanes.includes("pr_dialog")) return undefined;
    const branch = getPrBranchByPrNumber(db, repoId, externalId);
    if (!branch || branch.status === "closed") return undefined;
    return "pr_dialog";
  }

  // Issues with the trigger label: analyze first if enabled, then patch / patch_multi.
  // patch_multi takes precedence over patch if both are configured.
  const hasPatchMulti = repo.lanes.includes("patch_multi");
  const hasPatch = repo.lanes.includes("patch");
  const hasTrigger = (hasPatch || hasPatchMulti) && item.labels.includes(repo.patch_trigger_label);

  // If a previous patch attempt parked the work in a terminal state
  // (guardrail_blocked, dirty, no_changes, needs_human) — do NOT loop into
  // analyze/patch again. The user must remove the label or otherwise unstick
  // it. Webhook on a fresh non-bot comment will re-enqueue, and at that
  // point the user has presumably acted.
  if (hasTrigger) {
    const taskRow = db
      .prepare("SELECT id FROM tasks WHERE repo_id = ? AND external_id = ?")
      .get(repoId, String(externalId)) as { id: number } | undefined;
    if (taskRow) {
      const branch = getPrBranchByTask(db, taskRow.id);
      if (branch && TERMINAL_BRANCH_STATUSES.has(branch.status)) return undefined;
    }
  }

  if (hasTrigger && repo.lanes.includes("analyze")) {
    // same analyze-first logic applies for both patch and patch_multi
    const taskRow = db
      .prepare("SELECT decision_json FROM tasks WHERE repo_id = ? AND external_id = ?")
      .get(repoId, String(externalId)) as { decision_json: string | null } | undefined;
    const stored = taskRow?.decision_json
      ? (() => {
          try {
            return JSON.parse(taskRow.decision_json!) as {
              lane?: string;
              state?: string;
              asked_at?: string;
            };
          } catch {
            return undefined;
          }
        })()
      : undefined;

    // No prior analyzer run → analyze first.
    if (!stored || stored.lane !== "analyze") return "analyze";

    // Analyzer already gave green light → patch_multi if enabled, else patch.
    if (stored.state === "ready") return hasPatchMulti ? "patch_multi" : "patch";

    // Analyzer is waiting for clarification. Re-run analyze on every wake-up
    // — the worker only got here because something queued the task (webhook
    // on a non-bot comment or scheduled poll). The analyzer itself decides
    // whether the new info is enough to switch to 'ready'.
    return "analyze";
  }

  if (hasTrigger) return hasPatchMulti ? "patch_multi" : "patch";
  if (repo.lanes.includes("triage")) return "triage";
  return undefined;
}

function findRepo(config: RuntimeConfig, task: QueuedTask): RepoConfig | undefined {
  return config.repos.find(
    (r) => r.provider === task.provider && r.owner === task.owner && r.name === task.repo_name,
  );
}

function enqueueImmediate(db: Db, taskId: number): void {
  db.prepare(
    "UPDATE tasks SET status = 'pending', priority = 'high', next_due_at = NULL WHERE id = ?",
  ).run(taskId);
}
