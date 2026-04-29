import type { Db } from "../storage/db.js";
import type { RuntimeConfig } from "../config/schema.js";
import { reconcileRepo, reconcileJiraTracker, type ReconcileResult } from "./reconcile.js";
import { drainRepo, type WorkResult } from "./worker.js";
import { ensureRepo } from "../storage/tasks.js";

export interface SchedulerOptions {
  reconcileIntervalMs: number;
  drainIntervalMs: number;
  drainBatchSize: number;
}

export const DEFAULT_OPTIONS: SchedulerOptions = {
  reconcileIntervalMs: 15 * 60 * 1000, // 15 minutes
  drainIntervalMs: 30 * 1000, // 30 seconds
  drainBatchSize: 5,
};

export interface WorkerStatus {
  repoKey: string; // "github:owner/name"
  repoId: number;
  busy: boolean;
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastResultCount?: number;
  currentTaskId?: number; // task being processed (best-effort)
}

export interface SchedulerHandle {
  // Stop scheduling further ticks. Returns a promise that resolves when
  // all in-flight workers finish, or after `timeoutMs` (forced cutoff).
  // Use this from SIGTERM handlers so a deploy restart doesn't kill a
  // mid-flight patch lane and leave it as a 'crash recovery' task.
  stop: (timeoutMs?: number) => Promise<{ idle: boolean; waitedMs: number }>;
  tickReconcile: () => Promise<ReconcileResult[]>;
  tickDrain: () => Promise<WorkResult[]>;
  workerStatuses: () => WorkerStatus[];
  // Mark a long-running side activity (e.g. an in-flight deploy) so the
  // graceful shutdown waits for it too, not just the per-repo drain
  // workers. Returns the function to call when the activity finishes.
  trackActivity: (label: string) => () => void;
}

// Start two interval loops: reconcile (slow) and drain (fast).
// Both serialize their own work to avoid overlap.
// Reset tasks left in 'running' state by a previous shutdown back to 'pending'
// so the new process picks them up. Without this they sit forever — dequeue
// only takes 'pending' and reconcile.planTask explicitly skips 'running'.
//
// Also close orphaned runs: when SIGTERM kills mid-engine-call, finishRun()
// never gets a chance to flip the row to ok/error, so it stays 'running'
// forever and confuses /admin and cost dashboards.
export function recoverStuckTasks(db: Db): { tasks: number; runs: number; deploys: number } {
  // First: any task with 3+ accumulated 'crash recovery' stamps in last_error
  // is being killed every time it tries to start. Stop the loop — abandon
  // it with a far-future next_due_at and a 'done' status. Operator can
  // unstick manually via /admin/tasks/:id once the underlying issue
  // (probably "this task takes longer than systemd TimeoutStopSec, and
  //  we deploy too often") is resolved.
  const abandoned = db
    .prepare(
      `UPDATE tasks
          SET status = 'done',
              next_due_at = datetime('now', '+24 hours'),
              last_error = COALESCE(last_error, '') || ' [abandoned: too many crash recoveries — kick manually]'
        WHERE status = 'running'
          AND last_error IS NOT NULL
          AND (length(last_error) - length(replace(last_error, '[crash recovery', ''))) / length('[crash recovery') >= 3`,
    )
    .run();
  const recoveredTasks = db
    .prepare(
      `UPDATE tasks
          SET status = 'pending',
              priority = 'high',
              next_due_at = NULL,
              last_error = substr(
                COALESCE(last_error || ' | ', '') || '[crash recovery: was running at shutdown]',
                1, 1024
              )
        WHERE status = 'running'`,
    )
    .run();
  const recoveredRuns = db
    .prepare(
      `UPDATE runs
          SET status = 'error',
              finished_at = datetime('now'),
              error = COALESCE(error, '') || '[crash recovery: orphaned run, process exited mid-call]'
        WHERE status = 'running'`,
    )
    .run();
  // Same for deploy records — without this, /admin/deploys shows a 'running'
  // row forever after a self-deploy SIGTERM.
  let recoveredDeploys = { changes: 0 };
  try {
    recoveredDeploys = db
      .prepare(
        `UPDATE deploys
            SET status = 'error',
                finished_at = datetime('now'),
                error = COALESCE(error, '') || '[crash recovery: orphaned deploy, process exited mid-call]'
          WHERE status = 'running'`,
      )
      .run();
  } catch {
    // deploys table may not exist on very old schemas; ignore.
  }
  if (
    abandoned.changes > 0 ||
    recoveredTasks.changes > 0 ||
    recoveredRuns.changes > 0 ||
    recoveredDeploys.changes > 0
  ) {
    console.log(
      `[recovery] abandoned ${abandoned.changes}, reset ${recoveredTasks.changes} task(s) running→pending, ${recoveredRuns.changes} run(s) running→error, ${recoveredDeploys.changes} deploy(s) running→error`,
    );
  }
  return {
    tasks: recoveredTasks.changes,
    runs: recoveredRuns.changes,
    deploys: recoveredDeploys.changes,
  };
}

export function startScheduler(
  db: Db,
  getConfig: () => RuntimeConfig,
  options: Partial<SchedulerOptions> = {},
): SchedulerHandle {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  recoverStuckTasks(db);
  let reconcileBusy = false;
  let stopped = false;

  // Per-repo drain workers. Each watched repo gets its own logical worker
  // so a long-running task in one repo (e.g. a 5-min Claude Code call)
  // doesn't block work in another. The actual concurrency is bounded by
  // the number of watched repos.
  interface InternalWorker {
    repoKey: string;
    repoId: number;
    busy: boolean;
    lastStartedAt?: string;
    lastFinishedAt?: string;
    lastResultCount?: number;
    currentTaskId?: number;
  }
  const workersByKey = new Map<string, InternalWorker>();

  const repoKeyOf = (repo: { provider: string; owner: string; name: string }): string =>
    `${repo.provider}:${repo.owner}/${repo.name}`;

  const ensureWorker = (repo: {
    provider: string;
    owner: string;
    name: string;
  }): InternalWorker => {
    const key = repoKeyOf(repo);
    let w = workersByKey.get(key);
    if (!w) {
      const repoId = ensureRepo(db, {
        provider: repo.provider,
        owner: repo.owner,
        name: repo.name,
      });
      w = { repoKey: key, repoId, busy: false };
      workersByKey.set(key, w);
    }
    return w;
  };

  const tickReconcile = async (): Promise<ReconcileResult[]> => {
    if (reconcileBusy || stopped) return [];
    reconcileBusy = true;
    const out: ReconcileResult[] = [];
    try {
      const config = getConfig();
      const watched = config.repos.filter((r) => r.watched);
      for (const repo of watched) {
        try {
          const result = await reconcileRepo(db, repo, config.global.cadence);
          out.push(result);
          const prPart =
            result.pr_polled !== undefined
              ? ` pr_polled=${result.pr_polled} pr_enqueued=${result.pr_enqueued}`
              : "";
          console.log(
            `[scheduler] reconciled ${result.repo}: scanned=${result.scanned} enqueued=${result.enqueued}${prPart}`,
          );
        } catch (error) {
          console.error(`[scheduler] reconcile error for ${repo.owner}/${repo.name}:`, error);
        }
        if (repo.jira_tracker) {
          try {
            const jr = await reconcileJiraTracker(db, repo);
            console.log(
              `[scheduler] jira reconcile ${jr.repo}: scanned=${jr.scanned} enqueued=${jr.enqueued}`,
            );
          } catch (error) {
            console.error(
              `[scheduler] jira reconcile error for ${repo.owner}/${repo.name}:`,
              error,
            );
          }
        }
      }
    } finally {
      reconcileBusy = false;
    }
    return out;
  };

  const tickDrain = async (): Promise<WorkResult[]> => {
    if (stopped) {
      const arr = [] as WorkResult[];
      (arr as WorkResult[] & { busy?: true }).busy = true;
      return arr;
    }
    const config = getConfig();
    const watched = config.repos.filter((r) => r.watched);
    if (watched.length === 0) return [];

    // Fire one drain per repo in parallel, guarded by per-repo busy flag.
    // A repo whose worker is already running skips this tick (its previous
    // call is still grinding through batchSize tasks).
    const promises: Promise<WorkResult[]>[] = [];
    let allBusy = true;
    for (const repo of watched) {
      const worker = ensureWorker(repo);
      if (worker.busy) continue;
      allBusy = false;
      worker.busy = true;
      worker.lastStartedAt = new Date().toISOString();
      const repoLabel = `${repo.owner}/${repo.name}`;
      const promise = (async () => {
        try {
          return await drainRepo(db, config, worker.repoId, opts.drainBatchSize);
        } catch (error) {
          console.error(`[scheduler] drainRepo error for ${repoLabel}:`, error);
          return [] as WorkResult[];
        }
      })().finally(() => {
        worker.busy = false;
        worker.lastFinishedAt = new Date().toISOString();
        delete worker.currentTaskId;
      });
      promises.push(
        promise.then((results) => {
          worker.lastResultCount = results.length;
          if (results.length > 0) {
            console.log(
              `[scheduler] drained ${repoLabel} ${results.length}: ${results
                .map((r) => `#${r.taskId}=${r.status}/${r.detail ?? "?"}`)
                .join(", ")}`,
            );
          }
          return results;
        }),
      );
    }

    if (promises.length === 0) {
      // Every watched repo's worker is still mid-flight from a previous tick.
      const arr = [] as WorkResult[];
      (arr as WorkResult[] & { busy?: boolean }).busy = allBusy;
      return arr;
    }

    const all = await Promise.all(promises);
    return all.flat();
  };

  const reconcileTimer = setInterval(() => {
    void tickReconcile();
  }, opts.reconcileIntervalMs);
  const drainTimer = setInterval(() => {
    void tickDrain();
  }, opts.drainIntervalMs);

  // Kick off an immediate reconcile + drain so a fresh boot doesn't wait.
  setTimeout(() => {
    void tickReconcile().then(() => void tickDrain());
  }, 1000);

  const workerStatuses = (): WorkerStatus[] => {
    // Refresh the worker map against current config so newly-added repos
    // show up immediately and removed ones stop appearing.
    const config = getConfig();
    const wantedKeys = new Set<string>();
    for (const repo of config.repos.filter((r) => r.watched)) {
      ensureWorker(repo);
      wantedKeys.add(repoKeyOf(repo));
    }
    for (const key of workersByKey.keys()) {
      if (!wantedKeys.has(key)) workersByKey.delete(key);
    }
    return [...workersByKey.values()].map((w) => ({
      repoKey: w.repoKey,
      repoId: w.repoId,
      busy: w.busy,
      ...(w.lastStartedAt && { lastStartedAt: w.lastStartedAt }),
      ...(w.lastFinishedAt && { lastFinishedAt: w.lastFinishedAt }),
      ...(w.lastResultCount !== undefined && { lastResultCount: w.lastResultCount }),
      ...(w.currentTaskId !== undefined && { currentTaskId: w.currentTaskId }),
    }));
  };

  const activeActivities = new Set<string>();
  let activityCounter = 0;

  const anyWorkerBusy = (): boolean => {
    for (const w of workersByKey.values()) {
      if (w.busy) return true;
    }
    if (reconcileBusy) return true;
    return activeActivities.size > 0;
  };

  const trackActivity = (label: string): (() => void) => {
    const id = `${label}#${++activityCounter}`;
    activeActivities.add(id);
    return () => activeActivities.delete(id);
  };

  return {
    stop: async (timeoutMs = 120_000) => {
      stopped = true;
      clearInterval(reconcileTimer);
      clearInterval(drainTimer);
      const start = Date.now();
      while (anyWorkerBusy()) {
        if (Date.now() - start > timeoutMs) {
          return { idle: false, waitedMs: Date.now() - start };
        }
        await new Promise((res) => setTimeout(res, 500));
      }
      return { idle: true, waitedMs: Date.now() - start };
    },
    tickReconcile,
    tickDrain,
    workerStatuses,
    trackActivity,
  };
}
