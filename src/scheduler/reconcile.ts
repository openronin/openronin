import type { Db } from "../storage/db.js";
import type { RepoConfig } from "../config/schema.js";
import { GithubVcsProvider } from "../providers/github.js";
import { JiraTrackerProvider } from "../providers/jira.js";
import type { VcsItem, VcsProvider } from "../providers/vcs.js";
import { ensureRepo, upsertTask, upsertJiraTask } from "../storage/tasks.js";
import { enqueue } from "./queue.js";
import { computeNextDueAt } from "./cadence.js";
import { listPrBranches } from "../storage/pr-branches.js";
import { isBotMessage } from "../lanes/messages.js";
import { parseSqliteUtc } from "../lib/time.js";
import { computeItemSnapshot } from "../lib/snapshot.js";

export interface ReconcileResult {
  repo: string;
  scanned: number;
  enqueued: number;
  pr_polled?: number;
  pr_enqueued?: number;
}

// Walk one repo's open items and enqueue any that are missing or due.
export async function reconcileRepo(
  db: Db,
  repo: RepoConfig,
  globalCadence: { hot: string; default: string; cold: string },
  provider: VcsProvider = new GithubVcsProvider(),
): Promise<ReconcileResult> {
  const cadence = repo.cadence ?? globalCadence;
  const repoId = ensureRepo(db, { provider: repo.provider, owner: repo.owner, name: repo.name });
  const now = new Date();
  let scanned = 0;
  let enqueued = 0;

  for await (const item of provider.listOpenItems({ owner: repo.owner, name: repo.name })) {
    scanned += 1;
    const planned = planTask(db, repoId, item, cadence, now, repo.patch_trigger_label);
    if (planned) enqueued += 1;
  }

  // Also poll our own open PRs for new feedback. This is the safety net for
  // when the webhook is missing, lagging, or filtered out.
  const prPoll = repo.lanes.includes("pr_dialog")
    ? await pollOurPrs(db, repo, repoId, provider)
    : { polled: 0, enqueued: 0 };

  return {
    repo: `${repo.provider}:${repo.owner}/${repo.name}`,
    scanned,
    enqueued,
    pr_polled: prPoll.polled,
    pr_enqueued: prPoll.enqueued,
  };
}

async function pollOurPrs(
  db: Db,
  repo: RepoConfig,
  repoId: number,
  provider: VcsProvider,
): Promise<{ polled: number; enqueued: number }> {
  const branches = listPrBranches(db, 200).filter(
    (b) => b.pr_number != null && b.status !== "closed",
  );
  let polled = 0;
  let enqueued = 0;
  for (const b of branches) {
    // Scope to this repo: the PR was opened in *this* repo only if its task lives in this repo.
    const task = db
      .prepare("SELECT id, external_id, repo_id FROM tasks WHERE id = ?")
      .get(b.task_id) as { id: number; external_id: string; repo_id: number } | undefined;
    if (!task || task.repo_id !== repoId) continue;
    polled += 1;
    try {
      // First: detect PR closure / merge and update our row, then continue.
      const item = await provider.getItem(
        { owner: repo.owner, name: repo.name },
        Number(b.pr_number),
      );
      if (item.state === "closed" && b.status !== "closed") {
        db.prepare(
          "UPDATE pr_branches SET status = ?, updated_at = datetime('now') WHERE id = ?",
        ).run("closed", b.id);
        continue;
      }

      const feedback = await provider.listAllPrFeedback(
        { owner: repo.owner, name: repo.name },
        Number(b.pr_number),
      );
      const since = b.updated_at ?? b.created_at;
      const newCount = feedback.filter(
        (c) =>
          new Date(c.createdAt).getTime() > parseSqliteUtc(since).getTime() &&
          !repo.pr_dialog_skip_authors.includes(c.author) &&
          !isBotMessage(c.body),
      ).length;

      // Three reasons to enqueue:
      //   1. There's new feedback to process (high priority).
      //   2. auto_merge is enabled — re-poll lets pr_dialog re-check the merge gate
      //      after CI flips green (normal priority; reconcile interval throttles).
      const shouldEnqueue = newCount > 0 || repo.auto_merge.enabled;
      if (!shouldEnqueue) continue;

      const prTaskId = upsertTask(db, repoId, String(b.pr_number), "pull_request");
      enqueue(db, prTaskId, newCount > 0 ? "high" : "normal", null);
      enqueued += 1;
    } catch (error) {
      console.warn(
        `[reconcile] pr-poll failed for ${repo.owner}/${repo.name}#${b.pr_number}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return { polled, enqueued };
}

// Reconcile Jira tracker for a repo that has jira_tracker config set.
// Acts as the poll fallback when the Jira webhook is silent.
export async function reconcileJiraTracker(
  db: Db,
  repo: RepoConfig,
): Promise<{ repo: string; scanned: number; enqueued: number }> {
  if (!repo.jira_tracker)
    return { repo: `${repo.provider}:${repo.owner}/${repo.name}`, scanned: 0, enqueued: 0 };

  const { base_url, project_key, label_filter } = repo.jira_tracker;
  const jira = new JiraTrackerProvider({
    baseUrl: base_url,
    projectKey: project_key,
    labelFilter: label_filter,
  });
  const repoId = ensureRepo(db, { provider: repo.provider, owner: repo.owner, name: repo.name });
  let scanned = 0;
  let enqueued = 0;

  for await (const task of jira.listIncomingTasks()) {
    scanned += 1;
    const existing = db
      .prepare("SELECT id, status FROM tasks WHERE repo_id = ? AND external_id = ?")
      .get(repoId, task.externalId) as { id: number; status: string } | undefined;
    if (existing?.status === "running") continue;
    const taskId = upsertJiraTask(db, repoId, task.externalId);
    if (!existing) {
      enqueue(db, taskId, "high", null);
      enqueued += 1;
    }
  }

  return { repo: `${repo.provider}:${repo.owner}/${repo.name}`, scanned, enqueued };
}

interface ExistingTask {
  id: number;
  status: string;
  next_due_at: string | null;
  snapshot_hash: string | null;
}

function planTask(
  db: Db,
  repoId: number,
  item: VcsItem,
  cadence: { hot: string; default: string; cold: string },
  now: Date,
  patchTriggerLabel?: string,
): boolean {
  const taskId = upsertTask(db, repoId, String(item.number), item.kind);
  const existing = db
    .prepare("SELECT id, status, next_due_at, snapshot_hash FROM tasks WHERE id = ?")
    .get(taskId) as ExistingTask | undefined;

  if (!existing) return false;

  // If the trigger label was removed, cancel any guardrail_blocked rows so the
  // task is no longer parked. Re-adding the label will restart the patch cycle.
  if (patchTriggerLabel && !item.labels.includes(patchTriggerLabel)) {
    db.prepare(
      `UPDATE pr_branches SET status = 'cancelled', updated_at = datetime('now')
       WHERE task_id = ? AND status = 'guardrail_blocked'`,
    ).run(taskId);
  }

  // Skip items already running or already pending and not yet due — don't re-enqueue.
  if (existing.status === "running") return false;
  if (
    existing.status === "pending" &&
    existing.next_due_at &&
    new Date(existing.next_due_at).getTime() > now.getTime()
  ) {
    return false;
  }

  const currentSnapshot = computeItemSnapshot(item);
  const newToUs = !existing.snapshot_hash;
  const unchanged = existing.snapshot_hash === currentSnapshot;
  const dueNow = !existing.next_due_at || new Date(existing.next_due_at).getTime() <= now.getTime();

  // First scan ever → high priority.
  if (newToUs) {
    enqueue(db, taskId, "high", null);
    return true;
  }

  if (dueNow) {
    if (!unchanged) {
      // Content changed → re-triage at normal priority.
      enqueue(db, taskId, "normal", computeNextDueAt(item.createdAt, cadence, now));
      return true;
    }
    // Content unchanged → push next_due_at forward without enqueueing.
    db.prepare("UPDATE tasks SET next_due_at = ? WHERE id = ?").run(
      computeNextDueAt(item.createdAt, cadence, now),
      taskId,
    );
    return false;
  }

  return false;
}
