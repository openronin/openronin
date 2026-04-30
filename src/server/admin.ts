import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { styleguideRoute } from "./styleguide.js";
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import YAML from "yaml";
import type { Db } from "../storage/db.js";
import type { RuntimeConfig } from "../config/schema.js";
import { listRepos, syncReposFromConfig } from "../storage/repos.js";
import {
  listRecentRuns,
  getRunsByTask,
  listRunsFiltered,
  getRunDistincts,
  getRunById,
  getCostUsdSince,
  getCostGroupedByLane,
  getCostGroupedByEngine,
  getCostGroupedByRepo,
  getTasksPerDay,
  getSuccessRateByLane,
  getAvgLatencyByModel,
  getTokensPerDay,
} from "../storage/runs.js";
import { listPendingJiraTasks, listPendingTodoistTasks } from "../storage/tasks.js";
import { loadConfig } from "../config/loader.js";
import { queueStats, enqueue } from "../scheduler/queue.js";
import { ensureRepo, upsertTask } from "../storage/tasks.js";
import { repoConfigFilename, RepoConfigSchema, type RepoConfig } from "../config/schema.js";
import { GithubVcsProvider } from "../providers/github.js";
import { listPrBranches, listBlockedPatches } from "../storage/pr-branches.js";
import { listRecentDeploys } from "../storage/deploys.js";
import { isBotMessage } from "../lanes/messages.js";
import { parseSqliteUtc } from "../lib/time.js";
import { isPaused } from "../lib/pause.js";
import { html, page, isHtmx, raw, escapeHtml, t as time, type TrustedHtml } from "./layout.js";
import { button } from "./components/button.js";
import { badge, type BadgeTone } from "./components/badge.js";
import { card } from "./components/card.js";
import { table } from "./components/table.js";
import { yamlEditor } from "./components/form.js";

interface Args {
  db: Db;
  getConfig: () => RuntimeConfig;
  scheduler?: import("../scheduler/index.js").SchedulerHandle;
  startedAt?: number;
}

export function adminRoute({ db, getConfig, scheduler, startedAt }: Args): Hono {
  const app = new Hono();
  const password = process.env.ADMIN_UI_PASSWORD;
  const bootedAt = startedAt ?? Date.now();

  if (password) {
    app.use("*", basicAuth({ username: process.env.OPENRONIN_ADMIN_USER ?? "admin", password }));
  }

  app.route("", styleguideRoute());

  // Serve the brand icon used in the header.
  app.get("/_assets/icon.png", (c) => {
    const p = resolve(getProjectRoot(), "docs", "assets", "icon.png");
    if (!existsSync(p)) return c.notFound();
    const data = readFileSync(p);
    return new Response(data, {
      headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
    });
  });

  // -------- Audit middleware: record all mutating admin actions --------
  app.use("*", async (c, next) => {
    await next();
    if (c.req.method === "POST" || c.req.method === "PUT" || c.req.method === "DELETE") {
      try {
        const pathname = new URL(c.req.url).pathname;
        db.prepare(
          "INSERT INTO admin_audit (method, path, actor, created_at) VALUES (?, ?, ?, datetime('now'))",
        ).run(c.req.method, pathname, "admin");
      } catch {
        // audit failures must never surface to the user
      }
    }
  });

  // -------- Operational controls (pause / resume / run-now / health) --------
  app.post("/api/pause", async (c) => {
    const reason = (await c.req.parseBody().catch(() => ({}) as Record<string, string>)).reason as
      | string
      | undefined;
    const path = resolve(getConfig().dataDir, ".PAUSE");
    writeFileSync(path, (reason || "paused via admin UI") + "\n", { mode: 0o644 });
    return c.html(pauseControl(true, reason));
  });
  app.post("/api/resume", (c) => {
    const path = resolve(getConfig().dataDir, ".PAUSE");
    if (existsSync(path)) {
      try {
        unlinkSync(path);
      } catch {
        // ignore
      }
    }
    return c.html(pauseControl(false));
  });
  app.get("/api/pause-state", (c) => {
    const config = getConfig();
    return c.html(pauseControl(isPaused(config.dataDir)));
  });
  // Kick the next pending task (the one waiting longest before its due
  // time) into the head of the queue: high priority, due immediately.
  // Skips tasks that are already due — they don't need help.
  app.post("/api/kick-first-pending", (c) => {
    const target = db
      .prepare(
        `SELECT t.id, t.external_id, t.next_due_at, r.owner, r.name AS repo_name
           FROM tasks t JOIN repos r ON r.id = t.repo_id
          WHERE t.status = 'pending'
            AND t.next_due_at IS NOT NULL
            AND t.next_due_at > datetime('now')
          ORDER BY t.next_due_at ASC, t.id ASC
          LIMIT 1`,
      )
      .get() as
      | { id: number; external_id: string; next_due_at: string; owner: string; repo_name: string }
      | undefined;
    if (!target) {
      return c.html(
        flash("ok", "Nothing to kick — all pending tasks are already due (or none pending)."),
      );
    }
    enqueue(db, target.id, "high", null);
    return c.html(
      flash(
        "ok",
        `Kicked task #${target.id} (${target.owner}/${target.repo_name}#${target.external_id}) — was due ${target.next_due_at}, now high-priority + immediate.`,
      ),
    );
  });

  app.post("/api/reconcile-now", async (c) => {
    if (!scheduler) return c.html(flash("error", "scheduler not available"), 503);
    const results = await scheduler.tickReconcile();
    const total = results.reduce(
      (acc, r) => ({
        scanned: acc.scanned + r.scanned,
        enqueued: acc.enqueued + r.enqueued,
      }),
      { scanned: 0, enqueued: 0 },
    );
    return c.html(
      flash(
        "ok",
        `Reconcile finished: ${results.length} repo(s), ${total.scanned} scanned, ${total.enqueued} newly enqueued.`,
      ),
    );
  });
  app.post("/api/drain-now", async (c) => {
    if (!scheduler) return c.html(flash("error", "scheduler not available"), 503);
    const results =
      (await scheduler.tickDrain()) as import("../scheduler/worker.js").WorkResult[] & {
        busy?: boolean;
      };
    if (results.length === 0) {
      if (results.busy) {
        return c.html(
          flash("ok", "Another drain is already running — your tasks are being picked up."),
        );
      }
      return c.html(flash("ok", "Drain finished — nothing was due."));
    }
    const lines = results.map((r) => `#${r.taskId}=${r.status}/${r.detail ?? "?"}`).join(", ");
    return c.html(flash("ok", `Drain finished: ${results.length} task(s) — ${lines}`));
  });
  // Clear rate-limit cooldown across all parked tasks. Use it after manually
  // topping up Claude tokens. Tasks whose last_error mentions a rate limit
  // get flipped back to pending with high priority and next_due_at=NULL so
  // the next drain (or this one, if you click drain right after) picks them
  // up immediately.
  app.post("/api/clear-rate-limit", (c) => {
    const r = db
      .prepare(
        `UPDATE tasks
            SET status = 'pending',
                priority = 'high',
                next_due_at = NULL,
                last_error = NULL
          WHERE last_error LIKE '%rate limit%' OR last_error LIKE '%RateLimited%'`,
      )
      .run();
    return c.html(
      flash(
        "ok",
        r.changes === 0
          ? "Nothing to clear — no tasks are in rate-limit cooldown."
          : `Cleared cooldown on ${r.changes} task(s). Drain will pick them up shortly.`,
      ),
    );
  });
  // Live worker statuses — one per watched repo. Returns a small HTML
  // fragment for the dashboard panel. Auto-refreshes via the global
  // ai:refresh trigger.
  app.get("/api/workers", (c) => {
    if (!scheduler) return c.html(`<div class="text-muted text-sm">scheduler unavailable</div>`);
    const ws = scheduler.workerStatuses();
    if (ws.length === 0) {
      return c.html(`<div class="text-muted text-sm">no watched repos</div>`);
    }
    // Sort busy first, then by last-finished desc.
    const sorted = [...ws].sort((a, b) => {
      if (a.busy !== b.busy) return a.busy ? -1 : 1;
      if (a.lastFinishedAt && b.lastFinishedAt) return a.lastFinishedAt > b.lastFinishedAt ? -1 : 1;
      if (a.lastFinishedAt) return -1;
      if (b.lastFinishedAt) return 1;
      return 0;
    });
    const rows = sorted
      .map((w) => {
        const dot = w.busy
          ? `<span class="inline-block w-2.5 h-2.5 rounded-full bg-blue-500 animate-pulse shrink-0" title="busy"></span>`
          : `<span class="inline-block w-2.5 h-2.5 rounded-full border border-subtle bg-surface shrink-0" title="idle"></span>`;
        const lastTs = w.lastFinishedAt
          ? `<span class="text-xs text-muted" title="${escapeHtml(w.lastFinishedAt)}"><time data-ts="${escapeHtml(w.lastFinishedAt)}">${escapeHtml(w.lastFinishedAt)}</time></span>`
          : `<span class="text-xs text-muted">never run</span>`;
        const kickBtn =
          `<button type="button" hx-post="/admin/api/drain-now" hx-target="#dash-flash" hx-swap="innerHTML"` +
          ` class="btn btn-ghost btn-sm px-2 ml-1" title="Drain queue now">↻</button>`;
        return (
          `<li class="flex items-center gap-2 py-1.5 border-b border-subtle last:border-0">` +
          `${dot}<code class="text-xs flex-1 min-w-0 truncate">${escapeHtml(w.repoKey)}</code>` +
          `${lastTs}${kickBtn}</li>`
        );
      })
      .join("");
    return c.html(`<ul>${rows}</ul>`);
  });

  app.get("/api/queue-cards", (c) => {
    const stats = queueStats(db);
    const cards = html`
      ${statCard("pending", stats.pending, "slate", "/admin/tasks?status=pending")}
      ${statCard("due", stats.due, "yellow", "/admin/tasks?status=pending")}
      ${statCard("running", stats.running, "blue")}
      ${statCard("done", stats.done, "green", "/admin/tasks?status=done")}
      ${statCard(
        "error",
        stats.error,
        stats.error > 0 ? "red" : "slate",
        "/admin/tasks?status=error",
      )}
    `;
    return c.html(cards.value);
  });
  app.get("/api/health-card", (c) => {
    const config = getConfig();
    const stats = queueStats(db);
    const uptimeSec = Math.floor((Date.now() - bootedAt) / 1000);
    const paused = isPaused(config.dataDir);
    const recentErrors = (
      db
        .prepare(
          "SELECT id, lane, engine, model, error FROM runs WHERE status='error' ORDER BY id DESC LIMIT 5",
        )
        .all() as Array<{
        id: number;
        lane: string;
        engine: string;
        model: string | null;
        error: string | null;
      }>
    ).map((r) => ({
      id: r.id,
      lane: r.lane,
      engine: `${r.engine}/${r.model ?? "?"}`,
      error: (r.error ?? "").slice(0, 200),
    }));
    return c.json({
      uptime_sec: uptimeSec,
      paused,
      queue: stats,
      recent_errors: recentErrors,
    });
  });

  // -------- JSON API (small, mostly for HTMX-less consumers) --------
  app.get("/api/config", (c) => c.json(getConfig()));
  app.get("/api/repos", (c) => {
    const all = c.req.query("all") === "1";
    const rows = listRepos(db, { watchedOnly: !all });
    return c.json(
      rows.map((r) => ({
        id: r.id,
        provider: r.provider,
        owner: r.owner,
        name: r.name,
        watched: r.watched === 1,
      })),
    );
  });
  app.get("/api/queue", (c) => c.json(queueStats(db)));
  app.get("/api/runs", (c) => c.json(listRecentRuns(db, Number(c.req.query("limit") ?? "50"))));

  // SSE live-update stream. Pushes queue stats + worker busy/idle every 3 s.
  // Client JS in layout.ts subscribes and fires ai:refresh on queue events.
  app.get("/api/stream", (_c) => {
    const encoder = new TextEncoder();
    let timerId: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    const push = (controller: ReadableStreamDefaultController, event: string, data: unknown) => {
      if (closed) return;
      try {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      } catch {
        closed = true;
      }
    };
    const body = new ReadableStream({
      start(controller) {
        push(controller, "ping", { ts: Date.now() });
        timerId = setInterval(() => {
          if (closed) {
            clearInterval(timerId);
            return;
          }
          try {
            push(controller, "queue", queueStats(db));
            if (scheduler) {
              push(
                controller,
                "workers",
                scheduler.workerStatuses().map((w) => ({ repo: w.repoKey, busy: w.busy })),
              );
            }
          } catch {
            closed = true;
            clearInterval(timerId);
          }
        }, 3000);
      },
      cancel() {
        closed = true;
        if (timerId) clearInterval(timerId);
      },
    });
    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });

  app.get("/api/active-prs", async (c) => {
    return c.json(await fetchActivePrs(db, getConfig()));
  });

  app.get("/api/active-prs/:taskId/awaiting", async (c) => {
    const taskId = Number(c.req.param("taskId"));
    if (!Number.isFinite(taskId)) return c.html("?", 400);
    const config = getConfig();
    const list = await fetchActivePrs(db, config).catch(() => [] as ActivePr[]);
    const found = list.find((p) => p.taskId === taskId);
    if (!found) return c.html("<span class='text-muted'>idle</span>");
    return c.html(prAwaitingLabel(found).value);
  });

  app.post("/api/active-prs/:taskId/trigger", (c) => {
    const taskId = Number(c.req.param("taskId"));
    if (!Number.isFinite(taskId)) return c.html(flash("error", "bad taskId"), 400);
    enqueue(db, taskId, "high", null);
    return c.html(
      flash("ok", `Task #${taskId} enqueued with high priority — drain interval ~30s.`),
    );
  });

  app.post("/api/blocked-patches/:taskId/retry", (c) => {
    const taskId = Number(c.req.param("taskId"));
    if (!Number.isFinite(taskId)) return c.html(flash("error", "bad taskId"), 400);
    db.prepare(
      `UPDATE pr_branches SET status = 'cancelled', updated_at = datetime('now')
       WHERE task_id = ? AND status = 'guardrail_blocked'`,
    ).run(taskId);
    enqueue(db, taskId, "high", null);
    return c.html(flash("ok", `Task #${taskId} unblocked and re-enqueued — drain interval ~30s.`));
  });

  // PR drawer: returns an HTML fragment with detail for one active PR.
  // Loaded via fetch() from the client-side PR drawer JS in layout.ts.
  app.get("/api/active-prs/:taskId/drawer", (c) => {
    const taskId = Number(c.req.param("taskId"));
    if (!Number.isFinite(taskId)) return c.html("", 400);
    const branch = db.prepare("SELECT * FROM pr_branches WHERE task_id = ?").get(taskId) as
      | {
          task_id: number;
          branch: string;
          pr_number: number | null;
          pr_url: string | null;
          status: string;
          iterations: number;
          last_error: string | null;
          created_at: string;
          updated_at: string | null;
        }
      | undefined;
    if (!branch)
      return c.html(`<p class="p-4 text-muted text-sm">No PR branch for task #${taskId}</p>`);
    const task = db
      .prepare(
        `SELECT t.id, t.external_id, t.kind, r.owner, r.name AS repo_name
         FROM tasks t JOIN repos r ON r.id = t.repo_id WHERE t.id = ?`,
      )
      .get(taskId) as
      | { id: number; external_id: string; kind: string; owner: string; repo_name: string }
      | undefined;
    if (!task) return c.html(`<p class="p-4 text-muted text-sm">Task not found</p>`);
    const runs = getRunsByTask(db, taskId);
    const totalCost = runs.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
    const laneOrder = ["analyze", "review", "patch", "pr_dialog", "auto_merge"];
    const laneRuns = laneOrder
      .map((lane) => ({ lane, runs: runs.filter((r) => r.lane === lane) }))
      .filter((g) => g.runs.length > 0);
    const ghBase = `https://github.com/${task.owner}/${task.repo_name}`;
    const issueUrl =
      task.kind === "pull_request"
        ? `${ghBase}/pull/${task.external_id}`
        : `${ghBase}/issues/${task.external_id}`;
    const prUrl = branch.pr_url ?? (branch.pr_number ? `${ghBase}/pull/${branch.pr_number}` : null);
    const drawerBody = html`
      <div class="divide-y text-sm">
        <dl class="grid grid-cols-2 gap-x-3 gap-y-1.5 px-4 py-3 text-xs">
          <dt class="text-muted">Status</dt>
          <dd>
            <span class="${prStatusClass(branch.status)} px-1.5 py-0.5 rounded text-xs"
              >${branch.status}</span
            >
          </dd>
          <dt class="text-muted">Iterations</dt>
          <dd>${branch.iterations}</dd>
          <dt class="text-muted">Branch</dt>
          <dd class="font-mono truncate" title="${branch.branch}">${branch.branch}</dd>
          <dt class="text-muted">Total cost</dt>
          <dd class="font-mono">$${totalCost.toFixed(4)}</dd>
          <dt class="text-muted">Created</dt>
          <dd>${time(branch.created_at)}</dd>
          ${branch.last_error
            ? html`<dt class="text-muted text-red-600">Last error</dt>
                <dd class="text-red-700 col-span-1">${branch.last_error.slice(0, 200)}</dd>`
            : raw("")}
        </dl>
        <div class="px-4 py-3 flex flex-wrap gap-2">
          ${prUrl
            ? html`<a
                href="${prUrl}"
                target="_blank"
                class="text-xs bg-slate-800 text-white rounded px-3 py-1.5 hover:bg-slate-700"
                >View PR ↗</a
              >`
            : raw("")}
          <a
            href="${issueUrl}"
            target="_blank"
            class="text-xs bg-sunken text-primary rounded px-3 py-1.5 hover:bg-sunken"
            >Issue #${task.external_id} ↗</a
          >
          <a
            href="/admin/tasks/${taskId}"
            class="text-xs bg-sunken text-primary rounded px-3 py-1.5 hover:bg-sunken"
            >Task detail</a
          >
        </div>
        <div id="pr-drawer-flash-${taskId}" class="px-4"></div>
        <div class="px-4 py-3">
          <button
            hx-post="/admin/api/active-prs/${taskId}/trigger"
            hx-target="#pr-drawer-flash-${taskId}"
            hx-swap="innerHTML"
            class="text-xs bg-amber-600 hover:bg-amber-700 text-white rounded px-3 py-1.5"
          >
            ⚡ Trigger now
          </button>
        </div>
        <div class="px-4 py-3">
          <h4 class="text-xs font-semibold text-muted uppercase tracking-wide mb-2">
            Lane runs (${runs.length} total)
          </h4>
          ${laneRuns.map((g) => {
            const last = g.runs[g.runs.length - 1]!;
            const laneCost = g.runs.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
            return html`<div class="mb-2">
              <div class="flex items-center gap-2 mb-1">
                <span class="text-xs font-semibold">${g.lane}</span>
                <span class="${runStatusClass(last.status)} text-xs px-1 rounded"
                  >${last.status}</span
                >
                <span class="text-xs text-muted ml-auto">$${laneCost.toFixed(4)}</span>
              </div>
              ${g.runs.map(
                (r) => html`<div class="flex items-center gap-1.5 text-xs text-muted ml-2 py-0.5">
                  <span class="text-muted">#${r.id}</span>
                  <span>${r.engine}/${r.model ?? "?"}</span>
                  ${r.tokens_in != null
                    ? html`<span>${r.tokens_in}↑ ${r.tokens_out ?? 0}↓</span>`
                    : raw("")}
                  <span class="ml-auto">${time(r.started_at)}</span>
                </div>`,
              )}
            </div>`;
          })}
          ${laneRuns.length === 0 ? raw(`<p class="text-muted text-xs">No runs yet</p>`) : raw("")}
        </div>
      </div>
    `;
    return c.html(drawerBody.value);
  });

  // -------- HTML UI --------
  app.get("/", async (c) => {
    const config = getConfig();
    const repos = listRepos(db, { watchedOnly: true });
    const stats = queueStats(db);
    const activePrs = fetchActivePrsFromDb(db, config);
    const blockedPatches = listBlockedPatches(db);
    const jiraTasks = listPendingJiraTasks(db, 20);
    const todoistTasks = listPendingTodoistTasks(db, 20);
    const paused = isPaused(config.dataDir);
    // Custom join so the table can show repo name alongside each run.
    const recent = db
      .prepare(
        `SELECT ru.id, ru.task_id, ru.lane, ru.engine, ru.model, ru.status, ru.started_at,
                ru.tokens_in, ru.tokens_out, ru.cost_usd,
                r.owner, r.name AS repo_name
         FROM runs ru
         JOIN tasks t ON t.id = ru.task_id
         JOIN repos r ON r.id = t.repo_id
         ORDER BY ru.id DESC LIMIT 10`,
      )
      .all() as Array<{
      id: number;
      task_id: number;
      lane: string;
      engine: string;
      model: string | null;
      status: string;
      started_at: string;
      tokens_in: number | null;
      tokens_out: number | null;
      cost_usd: number | null;
      owner: string;
      repo_name: string;
    }>;
    // Show "clear rate-limit" button only when tasks are actually parked in cooldown.
    const rateLimitedCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM tasks
           WHERE last_error LIKE '%rate limit%' OR last_error LIKE '%RateLimited%'`,
        )
        .get() as { n: number }
    ).n;
    const body = html`
      ${paused
        ? html`<div
            class="mb-4 p-3 bg-yellow-100 border-l-4 border-yellow-500 text-yellow-800 font-semibold rounded"
          >
            ⏸ paused — mutations suspended. Remove <code>${config.dataDir}/.PAUSE</code> to resume.
          </div>`
        : raw("")}
      <div class="flex items-center justify-between mb-4">
        <h1 class="text-2xl font-semibold">Dashboard</h1>
        <div class="flex items-center gap-2">
          ${button({
            variant: "ghost",
            size: "sm",
            label: "⚡ kick pending",
            hxPost: "/admin/api/kick-first-pending",
            hxTarget: "#dash-flash",
            hxSwap: "innerHTML",
            hxIndicator: "#dash-busy",
            title:
              "Pull the next pending task (the one waiting the longest) into the head of the queue",
          })}
          ${button({
            variant: "ghost",
            size: "sm",
            label: "↻ reconcile now",
            hxPost: "/admin/api/reconcile-now",
            hxTarget: "#dash-flash",
            hxSwap: "innerHTML",
            hxIndicator: "#dash-busy",
            title: "Re-scan all watched repos for new items",
          })}
          ${button({
            variant: "ghost",
            size: "sm",
            label: "▶ drain now",
            hxPost: "/admin/api/drain-now",
            hxTarget: "#dash-flash",
            hxSwap: "innerHTML",
            hxIndicator: "#dash-busy",
            title: "Process whatever is due in the queue right now",
          })}
          ${rateLimitedCount > 0
            ? button({
                variant: "ghost",
                size: "sm",
                label: "🔓 clear rate-limit",
                hxPost: "/admin/api/clear-rate-limit",
                hxTarget: "#dash-flash",
                hxSwap: "innerHTML",
                hxIndicator: "#dash-busy",
                hxConfirm:
                  "Clear rate-limit cooldown on all parked tasks? They will be re-queued immediately.",
                title:
                  "Topped up Claude tokens? Clear the rate-limit cooldown on all parked tasks.",
              })
            : raw("")}
          <span id="dash-busy" class="htmx-indicator text-muted text-sm">…</span>
        </div>
      </div>
      <div id="dash-flash" class="mb-4"></div>

      <!-- Stat counters: 5-col at xl (≥1280px), 3+2 at md, 2-col at sm -->
      <section
        class="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3 mb-6"
        hx-get="/admin/api/queue-cards"
        hx-trigger="ai:refresh from:body"
        hx-swap="innerHTML"
      >
        ${statCard("pending", stats.pending, "slate", "/admin/tasks?status=pending")}
        ${statCard("due", stats.due, "yellow", "/admin/tasks?status=pending")}
        ${statCard("running", stats.running, "blue")}
        ${statCard("done", stats.done, "green", "/admin/tasks?status=done")}
        ${statCard(
          "error",
          stats.error,
          stats.error > 0 ? "red" : "slate",
          "/admin/tasks?status=error",
        )}
      </section>

      <!-- Workers + Watched repos: 2-col at lg+, stacked below -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <section>
          <h2 class="text-sm font-semibold uppercase tracking-wide text-muted mb-2">
            Workers (per repo)
          </h2>
          <div
            class="card card-bordered p-3"
            hx-get="/admin/api/workers"
            hx-trigger="load, ai:refresh from:body"
            hx-swap="innerHTML"
          >
            <div class="text-muted text-sm">loading…</div>
          </div>
        </section>

        <section>
          <h2 class="text-sm font-semibold uppercase tracking-wide text-muted mb-2">
            Watched repos (${repos.length})
          </h2>
          <div class="space-y-2">
            ${repos.length === 0
              ? html`<p class="text-muted text-sm">
                  <em>none yet — </em
                  ><a href="/admin/repos" class="text-brand hover:underline">add one</a>
                </p>`
              : repos.map((r) => {
                  let repoCfg: { lanes?: string[] } = {};
                  try {
                    repoCfg = JSON.parse(r.config_json) as { lanes?: string[] };
                  } catch {
                    // ignore
                  }
                  const lanes = repoCfg.lanes ?? ["triage"];
                  const isWatched = r.watched === 1;
                  return html`<a
                    href="/admin/repos/${r.id}"
                    class="card card-bordered flex flex-col gap-1.5 p-3 hover:shadow-md transition-shadow"
                    style="display:flex"
                  >
                    <div class="flex items-center gap-2">
                      <span class="text-xs text-muted font-mono">${r.provider}</span>
                      <span class="font-medium text-sm flex-1 min-w-0 truncate"
                        >${r.owner}/${r.name}</span
                      >
                      ${badge({
                        label: isWatched ? "watched" : "paused",
                        tone: isWatched ? "success" : "warning",
                      })}
                    </div>
                    <div class="flex flex-wrap gap-1">
                      ${lanes.map((lane) => html`<span class="bdg bdg-neutral">${lane}</span>`)}
                    </div>
                  </a>`;
                })}
          </div>
        </section>
      </div>

      ${recentErrorsPanel(db)}

      <!-- Recent runs: full-width table with sticky header -->
      <section class="mb-6">
        <div class="flex items-center justify-between mb-2">
          <h2 class="text-sm font-semibold uppercase tracking-wide text-muted">Recent runs</h2>
          <a href="/admin/logs" class="text-xs text-brand hover:underline">Show more →</a>
        </div>
        ${table({
          columns: [
            { key: "id", label: "#" },
            { key: "started", label: "Started", nowrap: true },
            { key: "repo", label: "Repo" },
            { key: "lane", label: "Lane" },
            { key: "engine", label: "Engine" },
            { key: "status", label: "Status" },
            { key: "tokens", label: "Tokens" },
            { key: "cost", label: "Cost" },
          ],
          rows: recent.map(
            (r) =>
              html`<tr
                class="hover:bg-surface cursor-pointer"
                onclick="location.href='/admin/tasks/${r.task_id}'"
              >
                <td class="px-3 py-2 text-xs text-muted">#${r.id}</td>
                <td class="px-3 py-2 text-xs text-muted whitespace-nowrap">
                  ${time(r.started_at)}
                </td>
                <td class="px-3 py-2 text-xs">${r.owner}/${r.repo_name}</td>
                <td class="px-3 py-2 text-xs">${r.lane}</td>
                <td class="px-3 py-2 text-xs text-muted">${r.engine}/${r.model ?? "?"}</td>
                <td class="px-3 py-2">
                  ${badge({ label: r.status, tone: runStatusTone(r.status) })}
                </td>
                <td class="px-3 py-2 text-xs text-muted">
                  ${r.tokens_in ?? "—"}/${r.tokens_out ?? "—"}
                </td>
                <td class="px-3 py-2 text-xs text-muted font-mono">
                  ${r.cost_usd != null ? "$" + r.cost_usd.toFixed(4) : "—"}
                </td>
              </tr>`,
          ),
          emptyMessage: "No runs yet.",
          maxHeight: "380px",
        })}
      </section>

      <section class="mt-8">
        <h2 class="text-lg font-semibold mb-2">Active PRs</h2>
        <p class="text-xs text-muted mb-3">
          PRs the agent is watching. ${activePrs.length === 0 ? raw("None — quiet.") : ""}
        </p>
        <div id="active-prs-flash" class="mb-3"></div>
        ${activePrs.length === 0
          ? raw("")
          : html`<table class="w-full text-sm bg-elevated border rounded shadow-sm">
              <thead class="bg-surface text-secondary text-left">
                <tr>
                  <th class="px-2 py-2">PR</th>
                  <th class="px-2 py-2">Status</th>
                  <th class="px-2 py-2">Iterations</th>
                  <th class="px-2 py-2">Last touched</th>
                  <th class="px-2 py-2">Awaiting</th>
                  <th class="px-2 py-2"></th>
                </tr>
              </thead>
              <tbody>
                ${activePrs.map(
                  (p) => html`
                    <tr
                      class="border-t hover:bg-surface cursor-pointer"
                      onclick="openPrDrawer(${p.taskId}, '${p.repo}#${p.prNumber}')"
                      title="Click to view PR details"
                    >
                      <td class="px-2 py-1.5">
                        <a
                          href="${p.url}"
                          target="_blank"
                          class="text-blue-700 hover:underline"
                          onclick="event.stopPropagation()"
                          >${p.repo}#${p.prNumber}</a
                        >
                        <span class="block text-xs text-muted">${p.title}</span>
                      </td>
                      <td class="px-2 py-1.5">
                        <span class="${prStatusClass(p.status)} px-1.5 py-0.5 rounded text-xs"
                          >${p.status}</span
                        >
                      </td>
                      <td class="px-2 py-1.5 text-xs">${p.iterations}/${p.maxIterations}</td>
                      <td class="px-2 py-1.5 text-xs text-muted">${p.lastTouched ?? "—"}</td>
                      <td
                        class="px-2 py-1.5 text-xs"
                        hx-get="/admin/api/active-prs/${p.taskId}/awaiting"
                        hx-trigger="load"
                        hx-swap="innerHTML"
                      >
                        <span class="text-muted">…</span>
                      </td>
                      <td class="px-2 py-1.5 text-right">
                        <button
                          hx-post="/admin/api/active-prs/${p.taskId}/trigger"
                          hx-target="#active-prs-flash"
                          class="px-2 py-1 text-xs bg-slate-800 text-white rounded hover:bg-slate-700"
                        >
                          Trigger now
                        </button>
                      </td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>`}
      </section>

      ${blockedPatches.length > 0
        ? html`<section class="mt-8">
            <h2 class="text-lg font-semibold mb-2 text-red-700">
              ⛔ Blocked patches (${blockedPatches.length})
            </h2>
            <p class="text-xs text-muted mb-3">
              Patch attempts blocked by guardrails. Fix the root cause, then click Override to
              retry.
            </p>
            <div id="blocked-patches-flash" class="mb-3"></div>
            <table class="w-full text-sm bg-elevated border rounded shadow-sm">
              <thead class="bg-surface text-secondary text-left">
                <tr>
                  <th class="px-2 py-2">Issue</th>
                  <th class="px-2 py-2">Branch</th>
                  <th class="px-2 py-2">Reason</th>
                  <th class="px-2 py-2">Since</th>
                  <th class="px-2 py-2"></th>
                </tr>
              </thead>
              <tbody>
                ${blockedPatches.map(
                  (b) => html`
                    <tr class="border-t">
                      <td class="px-2 py-1.5 text-xs">
                        ${b.owner}/${b.repo_name}#${b.external_id}
                      </td>
                      <td class="px-2 py-1.5 text-xs font-mono text-secondary">${b.branch}</td>
                      <td class="px-2 py-1.5 text-xs text-red-700">
                        ${b.last_error ? b.last_error.slice(0, 120) : "unknown"}
                      </td>
                      <td class="px-2 py-1.5 text-xs text-muted">
                        ${time(b.updated_at ?? b.created_at)}
                      </td>
                      <td class="px-2 py-1.5 text-right">
                        <button
                          hx-post="/admin/api/blocked-patches/${b.task_id}/retry"
                          hx-target="#blocked-patches-flash"
                          class="px-2 py-1 text-xs bg-red-700 text-white rounded hover:bg-red-800"
                        >
                          Override &amp; retry
                        </button>
                      </td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          </section>`
        : raw("")}

      <section class="mt-8">${deploySection(db, config)}</section>

      ${jiraTasks.length > 0
        ? html`<section class="mt-8">
            <h2 class="text-lg font-semibold mb-2">Pending Jira tasks (${jiraTasks.length})</h2>
            <table class="w-full text-sm bg-elevated border rounded shadow-sm">
              <thead class="bg-surface text-secondary text-left">
                <tr>
                  <th class="px-2 py-2">Issue</th>
                  <th class="px-2 py-2">Repo</th>
                  <th class="px-2 py-2">Status</th>
                  <th class="px-2 py-2">Last run</th>
                  <th class="px-2 py-2">Error</th>
                </tr>
              </thead>
              <tbody>
                ${jiraTasks.map(
                  (t) =>
                    html`<tr class="border-t">
                      <td class="px-2 py-1.5 font-mono text-sm">${t.external_id}</td>
                      <td class="px-2 py-1.5 text-xs text-muted">${t.owner}/${t.repo_name}</td>
                      <td class="px-2 py-1.5">
                        <span class="${taskStatusClass(t.status)} px-1.5 py-0.5 rounded text-xs"
                          >${t.status}</span
                        >
                      </td>
                      <td class="px-2 py-1.5 text-xs text-muted">${time(t.last_run_at)}</td>
                      <td
                        class="px-2 py-1.5 text-xs ${t.last_error ? "text-red-700" : "text-muted"}"
                      >
                        ${t.last_error ? t.last_error.slice(0, 80) : ""}
                      </td>
                    </tr>`,
                )}
              </tbody>
            </table>
          </section>`
        : raw("")}
      ${todoistTasks.length > 0
        ? html`<section class="mt-8">
            <h2 class="text-lg font-semibold mb-2">
              Pending Todoist tasks (${todoistTasks.length})
            </h2>
            <table class="w-full text-sm bg-elevated border rounded shadow-sm">
              <thead class="bg-surface text-secondary text-left">
                <tr>
                  <th class="px-2 py-2">Task ID</th>
                  <th class="px-2 py-2">Repo</th>
                  <th class="px-2 py-2">Status</th>
                  <th class="px-2 py-2">Last run</th>
                  <th class="px-2 py-2">Error</th>
                </tr>
              </thead>
              <tbody>
                ${todoistTasks.map(
                  (t) =>
                    html`<tr class="border-t">
                      <td class="px-2 py-1.5 font-mono text-sm">${t.external_id}</td>
                      <td class="px-2 py-1.5 text-xs text-muted">${t.owner}/${t.repo_name}</td>
                      <td class="px-2 py-1.5">
                        <span class="${taskStatusClass(t.status)} px-1.5 py-0.5 rounded text-xs"
                          >${t.status}</span
                        >
                      </td>
                      <td class="px-2 py-1.5 text-xs text-muted">${time(t.last_run_at)}</td>
                      <td
                        class="px-2 py-1.5 text-xs ${t.last_error ? "text-red-700" : "text-muted"}"
                      >
                        ${t.last_error ? t.last_error.slice(0, 80) : ""}
                      </td>
                    </tr>`,
                )}
              </tbody>
            </table>
          </section>`
        : raw("")}

      <p class="text-xs text-muted mt-6">
        dataDir: <code>${config.dataDir}</code> &middot; baseUrl:
        <code>${config.global.server.baseUrl}</code>
      </p>
    `;
    return c.html(
      page({ title: "Dashboard", section: "dashboard", body, isHtmx: isHtmx(c.req.raw.headers) }),
    );
  });

  // -------- Repos --------
  app.get("/repos", (c) => {
    const rows = listRepos(db, { watchedOnly: false });
    const list: TrustedHtml | TrustedHtml[] =
      rows.length === 0
        ? raw("<tr><td colspan=3 class='py-3 text-muted'><em>no repos yet</em></td></tr>")
        : rows.map(
            (r) => html`
              <tr class="border-t hover:bg-surface">
                <td class="py-2">
                  <a href="/admin/repos/${r.id}" class="text-blue-700 hover:underline"
                    >${r.provider}:${r.owner}/${r.name}</a
                  >
                </td>
                <td class="py-2">
                  ${r.watched
                    ? raw("<span class='text-green-700'>watched</span>")
                    : raw("<span class='text-muted'>archived</span>")}
                </td>
                <td class="py-2 text-right">
                  <button
                    hx-post="/admin/api/repos/${r.id}/connect-webhook"
                    hx-confirm="Register a webhook on ${r.owner}/${r.name}?"
                    hx-target="#flash"
                    class="px-2 py-1 text-xs bg-slate-800 text-white rounded hover:bg-slate-700"
                  >
                    Connect webhook
                  </button>
                </td>
              </tr>
            `,
          );
    const body = html`
      <h1 class="text-2xl font-semibold mb-4">Repos</h1>
      <div id="flash" class="mb-3"></div>

      <section class="bg-elevated rounded shadow-sm border p-4 mb-6">
        <h2 class="font-medium mb-3">Add a repo</h2>
        <form
          hx-post="/admin/repos"
          hx-target="body"
          hx-push-url="true"
          class="grid grid-cols-4 gap-3 items-end"
        >
          <label class="text-sm"
            >Provider
            <select name="provider" class="block w-full border rounded px-2 py-1.5 mt-1">
              <option value="github" selected>github</option>
            </select>
          </label>
          <label class="text-sm"
            >Owner
            <input
              name="owner"
              required
              class="block w-full border rounded px-2 py-1.5 mt-1"
              placeholder="acme"
            />
          </label>
          <label class="text-sm"
            >Name
            <input
              name="name"
              required
              class="block w-full border rounded px-2 py-1.5 mt-1"
              placeholder="someproject"
            />
          </label>
          <button class="bg-slate-900 text-white rounded px-4 py-2 text-sm">Add</button>
        </form>
      </section>

      <section class="bg-elevated rounded shadow-sm border">
        <table class="w-full text-sm">
          <thead class="bg-surface text-secondary text-left">
            <tr>
              <th class="px-3 py-2">Repo</th>
              <th class="px-3 py-2">Status</th>
              <th class="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${list}
          </tbody>
        </table>
      </section>
    `;
    return c.html(
      page({ title: "Repos", section: "repos", body, isHtmx: isHtmx(c.req.raw.headers) }),
    );
  });

  app.post("/repos", async (c) => {
    const form = await c.req.parseBody();
    try {
      const repo = RepoConfigSchema.parse({
        provider: String(form.provider ?? "github"),
        owner: String(form.owner ?? "").trim(),
        name: String(form.name ?? "").trim(),
      });
      const path = resolve(getConfig().dataDir, "config", "repos", repoConfigFilename(repo));
      if (existsSync(path)) {
        return c.html(flash("error", `Repo config already exists: ${path}`), 400);
      }
      writeFileSync(path, YAML.stringify(repo), { mode: 0o600 });
      // fs.watch will resync, but force-sync now so the redirect sees it.
      const fresh = reloadConfig(getConfig());
      syncReposFromConfig(db, fresh.repos);
      return c.redirect("/admin/repos");
    } catch (error) {
      return c.html(
        flash("error", `Failed to add: ${error instanceof Error ? error.message : String(error)}`),
        400,
      );
    }
  });

  app.get("/repos/:id", (c) => {
    const id = Number(c.req.param("id"));
    const row = listRepos(db, { watchedOnly: false }).find((r) => r.id === id);
    if (!row) return c.notFound();
    const yamlPath = resolve(
      getConfig().dataDir,
      "config",
      "repos",
      repoConfigFilename({
        provider: row.provider as "github" | "gitlab" | "gitea",
        owner: row.owner,
        name: row.name,
      }),
    );
    const yamlText = existsSync(yamlPath)
      ? readFileSync(yamlPath, "utf8")
      : YAML.stringify({ provider: row.provider, owner: row.owner, name: row.name });

    // Parse config for lanes and deploy mode (best-effort).
    let parsedCfg: { lanes?: string[]; deploy?: { mode?: string; commands?: string[] } } = {};
    try {
      parsedCfg = YAML.parse(yamlText) as typeof parsedCfg;
    } catch {
      // leave empty
    }
    const configuredLanes: string[] = parsedCfg.lanes ?? ["triage"];
    const deployMode = parsedCfg.deploy?.mode ?? "disabled";
    const deployCmds: string[] = parsedCfg.deploy?.commands ?? [];

    // Last 5 runs per lane for sparkline dots.
    const laneRunsRaw = db
      .prepare(
        `SELECT ru.id, ru.lane, ru.status
         FROM runs ru JOIN tasks t ON t.id = ru.task_id
         WHERE t.repo_id = ? ORDER BY ru.id DESC LIMIT 100`,
      )
      .all(id) as Array<{ id: number; lane: string; status: string }>;
    const laneRunsMap: Record<string, Array<{ status: string }>> = {};
    for (const r of laneRunsRaw) {
      if (!laneRunsMap[r.lane]) laneRunsMap[r.lane] = [];
      if (laneRunsMap[r.lane]!.length < 5) laneRunsMap[r.lane]!.push({ status: r.status });
    }

    // Last-run timestamp per lane.
    const laneLastRunRaw = db
      .prepare(
        `SELECT ru.lane, MAX(ru.started_at) AS last_run
         FROM runs ru JOIN tasks t ON t.id = ru.task_id
         WHERE t.repo_id = ? GROUP BY ru.lane`,
      )
      .all(id) as Array<{ lane: string; last_run: string }>;
    const laneLastRun = Object.fromEntries(laneLastRunRaw.map((r) => [r.lane, r.last_run]));

    // Recent deploys for the Deployment card.
    const recentDeploys = db
      .prepare(
        `SELECT id, sha, branch, triggered_by, status, started_at, finished_at, error
         FROM deploys WHERE repo_id = ? ORDER BY id DESC LIMIT 10`,
      )
      .all(id) as Array<{
      id: number;
      sha: string;
      branch: string;
      triggered_by: string;
      status: string;
      started_at: string;
      finished_at: string | null;
      error: string | null;
    }>;

    const isWatched = row.watched === 1;
    const ghUrl = `https://github.com/${row.owner}/${row.name}`;

    const body = html`
      <div id="flash" class="mb-4"></div>

      <!-- 1. Header card -->
      ${card({
        body: html`
          <div class="flex flex-col sm:flex-row sm:items-start gap-4">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 mb-1">
                <span class="text-xs text-muted font-mono">${row.provider}</span>
                ${badge({
                  label: isWatched ? "watched" : "paused",
                  tone: isWatched ? "success" : "warning",
                })}
              </div>
              <h1 class="text-2xl font-semibold truncate">${row.owner}/${row.name}</h1>
              <div class="flex flex-wrap gap-1 mt-2">
                ${configuredLanes.map((lane) => html`<span class="bdg bdg-neutral">${lane}</span>`)}
              </div>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              ${isWatched
                ? button({
                    variant: "ghost",
                    size: "sm",
                    label: "⏸ Pause repo",
                    hxPost: `/admin/api/repos/${id}/pause`,
                    hxTarget: "#flash",
                    hxSwap: "innerHTML",
                    hxConfirm: `Pause ${row.owner}/${row.name}? The scheduler will stop picking up tasks for it.`,
                    title: "Stop the scheduler from processing this repo",
                  })
                : button({
                    variant: "ghost",
                    size: "sm",
                    label: "▶ Resume repo",
                    hxPost: `/admin/api/repos/${id}/resume`,
                    hxTarget: "#flash",
                    hxSwap: "innerHTML",
                    title: "Resume scheduler processing for this repo",
                  })}
              ${button({
                variant: "ghost",
                size: "sm",
                label: "↻ Sync now",
                hxPost: "/admin/api/reconcile-now",
                hxTarget: "#flash",
                hxSwap: "innerHTML",
                title: "Re-scan all watched repos (including this one) for new items",
              })}
              <a
                href="${ghUrl}"
                target="_blank"
                rel="noopener noreferrer"
                class="btn btn-ghost btn-sm"
                title="Open on GitHub"
                >↗ GitHub</a
              >
            </div>
          </div>
        `,
        variant: "bordered",
        padding: "lg",
      })}

      <!-- 2. Configuration card -->
      <div class="mt-6">
        ${card({
          title: "Configuration (YAML)",
          body: html`
            <p class="text-xs text-muted mb-3">
              Saves to <code class="code-inline">${yamlPath}</code> and triggers config reload.
            </p>
            <form hx-post="/admin/repos/${id}" hx-target="#flash" id="repo-config-form">
              ${yamlEditor({ name: "yaml", value: yamlText, rows: 20 })}
              <div class="mt-4 flex items-center gap-2 flex-wrap">
                ${button({
                  label: "Save",
                  variant: "primary",
                  size: "md",
                  type: "submit",
                  hxIndicator: "#config-busy",
                  title: "Save YAML and reload config",
                })}
                <span id="config-busy" class="htmx-indicator text-muted text-sm">saving…</span>
                <div class="ml-auto flex items-center gap-2 flex-wrap">
                  ${button({
                    label: "Connect webhook",
                    variant: "ghost",
                    size: "sm",
                    hxPost: `/admin/api/repos/${id}/connect-webhook`,
                    hxTarget: "#flash",
                    title:
                      "Auto: creates a webhook via the GitHub API. Requires admin permission on the repo.",
                  })}
                  ${button({
                    label: "Show webhook info",
                    variant: "ghost",
                    size: "sm",
                    hxGet: `/admin/api/repos/${id}/webhook-info`,
                    hxTarget: "#webhook-info",
                    hxSwap: "innerHTML",
                    title: "Manual setup: copy these values into GitHub → Settings → Webhooks",
                  })}
                  ${button({
                    label: "Create labels",
                    variant: "ghost",
                    size: "sm",
                    hxPost: `/admin/api/repos/${id}/ensure-labels`,
                    hxTarget: "#flash",
                    title:
                      "Verify the agent's trigger / in-progress labels exist; create them if missing",
                  })}
                  ${button({
                    label: "Show label info",
                    variant: "ghost",
                    size: "sm",
                    hxGet: `/admin/api/repos/${id}/labels-info`,
                    hxTarget: "#labels-info",
                    hxSwap: "innerHTML",
                    title: "Manual label setup for repos where the bot lacks write access",
                  })}
                </div>
              </div>
              <div id="webhook-info" class="mt-3"></div>
              <div id="labels-info" class="mt-3"></div>
            </form>
          `,
          variant: "bordered",
        })}
      </div>

      <!-- 3. Deployment card (only when deploy.mode != disabled) -->
      ${deployMode !== "disabled"
        ? html`<div class="mt-6">
            ${card({
              title: "Deployment",
              actions: html`
                ${button({
                  label: "▶ Deploy now",
                  variant: "primary",
                  size: "sm",
                  hxPost: `/admin/api/repos/${id}/deploy-now`,
                  hxTarget: "#flash",
                  hxIndicator: "#deploy-busy",
                  hxConfirm: "Run deploy commands now? This will execute on the configured target.",
                  title: "Run the configured deploy commands now (skips the push-webhook check)",
                })}
                <span id="deploy-busy" class="htmx-indicator text-muted text-sm">…</span>
              `,
              body: html`
                ${recentDeploys.length > 0
                  ? html`<div class="mb-4">
                      ${table({
                        columns: [
                          { key: "sha", label: "SHA" },
                          { key: "branch", label: "Branch" },
                          { key: "by", label: "Triggered by" },
                          { key: "dur", label: "Duration" },
                          { key: "status", label: "Status" },
                          { key: "started", label: "Started", nowrap: true },
                        ],
                        rows: recentDeploys.map((d) => {
                          const norm = (ts: string) =>
                            ts.replace(" ", "T") + (/[zZ]$/.test(ts) ? "" : "Z");
                          const dur =
                            d.started_at && d.finished_at
                              ? (
                                  (new Date(norm(d.finished_at)).getTime() -
                                    new Date(norm(d.started_at)).getTime()) /
                                  1000
                                ).toFixed(0) + "s"
                              : "—";
                          const depTone =
                            d.status === "ok"
                              ? "success"
                              : d.status === "running"
                                ? "info"
                                : "danger";
                          return html`<tr>
                            <td class="px-3 py-2 font-mono text-xs">${d.sha.slice(0, 8)}</td>
                            <td class="px-3 py-2 text-xs">${d.branch}</td>
                            <td class="px-3 py-2 text-xs text-muted">${d.triggered_by}</td>
                            <td class="px-3 py-2 text-xs text-muted">${dur}</td>
                            <td class="px-3 py-2">
                              ${badge({ label: d.status, tone: depTone as BadgeTone })}
                            </td>
                            <td class="px-3 py-2 text-xs text-muted">${time(d.started_at)}</td>
                          </tr>`;
                        }),
                        emptyMessage: "No deploys yet.",
                        maxHeight: "260px",
                      })}
                    </div>`
                  : html`<p class="text-muted text-sm mb-4">No deploys yet.</p>`}
                ${deployCmds.length > 0
                  ? html`<div>
                      <div class="text-xs font-medium text-muted uppercase tracking-wide mb-1">
                        Deploy commands (read-only — edit in YAML above)
                      </div>
                      <div class="code-block-wrap">
                        <pre class="code-block">${deployCmds.join("\n")}</pre>
                      </div>
                    </div>`
                  : raw("")}
                <div class="mt-4 flex gap-2 flex-wrap">
                  ${button({
                    label: "Show SSH public key",
                    variant: "ghost",
                    size: "sm",
                    hxGet: "/admin/api/deploy/ssh-public-key",
                    hxTarget: "#deploy-info",
                    hxSwap: "innerHTML",
                    title: "Bot's SSH public key for ~/.ssh/authorized_keys on the deploy target",
                  })}
                  ${button({
                    label: "Show config example",
                    variant: "ghost",
                    size: "sm",
                    hxGet: "/admin/api/deploy/config-example",
                    hxTarget: "#deploy-info",
                    hxSwap: "innerHTML",
                    title: "Annotated YAML examples for local + ssh deploy modes",
                  })}
                </div>
                <div id="deploy-info" class="mt-3"></div>
              `,
              variant: "bordered",
            })}
          </div>`
        : raw("")}

      <!-- 4. Lanes card -->
      <div class="mt-6">
        ${card({
          title: "Lanes",
          body: html`
            <ul class="divide-y">
              ${configuredLanes.map((lane) => {
                const lastRun = laneLastRun[lane];
                const dots = laneRunsMap[lane] ?? [];
                const sparkline = dots.map((r) => {
                  const color =
                    r.status === "ok"
                      ? "var(--status-success-fg)"
                      : r.status === "error"
                        ? "var(--status-danger-fg)"
                        : "var(--fg-muted)";
                  return `<span style="color:${color}" title="${escapeHtml(r.status)}">●</span>`;
                });
                return html`<li class="flex items-center gap-3 py-2.5">
                  <span class="text-sm font-medium w-32 shrink-0">${lane}</span>
                  <div class="flex gap-0.5 text-xs font-mono">${raw(sparkline.join(""))}</div>
                  <span class="ml-auto text-xs text-muted">
                    ${lastRun
                      ? html`<time data-ts="${lastRun}">${lastRun}</time>`
                      : raw("never run")}
                  </span>
                  <a
                    href="/admin/logs?lane=${lane}"
                    class="btn btn-ghost btn-sm px-2"
                    title="View runs for this lane"
                    >→</a
                  >
                </li>`;
              })}
            </ul>
          `,
          variant: "bordered",
        })}
      </div>

      <!-- Run review (advanced / debug tool, kept at bottom) -->
      <div class="mt-6">
        ${card({
          title: "Run review now",
          body: html`
            <form
              hx-post="/admin/api/repos/${id}/review-now"
              hx-target="#flash"
              class="flex gap-3 items-end flex-wrap"
            >
              <label class="text-sm form-field">
                <span class="form-label">Item number</span>
                <input name="number" type="number" min="1" required class="form-input w-28" />
              </label>
              <label class="text-sm form-field">
                <span class="form-label">Engine override</span>
                <select name="engine" class="form-select">
                  <option value="">(use default)</option>
                  <option value="mimo">mimo</option>
                  <option value="claude_code">claude_code</option>
                </select>
              </label>
              <label class="text-sm form-field">
                <span class="form-label">Model override</span>
                <input name="model" class="form-input w-36" placeholder="(default)" />
              </label>
              ${button({ label: "Review", variant: "secondary", size: "md", type: "submit" })}
            </form>
          `,
          variant: "bordered",
        })}
      </div>
    `;
    return c.html(
      page({
        title: row.name,
        section: "repos",
        body,
        isHtmx: isHtmx(c.req.raw.headers),
        breadcrumb: [
          { label: "Repos", href: "/admin/repos" },
          { label: `${row.owner}/${row.name}` },
        ],
        tabs: [
          { label: "Config", href: `/admin/repos/${id}`, active: true },
          { label: "Dashboard", href: `/admin/repos/${id}/dashboard` },
          { label: "Deploys", href: `/admin/repos/${id}/deploys` },
        ],
      }),
    );
  });

  // Per-repo dashboard: queue stats, recent runs, active PRs, cost, deploys.
  app.get("/repos/:id/dashboard", (c) => {
    const id = Number(c.req.param("id"));
    const row = listRepos(db, { watchedOnly: false }).find((r) => r.id === id);
    if (!row) return c.notFound();
    const repoStats = db
      .prepare(
        `SELECT
          SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running,
          SUM(CASE WHEN status='error'   THEN 1 ELSE 0 END) AS err,
          SUM(CASE WHEN status='done'    THEN 1 ELSE 0 END) AS done
         FROM tasks WHERE repo_id = ?`,
      )
      .get(id) as { pending: number; running: number; err: number; done: number } | undefined;
    const cost24h =
      (
        db
          .prepare(
            `SELECT COALESCE(SUM(ru.cost_usd), 0) AS total
           FROM runs ru JOIN tasks t ON t.id = ru.task_id
           WHERE t.repo_id = ? AND ru.started_at >= datetime('now', '-24 hours')`,
          )
          .get(id) as { total: number } | undefined
      )?.total ?? 0;
    const recentRuns = db
      .prepare(
        `SELECT ru.id, ru.lane, ru.engine, ru.model, ru.status, ru.started_at, ru.cost_usd,
                t.external_id
         FROM runs ru JOIN tasks t ON t.id = ru.task_id
         WHERE t.repo_id = ? ORDER BY ru.id DESC LIMIT 10`,
      )
      .all(id) as Array<{
      id: number;
      lane: string;
      engine: string;
      model: string | null;
      status: string;
      started_at: string;
      cost_usd: number | null;
      external_id: string;
    }>;
    const activePrBranches = db
      .prepare(
        `SELECT pb.task_id, pb.pr_number, pb.pr_url, pb.status, pb.iterations
         FROM pr_branches pb JOIN tasks t ON t.id = pb.task_id
         WHERE t.repo_id = ? AND pb.status != 'closed'`,
      )
      .all(id) as Array<{
      task_id: number;
      pr_number: number | null;
      pr_url: string | null;
      status: string;
      iterations: number;
    }>;
    const deploys = db
      .prepare(
        "SELECT id, sha, branch, status, started_at, finished_at, error FROM deploys WHERE repo_id = ? ORDER BY id DESC LIMIT 5",
      )
      .all(id) as Array<{
      id: number;
      sha: string;
      branch: string;
      status: string;
      started_at: string;
      finished_at: string | null;
      error: string | null;
    }>;
    const body = html`
      <h1 class="text-2xl font-semibold mb-6">${row.owner}/${row.name} · Dashboard</h1>

      <div class="grid grid-cols-4 gap-3 mb-6">
        ${statCard("pending", repoStats?.pending ?? 0)}
        ${statCard("running", repoStats?.running ?? 0, "blue")}
        ${statCard("error", repoStats?.err ?? 0, (repoStats?.err ?? 0) > 0 ? "red" : "slate")}
        ${statCard("done", repoStats?.done ?? 0, "green")}
      </div>

      <div class="grid grid-cols-2 gap-6 mb-6">
        <section class="bg-elevated rounded shadow-sm border p-4">
          <div class="flex items-center justify-between mb-3">
            <h2 class="font-semibold text-sm">Recent runs</h2>
            <span class="text-xs text-muted">cost 24h: $${cost24h.toFixed(4)}</span>
          </div>
          <table class="w-full text-xs">
            <tbody>
              ${recentRuns.length === 0
                ? raw(`<tr><td class="py-2 text-muted">No runs yet</td></tr>`)
                : recentRuns.map(
                    (r) => html`<tr class="border-t">
                      <td class="py-1 text-muted">#${r.id}</td>
                      <td class="py-1">${r.lane}</td>
                      <td class="py-1">
                        <span class="${runStatusClass(r.status)} px-1 rounded">${r.status}</span>
                      </td>
                      <td class="py-1 text-muted">${time(r.started_at)}</td>
                      <td class="py-1 text-muted">
                        ${r.cost_usd != null ? "$" + r.cost_usd.toFixed(4) : "—"}
                      </td>
                    </tr>`,
                  )}
            </tbody>
          </table>
        </section>

        <div class="space-y-4">
          <section class="bg-elevated rounded shadow-sm border p-4">
            <div class="flex items-center justify-between mb-2">
              <h2 class="font-semibold text-sm">Active PRs (${activePrBranches.length})</h2>
            </div>
            ${activePrBranches.length === 0
              ? raw(`<p class="text-muted text-xs">None</p>`)
              : html`<ul class="space-y-1">
                  ${activePrBranches.map(
                    (b) => html`<li class="text-xs flex items-center gap-2">
                      ${b.pr_url
                        ? html`<a
                            href="${b.pr_url}"
                            target="_blank"
                            class="text-blue-700 hover:underline"
                            >PR #${b.pr_number}</a
                          >`
                        : html`<span>PR #${b.pr_number ?? "?"}</span>`}
                      <span class="${prStatusClass(b.status)} px-1.5 rounded">${b.status}</span>
                      <span class="text-muted">${b.iterations} iter</span>
                      <button
                        onclick="openPrDrawer(${b.task_id}, 'PR #${b.pr_number}')"
                        class="ml-auto text-xs text-blue-600 hover:underline"
                      >
                        details
                      </button>
                    </li>`,
                  )}
                </ul>`}
          </section>

          <section class="bg-elevated rounded shadow-sm border p-4">
            <div class="flex items-center justify-between mb-2">
              <h2 class="font-semibold text-sm">Recent deploys</h2>
              <a href="/admin/repos/${id}/deploys" class="text-xs text-blue-700 hover:underline"
                >all →</a
              >
            </div>
            ${deploys.length === 0
              ? raw(`<p class="text-muted text-xs">No deploys yet</p>`)
              : html`<table class="w-full text-xs">
                  <tbody>
                    ${deploys.map(
                      (d) => html`<tr class="border-t">
                        <td class="py-1 font-mono">${d.sha.slice(0, 8)}</td>
                        <td class="py-1">
                          <span
                            class="${d.status === "ok"
                              ? "badge-success"
                              : d.status === "running"
                                ? "badge-info"
                                : "badge-danger"} px-1 rounded"
                            >${d.status}</span
                          >
                        </td>
                        <td class="py-1 text-muted">${time(d.started_at)}</td>
                        ${d.status === "error"
                          ? html`<td class="py-1 text-red-600 max-w-xs truncate">
                              ${d.error ?? ""}
                            </td>`
                          : raw("<td></td>")}
                      </tr>`,
                    )}
                  </tbody>
                </table>`}
          </section>
        </div>
      </div>
    `;
    return c.html(
      page({
        title: `${row.name} dashboard`,
        section: "repos",
        body,
        isHtmx: isHtmx(c.req.raw.headers),
        breadcrumb: [
          { label: "Repos", href: "/admin/repos" },
          { label: `${row.owner}/${row.name}` },
        ],
        tabs: [
          { label: "Config", href: `/admin/repos/${id}` },
          { label: "Dashboard", href: `/admin/repos/${id}/dashboard`, active: true },
          { label: "Deploys", href: `/admin/repos/${id}/deploys` },
        ],
      }),
    );
  });

  // Per-repo deploy history page.
  app.get("/repos/:id/deploys", (c) => {
    const id = Number(c.req.param("id"));
    const row = listRepos(db, { watchedOnly: false }).find((r) => r.id === id);
    if (!row) return c.notFound();
    const deploys = db
      .prepare(
        `SELECT id, sha, branch, triggered_by, status, started_at, finished_at, error
         FROM deploys WHERE repo_id = ? ORDER BY id DESC LIMIT 50`,
      )
      .all(id) as Array<{
      id: number;
      sha: string;
      branch: string;
      triggered_by: string;
      status: string;
      started_at: string;
      finished_at: string | null;
      error: string | null;
    }>;
    const body = html`
      <h1 class="text-2xl font-semibold mb-4">${row.owner}/${row.name} · Deploys</h1>
      <section class="bg-elevated rounded shadow-sm border">
        <table class="w-full text-sm">
          <thead class="bg-surface text-secondary text-left text-xs">
            <tr>
              <th class="px-3 py-2">SHA</th>
              <th class="px-3 py-2">Branch</th>
              <th class="px-3 py-2">Triggered by</th>
              <th class="px-3 py-2">Status</th>
              <th class="px-3 py-2">Started</th>
              <th class="px-3 py-2">Duration</th>
              <th class="px-3 py-2">Error</th>
            </tr>
          </thead>
          <tbody>
            ${deploys.length === 0
              ? raw(
                  "<tr><td colspan=7 class='py-4 text-muted text-center text-sm'>No deploys yet</td></tr>",
                )
              : deploys.map((d) => {
                  const norm = (ts: string) => ts.replace(" ", "T") + (/[zZ]$/.test(ts) ? "" : "Z");
                  const dur =
                    d.started_at && d.finished_at
                      ? (
                          (new Date(norm(d.finished_at)).getTime() -
                            new Date(norm(d.started_at)).getTime()) /
                          1000
                        ).toFixed(0) + "s"
                      : "—";
                  return html`<tr class="border-t">
                    <td class="px-3 py-2 font-mono text-xs">${d.sha.slice(0, 8)}</td>
                    <td class="px-3 py-2 text-xs">${d.branch}</td>
                    <td class="px-3 py-2 text-xs text-muted">${d.triggered_by}</td>
                    <td class="px-3 py-2">
                      <span
                        class="${d.status === "ok"
                          ? "badge-success"
                          : d.status === "running"
                            ? "badge-info"
                            : "badge-danger"} px-1.5 py-0.5 rounded text-xs"
                        >${d.status}</span
                      >
                    </td>
                    <td class="px-3 py-2 text-xs">${time(d.started_at)}</td>
                    <td class="px-3 py-2 text-xs text-muted">${dur}</td>
                    <td class="px-3 py-2 text-xs text-red-700 max-w-xs truncate">
                      ${d.error ?? ""}
                    </td>
                  </tr>`;
                })}
          </tbody>
        </table>
      </section>
    `;
    return c.html(
      page({
        title: `${row.name} deploys`,
        section: "repos",
        body,
        isHtmx: isHtmx(c.req.raw.headers),
        breadcrumb: [
          { label: "Repos", href: "/admin/repos" },
          { label: `${row.owner}/${row.name}` },
        ],
        tabs: [
          { label: "Config", href: `/admin/repos/${id}` },
          { label: "Dashboard", href: `/admin/repos/${id}/dashboard` },
          { label: "Deploys", href: `/admin/repos/${id}/deploys`, active: true },
        ],
      }),
    );
  });

  app.post("/repos/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const row = listRepos(db, { watchedOnly: false }).find((r) => r.id === id);
    if (!row) return c.notFound();
    const form = await c.req.parseBody();
    const yamlText = String(form.yaml ?? "");
    let parsed: unknown;
    try {
      parsed = YAML.parse(yamlText);
      RepoConfigSchema.parse(parsed);
    } catch (error) {
      return c.html(
        flash("error", `Invalid YAML: ${error instanceof Error ? error.message : String(error)}`),
        400,
      );
    }
    const yamlPath = resolve(
      getConfig().dataDir,
      "config",
      "repos",
      repoConfigFilename({
        provider: row.provider as "github" | "gitlab" | "gitea",
        owner: row.owner,
        name: row.name,
      }),
    );
    writeFileSync(yamlPath, yamlText, { mode: 0o600 });
    return c.html(flash("ok", `Saved ${yamlPath} — reload picked up automatically.`));
  });

  // Pause a repo: set watched=0 so the scheduler skips it.
  app.post("/api/repos/:id/pause", (c) => {
    const id = Number(c.req.param("id"));
    const row = listRepos(db, { watchedOnly: false }).find((r) => r.id === id);
    if (!row) return c.html(flash("error", "Repo not found"), 404);
    db.prepare("UPDATE repos SET watched = 0 WHERE id = ?").run(id);
    return c.html(
      flash("ok", `${row.owner}/${row.name} paused — scheduler will skip it until resumed.`),
    );
  });

  // Resume a repo: set watched=1 so the scheduler picks it up again.
  app.post("/api/repos/:id/resume", (c) => {
    const id = Number(c.req.param("id"));
    const row = listRepos(db, { watchedOnly: false }).find((r) => r.id === id);
    if (!row) return c.html(flash("error", "Repo not found"), 404);
    db.prepare("UPDATE repos SET watched = 1 WHERE id = ?").run(id);
    return c.html(flash("ok", `${row.owner}/${row.name} resumed.`));
  });

  // -------- Connect webhook (HTMX endpoint) --------
  // Show the bot's SSH public key so the operator can paste it into
  // ~/.ssh/authorized_keys on the deploy target server. The matching
  // private key lives at $OPENRONIN_DATA_DIR/secrets/ssh/id_*_ed25519 and
  // is what the deploy lane uses when ssh.key_path is set.
  app.get("/api/deploy/ssh-public-key", (c) => {
    const config = getConfig();
    const sshDir = resolve(config.dataDir, "secrets", "ssh");
    if (!existsSync(sshDir)) {
      return c.html(
        `<div class="bg-yellow-50 border border-yellow-200 text-yellow-900 rounded p-3 text-sm">No SSH keys generated yet at <code>${sshDir}</code>. Run <code>ssh-keygen -t ed25519 -f ${sshDir}/id_openronin_ed25519 -N ''</code> on the server.</div>`,
      );
    }
    const candidates = readdirSync(sshDir).filter((f) => f.endsWith(".pub"));
    if (candidates.length === 0) {
      return c.html(
        `<div class="bg-yellow-50 border border-yellow-200 text-yellow-900 rounded p-3 text-sm">No <code>.pub</code> files found in <code>${sshDir}</code>.</div>`,
      );
    }
    const keys = candidates.map((f) => {
      const content = readFileSync(resolve(sshDir, f), "utf8").trim();
      return { file: f, content };
    });
    const items = keys
      .map(
        (k) => `
        <div class="bg-elevated border rounded p-2 mb-2">
          <div class="text-xs text-muted mb-1">
            <code>${escapeHtml(k.file)}</code>
            <span class="text-muted">— private key path on this server: <code>${escapeHtml(resolve(sshDir, k.file.replace(/\\.pub$/, "")))}</code></span>
          </div>
          <code class="text-xs select-all break-all block bg-surface p-2 rounded">${escapeHtml(k.content)}</code>
        </div>`,
      )
      .join("");
    return c.html(
      `<div class="bg-blue-50 border border-blue-200 rounded p-3 text-sm space-y-2">
        <p class="text-blue-900">Скопируй ключ ниже и добавь его в <code>~/.ssh/authorized_keys</code> на target-сервере (на пользователя, под которым деплоить). Затем в repo config укажи <code>deploy.ssh.key_path</code> = путь к приватному ключу на этом сервере.</p>
        ${items}
        <p class="text-xs text-muted">Чтобы сгенерировать новый ключ: <code>sudo -u claude ssh-keygen -t ed25519 -f ${escapeHtml(sshDir)}/id_NEWNAME_ed25519 -N ''</code></p>
      </div>`,
    );
  });

  // Show a copy-paste-friendly YAML example for the deploy block, with
  // every field annotated. Two variants — local and ssh — so the operator
  // doesn't have to read the schema source to figure out what goes where.
  app.get("/api/deploy/config-example", (c) => {
    return c.html(deployConfigExamplePanel().value);
  });

  // Run the deploy lane manually for this repo, without waiting for a push
  // webhook. Useful for first-time setup / verifying ssh access.
  app.post("/api/repos/:id/deploy-now", async (c) => {
    const id = Number(c.req.param("id"));
    const row = listRepos(db, { watchedOnly: false }).find((r) => r.id === id);
    if (!row) return c.html(flash("error", "Repo not found"), 404);
    const cfg = getConfig().repos.find(
      (r) => r.provider === row.provider && r.owner === row.owner && r.name === row.name,
    );
    if (!cfg) return c.html(flash("error", "Repo not in current config"), 400);
    const dep = cfg.deploy;
    if (dep.mode === "disabled" || dep.commands.length === 0) {
      return c.html(flash("error", "Deploy is not enabled (mode=disabled or no commands)"));
    }
    const { runDeploy } = await import("../lanes/deploy.js");
    const activityDone = scheduler?.trackActivity(`deploy:${row.owner}/${row.name}`);
    let result;
    try {
      result = await runDeploy({
        db,
        repoId: row.id,
        sha: "manual-trigger",
        branch: dep.trigger_branch,
        triggeredBy: "admin-ui",
        commands: dep.commands,
        mode: dep.mode,
        ...(dep.ssh && {
          ssh: {
            user: dep.ssh.user,
            host: dep.ssh.host,
            port: dep.ssh.port,
            keyPath: dep.ssh.key_path,
            strictHostKeyChecking: dep.ssh.strict_host_key_checking,
          },
        }),
      });
    } finally {
      activityDone?.();
    }
    if (result.outcome === "success") {
      return c.html(
        flash("ok", `Deploy succeeded in ${Math.round(result.durationMs / 100) / 10}s.`),
      );
    }
    return c.html(
      flash("error", `Deploy ${result.outcome}: ${(result.error ?? "").slice(0, 400)}`),
    );
  });

  // Manual webhook setup helper. For repos where the bot's PAT lacks the
  // admin permission to create webhooks via the API (typical for personal
  // repos with collaborator access), the operator copies these values into
  // GitHub Settings → Webhooks → Add. Returns an HTML panel ready to drop
  // into the page.
  app.get("/api/repos/:id/webhook-info", (c) => {
    const id = Number(c.req.param("id"));
    const row = listRepos(db, { watchedOnly: false }).find((r) => r.id === id);
    if (!row) return c.html(flash("error", "Repo not found"), 404);
    const baseUrl = getConfig().global.server.baseUrl.replace(/\/+$/, "");
    const callback = `${baseUrl}/webhooks/github/${row.id}`;
    let secretRow = db
      .prepare("SELECT secret, webhook_id FROM webhook_secrets WHERE repo_id = ?")
      .get(row.id) as { secret: string; webhook_id: string | null } | undefined;
    if (!secretRow) {
      const secret = randomBytes(32).toString("hex");
      db.prepare("INSERT INTO webhook_secrets (repo_id, secret) VALUES (?, ?)").run(row.id, secret);
      secretRow = { secret, webhook_id: null };
    }
    const ghHooksUrl = `https://github.com/${row.owner}/${row.name}/settings/hooks/new`;
    return c.html(webhookInfoPanel(row.id, callback, secretRow.secret, ghHooksUrl).value);
  });

  app.post("/api/repos/:id/rotate-webhook-secret", (c) => {
    const id = Number(c.req.param("id"));
    const row = listRepos(db, { watchedOnly: false }).find((r) => r.id === id);
    if (!row) return c.html(flash("error", "Repo not found"), 404);
    const secret = randomBytes(32).toString("hex");
    db.prepare(
      `INSERT INTO webhook_secrets (repo_id, secret) VALUES (?, ?)
         ON CONFLICT(repo_id) DO UPDATE SET secret = excluded.secret`,
    ).run(row.id, secret);
    const baseUrl = getConfig().global.server.baseUrl.replace(/\/+$/, "");
    const callback = `${baseUrl}/webhooks/github/${row.id}`;
    const ghHooksUrl = `https://github.com/${row.owner}/${row.name}/settings/hooks/new`;
    return c.html(webhookInfoPanel(row.id, callback, secret, ghHooksUrl, "rotated").value);
  });

  // Manual label setup info — for repos where the bot's PAT can't
  // create labels (e.g. read-only collaborator). Surfaces the names,
  // colours and direct links to GitHub's labels page.
  app.get("/api/repos/:id/labels-info", (c) => {
    const id = Number(c.req.param("id"));
    const row = listRepos(db, { watchedOnly: false }).find((r) => r.id === id);
    if (!row) return c.html(flash("error", "Repo not found"), 404);
    const cfg = getConfig().repos.find(
      (r) => r.provider === row.provider && r.owner === row.owner && r.name === row.name,
    );
    const labels = [
      {
        name: cfg?.patch_trigger_label ?? "openronin:do-it",
        color: "5319e7",
        description: "agent: implement autonomously",
      },
      {
        name: cfg?.in_progress_label ?? "openronin:in-progress",
        color: "fbca04",
        description: "agent: working on this",
      },
      {
        name: cfg?.awaiting_answer_label ?? "openronin:awaiting-answer",
        color: "0e8a16",
        description: "agent posted questions and is waiting for a human reply",
      },
      {
        name: cfg?.awaiting_action_label ?? "openronin:awaiting-action",
        color: "d93f0b",
        description: "agent is blocked and needs the human to do something",
      },
    ];
    return c.html(labelInfoPanel(row.owner, row.name, labels).value);
  });

  // Verify (and create if missing) the labels the bot relies on:
  //   - patch_trigger_label (default "openronin:do-it")
  //   - in_progress_label   (default "openronin:in-progress")
  // Reports per-label status: existed / created / failed.
  app.post("/api/repos/:id/ensure-labels", async (c) => {
    const id = Number(c.req.param("id"));
    const row = listRepos(db, { watchedOnly: false }).find((r) => r.id === id);
    if (!row) return c.html(flash("error", "Repo not found"), 404);
    if (row.provider !== "github") {
      return c.html(flash("error", `ensure-labels not implemented for ${row.provider}`), 400);
    }
    const config = getConfig();
    const repoCfg = config.repos.find(
      (r) => r.provider === row.provider && r.owner === row.owner && r.name === row.name,
    );
    const triggerLabel = repoCfg?.patch_trigger_label ?? "openronin:do-it";
    const inProgressLabel = repoCfg?.in_progress_label ?? "openronin:in-progress";
    const awaitingAnswerLabel = repoCfg?.awaiting_answer_label ?? "openronin:awaiting-answer";
    const awaitingActionLabel = repoCfg?.awaiting_action_label ?? "openronin:awaiting-action";
    const wanted: Array<{ name: string; color: string; description: string }> = [
      {
        name: triggerLabel,
        color: "5319e7",
        description: "agent: implement autonomously",
      },
      {
        name: inProgressLabel,
        color: "fbca04",
        description: "agent: working on this",
      },
      {
        name: awaitingAnswerLabel,
        color: "0e8a16",
        description: "agent posted questions and is waiting for a human reply",
      },
      {
        name: awaitingActionLabel,
        color: "d93f0b",
        description: "agent is blocked and needs the human to do something",
      },
    ];
    const token = process.env.GITHUB_TOKEN;
    if (!token) return c.html(flash("error", "GITHUB_TOKEN not set"), 500);
    const headers = {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "openronin/0.0.1",
    };
    const results: Array<{
      name: string;
      status: "existed" | "created" | "failed";
      reason?: string;
    }> = [];
    for (const w of wanted) {
      const getUrl = `https://api.github.com/repos/${row.owner}/${row.name}/labels/${encodeURIComponent(w.name)}`;
      const head = await fetch(getUrl, { headers }).catch((e) => ({
        ok: false,
        status: 0,
        statusText: String(e),
      }));
      if (head.ok) {
        results.push({ name: w.name, status: "existed" });
        continue;
      }
      // Treat 404 as "needs creating"; everything else is a real error.
      if (head.status !== 404) {
        const reason = `HTTP ${head.status}` + ("statusText" in head ? `: ${head.statusText}` : "");
        results.push({ name: w.name, status: "failed", reason });
        continue;
      }
      const create = await fetch(`https://api.github.com/repos/${row.owner}/${row.name}/labels`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(w),
      });
      if (create.ok) {
        results.push({ name: w.name, status: "created" });
      } else {
        const body = await create.text();
        results.push({
          name: w.name,
          status: "failed",
          reason: `HTTP ${create.status}: ${body.slice(0, 160)}`,
        });
      }
    }
    const ok = results.every((r) => r.status !== "failed");
    const lines = results
      .map(
        (r) =>
          `${r.status === "failed" ? "❌" : r.status === "created" ? "🆕" : "✅"} <code>${escapeHtml(r.name)}</code> — ${r.status}${r.reason ? ` (${escapeHtml(r.reason)})` : ""}`,
      )
      .join("<br>");
    const cls = ok ? "badge-success border" : "badge-danger border";
    return c.html(`<div class="border rounded px-3 py-2 text-sm ${cls}">${lines}</div>`);
  });

  app.post("/api/repos/:id/connect-webhook", async (c) => {
    const id = Number(c.req.param("id"));
    const row = listRepos(db, { watchedOnly: false }).find((r) => r.id === id);
    if (!row) return c.html(flash("error", "Repo not found"), 404);
    if (row.provider !== "github")
      return c.html(
        flash("error", `Connect-webhook not implemented for provider ${row.provider}`),
        400,
      );
    const baseUrl = getConfig().global.server.baseUrl.replace(/\/+$/, "");
    const callback = `${baseUrl}/webhooks/github/${row.id}`;
    const secret = randomBytes(32).toString("hex");
    db.prepare(
      "INSERT INTO webhook_secrets (repo_id, secret) VALUES (?, ?) ON CONFLICT(repo_id) DO UPDATE SET secret = excluded.secret",
    ).run(row.id, secret);
    const token = process.env.GITHUB_TOKEN;
    if (!token) return c.html(flash("error", "GITHUB_TOKEN not set on server"), 500);
    const response = await fetch(`https://api.github.com/repos/${row.owner}/${row.name}/hooks`, {
      method: "POST",
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "openronin/0.0.1",
      },
      body: JSON.stringify({
        name: "web",
        active: true,
        events: ["issues", "issue_comment", "pull_request", "pull_request_review"],
        config: { url: callback, content_type: "json", secret, insecure_ssl: "0" },
      }),
    });
    const text = await response.text();
    if (!response.ok) {
      return c.html(flash("error", `GitHub error ${response.status}: ${text.slice(0, 200)}`), 502);
    }
    let webhookId: number | undefined;
    try {
      webhookId = (JSON.parse(text) as { id?: number }).id;
    } catch {
      /* ignore */
    }
    if (webhookId !== undefined) {
      db.prepare("UPDATE webhook_secrets SET webhook_id = ? WHERE repo_id = ?").run(
        String(webhookId),
        row.id,
      );
    }
    return c.html(flash("ok", `Webhook registered. id=${webhookId ?? "?"} url=${callback}`));
  });

  // -------- Review now (HTMX endpoint) --------
  app.post("/api/repos/:id/review-now", async (c) => {
    const id = Number(c.req.param("id"));
    const row = listRepos(db, { watchedOnly: false }).find((r) => r.id === id);
    if (!row) return c.html(flash("error", "Repo not found"), 404);
    const form = await c.req.parseBody();
    const number = Number(form.number ?? 0);
    if (!Number.isFinite(number) || number <= 0)
      return c.html(flash("error", "Invalid item number"), 400);

    const config = getConfig();
    const repoCfg =
      config.repos.find((r) => r.owner === row.owner && r.name === row.name) ??
      RepoConfigSchema.parse({ owner: row.owner, name: row.name });

    try {
      const provider = new GithubVcsProvider();
      const item = await provider.getItem({ owner: row.owner, name: row.name }, number);
      const repoId = ensureRepo(db, {
        provider: repoCfg.provider,
        owner: repoCfg.owner,
        name: repoCfg.name,
      });
      const taskId = upsertTask(db, repoId, String(number), item.kind);
      enqueue(db, taskId, "high", null);
      return c.html(
        flash(
          "ok",
          `Queued review for #${number} (taskId=${taskId}). The worker drains every 30s; refresh Tasks to see progress.`,
        ),
      );
    } catch (error) {
      return c.html(
        flash(
          "error",
          `Failed to fetch item: ${error instanceof Error ? error.message : String(error)}`,
        ),
        500,
      );
    }
  });

  // -------- Tasks --------
  app.get("/tasks", (c) => {
    const limit = Number(c.req.query("limit") ?? "50");
    const rows = db
      .prepare(
        `SELECT t.*, r.provider AS provider, r.owner AS owner, r.name AS repo_name
         FROM tasks t JOIN repos r ON r.id = t.repo_id
         ORDER BY COALESCE(t.last_run_at, '') DESC, t.id DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{
      id: number;
      external_id: string;
      kind: string;
      status: string;
      priority: string;
      next_due_at: string | null;
      last_run_at: string | null;
      last_error: string | null;
      decision_json: string | null;
      provider: string;
      owner: string;
      repo_name: string;
    }>;
    const list: TrustedHtml | TrustedHtml[] =
      rows.length === 0
        ? raw("<tr><td colspan=8 class='py-3 text-muted px-2'><em>no tasks yet</em></td></tr>")
        : rows.map((t) => {
            const decision = t.decision_json ? safeJson(t.decision_json) : null;
            const decisionLabel = decision?.decision
              ? html`<span
                  class="text-xs ${decision.decision === "close" ? "text-amber-700" : "text-muted"}"
                  >${decision.decision}/${decision.close_reason ?? ""}</span
                >`
              : raw("");
            return html`
              <tr class="border-t hover:bg-surface">
                <td class="py-1.5 px-2">
                  <a href="/admin/tasks/${t.id}" class="text-blue-700 hover:underline font-medium"
                    >${t.owner}/${t.repo_name}#${t.external_id}</a
                  >
                </td>
                <td class="py-1.5 px-2"><span class="text-xs text-muted">${t.kind}</span></td>
                <td class="py-1.5 px-2">
                  <span class="${taskStatusClass(t.status)} px-1.5 py-0.5 rounded text-xs"
                    >${t.status}</span
                  >
                </td>
                <td class="py-1.5 px-2 text-xs text-muted">${t.priority}</td>
                <td class="py-1.5 px-2 text-xs text-muted">${time(t.last_run_at)}</td>
                <td class="py-1.5 px-2">${decisionLabel}</td>
                <td class="py-1.5 px-2 text-xs ${t.last_error ? "text-red-700" : "text-muted"}">
                  ${t.last_error ? t.last_error.slice(0, 80) : ""}
                </td>
                <td class="py-1.5 px-2 text-right">
                  <button
                    type="button"
                    hx-post="/admin/api/tasks/${t.id}/kick"
                    hx-target="closest td"
                    hx-swap="innerHTML"
                    class="text-xs bg-amber-600 hover:bg-amber-700 text-white rounded px-2 py-0.5"
                    title="Mark task as due now with high priority"
                  >
                    kick
                  </button>
                </td>
              </tr>
            `;
          });
    const body = html`
      <div class="flex items-center justify-between mb-4">
        <h1 class="text-2xl font-semibold">Tasks</h1>
        <div class="flex gap-2">
          <a
            href="/admin/api/export/tasks.csv"
            class="text-xs px-2 py-1 rounded border border-subtle hover:bg-sunken"
            >CSV</a
          >
          <a
            href="/admin/api/export/tasks.json"
            class="text-xs px-2 py-1 rounded border border-subtle hover:bg-sunken"
            >JSON</a
          >
        </div>
      </div>
      <section class="bg-elevated rounded shadow-sm border">
        <table class="w-full text-sm">
          <thead class="bg-surface text-secondary text-left">
            <tr>
              <th class="px-2 py-2">Item</th>
              <th class="px-2 py-2">Kind</th>
              <th class="px-2 py-2">Status</th>
              <th class="px-2 py-2">Priority</th>
              <th class="px-2 py-2">Last run</th>
              <th class="px-2 py-2">Decision</th>
              <th class="px-2 py-2">Error</th>
              <th class="px-2 py-2"></th>
            </tr>
          </thead>
          <tbody>
            ${list}
          </tbody>
        </table>
      </section>
    `;
    return c.html(
      page({ title: "Tasks", section: "tasks", body, isHtmx: isHtmx(c.req.raw.headers) }),
    );
  });

  // -------- Task detail --------
  app.get("/tasks/:id", (c) => {
    const taskId = Number(c.req.param("id"));
    if (!Number.isFinite(taskId)) return c.html("Not found", 404);

    const task = db
      .prepare(
        `SELECT t.*, r.provider AS provider, r.owner AS owner, r.name AS repo_name
         FROM tasks t JOIN repos r ON r.id = t.repo_id WHERE t.id = ?`,
      )
      .get(taskId) as
      | {
          id: number;
          external_id: string;
          kind: string;
          status: string;
          priority: string;
          source: string;
          next_due_at: string | null;
          last_run_at: string | null;
          last_error: string | null;
          decision_json: string | null;
          provider: string;
          owner: string;
          repo_name: string;
        }
      | undefined;
    if (!task) return c.html("Not found", 404);

    const runs = getRunsByTask(db, taskId);

    const ghBase = `https://github.com/${task.owner}/${task.repo_name}`;
    const issueUrl =
      task.kind === "pull_request"
        ? `${ghBase}/pull/${task.external_id}`
        : `${ghBase}/issues/${task.external_id}`;

    const decisionPretty = task.decision_json
      ? (() => {
          try {
            return JSON.stringify(JSON.parse(task.decision_json), null, 2);
          } catch {
            return task.decision_json;
          }
        })()
      : null;

    const runRows = runs.map((run) => {
      const durationSec =
        run.finished_at && run.started_at
          ? (
              (new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) /
              1000
            ).toFixed(1)
          : null;

      let promptContent: TrustedHtml = raw("");
      if (run.prompt_log_path && existsSync(run.prompt_log_path)) {
        try {
          const lines = readFileSync(run.prompt_log_path, "utf8")
            .split("\n")
            .filter((l) => l.trim());
          const entries = lines.map((l) => {
            try {
              return JSON.parse(l) as { type: string; content: string };
            } catch {
              return null;
            }
          });
          promptContent = html`
            ${entries.map((entry) => {
              if (!entry) return raw("");
              const labelColor =
                entry.type === "system"
                  ? "bg-purple-100 text-purple-800"
                  : entry.type === "user"
                    ? "badge-info"
                    : "badge-success";
              return html`
                <div class="mb-3">
                  <span class="text-xs font-semibold px-1.5 py-0.5 rounded ${labelColor}"
                    >${entry.type}</span
                  >
                  <pre
                    class="mt-1 text-xs bg-surface border rounded p-2 overflow-x-auto whitespace-pre-wrap"
                  >
${entry.content}</pre
                  >
                </div>
              `;
            })}
          `;
        } catch {
          promptContent = raw(`<p class="text-xs text-red-600">Failed to read prompt log</p>`);
        }
      } else if (run.prompt_log_path) {
        promptContent = raw(`<p class="text-xs text-muted">Log file not found</p>`);
      } else {
        promptContent = raw(
          `<p class="text-xs text-muted">No prompt log recorded for this run</p>`,
        );
      }

      return html`
        <div class="border rounded mb-2">
          <details>
            <summary
              class="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-surface select-none"
            >
              <span class="text-xs font-mono text-muted">#${run.id}</span>
              <span class="text-xs font-semibold">${run.lane}</span>
              <span class="text-xs text-muted"
                >${run.engine}${run.model ? html` / ${run.model}` : raw("")}</span
              >
              <span class="${runStatusClass(run.status)} text-xs px-1.5 py-0.5 rounded"
                >${run.status}</span
              >
              ${durationSec !== null
                ? html`<span class="text-xs text-muted">${durationSec}s</span>`
                : raw("")}
              ${run.tokens_in !== null
                ? html`<span class="text-xs text-muted"
                    >${run.tokens_in}↑ ${run.tokens_out ?? 0}↓</span
                  >`
                : raw("")}
              ${run.cost_usd !== null
                ? html`<span class="text-xs text-muted">$${run.cost_usd.toFixed(4)}</span>`
                : raw("")}
              ${run.error
                ? html`<span class="text-xs text-red-600 truncate max-w-xs">${run.error}</span>`
                : raw("")}
              <span class="ml-auto text-xs text-muted">${time(run.started_at)}</span>
            </summary>
            <div class="px-3 py-3 border-t bg-elevated">${promptContent}</div>
          </details>
        </div>
      `;
    });

    // Build lane timeline summary
    const LANE_ORDER = ["analyze", "review", "patch", "pr_dialog", "auto_merge"];
    interface LaneSummary {
      lane: string;
      status: string;
      count: number;
      totalCost: number;
      durMs: number;
    }
    const laneSummary: LaneSummary[] = LANE_ORDER.flatMap((lane) => {
      const lRuns = runs.filter((r) => r.lane === lane);
      if (lRuns.length === 0) return [];
      const last = lRuns[lRuns.length - 1]!;
      const totalCost = lRuns.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
      const durMs = lRuns.reduce((s, r) => {
        if (!r.started_at || !r.finished_at) return s;
        const norm = (ts: string) => ts.replace(" ", "T") + (/[zZ]$/.test(ts) ? "" : "Z");
        return (
          s + (new Date(norm(r.finished_at)).getTime() - new Date(norm(r.started_at)).getTime())
        );
      }, 0);
      return [{ lane, status: last.status, count: lRuns.length, totalCost, durMs }];
    });

    const timelineHtml =
      laneSummary.length > 0
        ? html`
            <section class="bg-elevated rounded shadow-sm border p-4 mb-4">
              <h2 class="font-semibold text-xs text-muted uppercase tracking-wide mb-3">
                Lane timeline
              </h2>
              <div class="flex items-start gap-1 flex-wrap">
                ${laneSummary.map((step, i) => {
                  const bg =
                    step.status === "ok"
                      ? "bg-green-50 border-green-300 text-green-900"
                      : step.status === "error"
                        ? "bg-red-50 border-red-300 text-red-900"
                        : step.status === "running"
                          ? "bg-blue-50 border-blue-300 text-blue-900"
                          : "bg-amber-50 border-amber-300 text-amber-900";
                  return html`${i > 0
                      ? raw(`<div class="self-center text-muted text-sm mt-1">→</div>`)
                      : raw("")}
                    <div class="border rounded px-3 py-2 text-xs ${bg} min-w-20">
                      <div class="font-semibold">${step.lane}</div>
                      <div class="text-muted">${step.count} run${step.count > 1 ? "s" : ""}</div>
                      ${step.totalCost > 0
                        ? html`<div>$${step.totalCost.toFixed(4)}</div>`
                        : raw("")}
                      ${step.durMs > 0
                        ? html`<div class="text-muted">${(step.durMs / 1000).toFixed(0)}s</div>`
                        : raw("")}
                    </div>`;
                })}
              </div>
            </section>
          `
        : raw("");

    const body = html`
      <h1 class="text-2xl font-semibold mb-4">
        Task #${task.id} · ${task.owner}/${task.repo_name}#${task.external_id}
      </h1>

      ${timelineHtml}

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <section class="bg-elevated rounded shadow-sm border p-4">
          <h2 class="font-semibold text-sm text-secondary uppercase tracking-wide mb-3">
            Metadata
          </h2>
          <dl class="text-sm grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt class="text-muted">Repo</dt>
            <dd>${task.owner}/${task.repo_name}</dd>
            <dt class="text-muted">Kind</dt>
            <dd>${task.kind}</dd>
            <dt class="text-muted">External ID</dt>
            <dd>
              <a href="${issueUrl}" target="_blank" class="text-blue-700 hover:underline"
                >${task.external_id}</a
              >
            </dd>
            <dt class="text-muted">Status</dt>
            <dd>
              <span class="${taskStatusClass(task.status)} px-1.5 py-0.5 rounded text-xs"
                >${task.status}</span
              >
            </dd>
            <dt class="text-muted">Priority</dt>
            <dd>${task.priority}</dd>
            <dt class="text-muted">Source</dt>
            <dd>${task.source}</dd>
            <dt class="text-muted">Next due</dt>
            <dd>${time(task.next_due_at)}</dd>
            <dt class="text-muted">Last run</dt>
            <dd>${time(task.last_run_at)}</dd>
            ${task.last_error
              ? html`<dt class="text-muted">Last error</dt>
                  <dd class="text-red-700 text-xs">${task.last_error}</dd>`
              : raw("")}
          </dl>
          <div class="mt-4">
            <button
              hx-post="/admin/api/tasks/${task.id}/reenqueue"
              hx-target="#reenqueue-result"
              hx-swap="innerHTML"
              class="text-sm bg-amber-500 hover:bg-amber-600 text-white px-3 py-1.5 rounded cursor-pointer"
            >
              Re-enqueue
            </button>
            <span id="reenqueue-result" class="ml-2 text-sm"></span>
          </div>
        </section>

        <section class="bg-elevated rounded shadow-sm border p-4">
          <h2 class="font-semibold text-sm text-secondary uppercase tracking-wide mb-3">
            Decision JSON
          </h2>
          ${decisionPretty
            ? html`<pre
                class="text-xs bg-surface border rounded p-2 overflow-auto max-h-64 whitespace-pre-wrap"
              >
${decisionPretty}</pre
              >`
            : raw(`<p class="text-sm text-muted italic">No decision recorded</p>`)}
        </section>
      </div>

      <section class="bg-elevated rounded shadow-sm border p-4">
        <h2 class="font-semibold text-sm text-secondary uppercase tracking-wide mb-3">
          Runs (${runs.length})
        </h2>
        ${runs.length === 0
          ? raw(`<p class="text-sm text-muted italic">No runs yet</p>`)
          : html`${runRows}`}
      </section>
    `;

    return c.html(
      page({
        title: `Task #${task.id}`,
        section: "tasks",
        body,
        isHtmx: isHtmx(c.req.raw.headers),
        breadcrumb: [{ label: "Tasks", href: "/admin/tasks" }, { label: `#${task.id}` }],
      }),
    );
  });

  app.post("/api/tasks/:id/reenqueue", (c) => {
    const taskId = Number(c.req.param("id"));
    if (!Number.isFinite(taskId)) return c.html(flash("error", "Invalid task ID"), 400);
    const exists = db.prepare("SELECT id FROM tasks WHERE id = ?").get(taskId);
    if (!exists) return c.html(flash("error", "Task not found"), 404);
    enqueue(db, taskId, "normal", null);
    return c.html(flash("ok", `Task #${taskId} re-enqueued`));
  });

  // "Kick" a task — same as reenqueue but with high priority, so the next
  // drain picks it up before any normal-priority work. Used for the
  // per-row button on /admin/tasks.
  app.post("/api/tasks/:id/kick", (c) => {
    const taskId = Number(c.req.param("id"));
    if (!Number.isFinite(taskId)) return c.html(flash("error", "Invalid task ID"), 400);
    const exists = db.prepare("SELECT id FROM tasks WHERE id = ?").get(taskId);
    if (!exists) return c.html(flash("error", "Task not found"), 404);
    enqueue(db, taskId, "high", null);
    return c.html(
      `<span class="text-xs bg-green-100 text-green-800 px-1.5 py-0.5 rounded">kicked</span>`,
    );
  });

  // -------- Cost dashboard --------
  app.get("/cost", (c) => {
    const config = getConfig();
    const perDayUsd = config.global.cost_caps.per_day_usd;
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const since0 = "1970-01-01T00:00:00.000Z";

    const { totalCostUsd: cost24h } = getCostUsdSince(db, since24h);
    const { totalCostUsd: costTotal } = getCostUsdSince(db, since0);

    const byLane = getCostGroupedByLane(db, since24h);
    const byEngine = getCostGroupedByEngine(db, since24h);
    const byRepo = getCostGroupedByRepo(db, since24h);

    const pct = perDayUsd > 0 ? Math.min((cost24h / perDayUsd) * 100, 100) : 0;
    const barColor = pct >= 80 ? "bg-red-500" : pct >= 50 ? "bg-yellow-400" : "bg-green-500";
    const textColor = pct >= 80 ? "text-red-700" : pct >= 50 ? "text-yellow-700" : "text-green-700";

    function groupTable(rows: { key: string; cost: number; runs: number }[]): TrustedHtml {
      if (rows.length === 0)
        return raw("<tr><td colspan=3 class='py-2 text-muted text-xs'>no data</td></tr>");
      return html`${rows.map(
        (r) => html`<tr class="border-t">
          <td class="py-1.5 px-2 text-sm">${r.key}</td>
          <td class="py-1.5 px-2 text-sm font-mono">$${r.cost.toFixed(4)}</td>
          <td class="py-1.5 px-2 text-sm text-muted">${r.runs}</td>
        </tr>`,
      )}`;
    }

    const body = html`
      <h1 class="text-2xl font-semibold mb-6">Cost</h1>

      <section class="grid grid-cols-2 gap-4 mb-6">
        <div class="bg-elevated rounded shadow-sm border p-4">
          <p class="text-sm text-muted mb-1">Last 24 hours</p>
          <p class="text-3xl font-semibold font-mono ${textColor}">$${cost24h.toFixed(4)}</p>
        </div>
        <div class="bg-elevated rounded shadow-sm border p-4">
          <p class="text-sm text-muted mb-1">All time</p>
          <p class="text-3xl font-semibold font-mono">$${costTotal.toFixed(4)}</p>
        </div>
      </section>

      <section class="bg-elevated rounded shadow-sm border p-4 mb-6">
        <div class="flex justify-between text-sm mb-1">
          <span class="font-medium">Daily cap usage</span>
          <span class="${textColor} font-mono">
            $${cost24h.toFixed(4)} / $${perDayUsd.toFixed(2)} (${pct.toFixed(1)}%)
          </span>
        </div>
        <div class="w-full bg-sunken rounded h-4 overflow-hidden">
          <div
            class="${barColor} h-4 rounded transition-all"
            style="width:${pct.toFixed(2)}%"
          ></div>
        </div>
        ${perDayUsd <= 0
          ? html`<p class="text-xs text-muted mt-1">No daily cap configured.</p>`
          : raw("")}
      </section>

      <section class="grid grid-cols-3 gap-4">
        <div class="bg-elevated rounded shadow-sm border">
          <h2 class="text-sm font-semibold px-3 py-2 border-b bg-surface">By lane (24h)</h2>
          <table class="w-full text-sm">
            <thead class="text-left text-muted text-xs">
              <tr>
                <th class="px-2 py-1">Lane</th>
                <th class="px-2 py-1">Cost</th>
                <th class="px-2 py-1">Runs</th>
              </tr>
            </thead>
            <tbody>
              ${groupTable(byLane)}
            </tbody>
          </table>
        </div>
        <div class="bg-elevated rounded shadow-sm border">
          <h2 class="text-sm font-semibold px-3 py-2 border-b bg-surface">By engine (24h)</h2>
          <table class="w-full text-sm">
            <thead class="text-left text-muted text-xs">
              <tr>
                <th class="px-2 py-1">Engine</th>
                <th class="px-2 py-1">Cost</th>
                <th class="px-2 py-1">Runs</th>
              </tr>
            </thead>
            <tbody>
              ${groupTable(byEngine)}
            </tbody>
          </table>
        </div>
        <div class="bg-elevated rounded shadow-sm border">
          <h2 class="text-sm font-semibold px-3 py-2 border-b bg-surface">By repo (24h)</h2>
          <table class="w-full text-sm">
            <thead class="text-left text-muted text-xs">
              <tr>
                <th class="px-2 py-1">Repo</th>
                <th class="px-2 py-1">Cost</th>
                <th class="px-2 py-1">Runs</th>
              </tr>
            </thead>
            <tbody>
              ${groupTable(byRepo)}
            </tbody>
          </table>
        </div>
      </section>
    `;
    return c.html(
      page({ title: "Cost", section: "cost", body, isHtmx: isHtmx(c.req.raw.headers) }),
    );
  });

  // -------- Metrics --------
  app.get("/metrics/data.json", (c) => {
    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const since12w = new Date(Date.now() - 12 * 7 * 24 * 60 * 60 * 1000).toISOString();
    return c.json({
      tasksPerDay: getTasksPerDay(db, since30d),
      successRate: getSuccessRateByLane(db, since12w),
      latency: getAvgLatencyByModel(db, since30d),
      tokens: getTokensPerDay(db, since30d),
    });
  });

  app.get("/metrics", (c) => {
    const body = html`
      <h1 class="text-2xl font-semibold mb-6">Metrics</h1>

      <div class="grid grid-cols-2 gap-6 mb-6">
        <div class="bg-elevated rounded shadow-sm border p-4">
          <h2 class="text-sm font-semibold mb-3 text-secondary">Tasks / day (last 30 days)</h2>
          <canvas id="chart-tasks-day"></canvas>
        </div>
        <div class="bg-elevated rounded shadow-sm border p-4">
          <h2 class="text-sm font-semibold mb-3 text-secondary">
            Token usage trend (last 30 days)
          </h2>
          <canvas id="chart-tokens"></canvas>
        </div>
      </div>

      <div class="bg-elevated rounded shadow-sm border p-4 mb-6">
        <h2 class="text-sm font-semibold mb-3 text-secondary">
          Success rate by lane (per week, last 12 weeks)
        </h2>
        <canvas id="chart-success-rate"></canvas>
      </div>

      <div class="bg-elevated rounded shadow-sm border mb-6">
        <h2 class="text-sm font-semibold px-3 py-2 border-b bg-surface">
          Avg engine latency by model (last 30 days)
        </h2>
        <table class="w-full text-sm">
          <thead class="text-left text-muted text-xs bg-surface">
            <tr>
              <th class="px-3 py-2">Model</th>
              <th class="px-3 py-2">Engine</th>
              <th class="px-3 py-2">Avg duration</th>
              <th class="px-3 py-2">Runs</th>
            </tr>
          </thead>
          <tbody id="latency-table">
            <tr>
              <td colspan="4" class="px-3 py-4 text-muted text-xs">Loading…</td>
            </tr>
          </tbody>
        </table>
      </div>

      ${raw(`<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>
<script>
(function() {
  var COLORS = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899'];
  fetch('/admin/metrics/data.json')
    .then(function(r) { return r.json(); })
    .then(function(d) {
      new Chart(document.getElementById('chart-tasks-day'), {
        type: 'line',
        data: {
          labels: d.tasksPerDay.map(function(x) { return x.day; }),
          datasets: [{
            label: 'Tasks',
            data: d.tasksPerDay.map(function(x) { return x.count; }),
            borderColor: '#3b82f6',
            backgroundColor: 'rgba(59,130,246,0.1)',
            tension: 0.3,
            fill: true
          }]
        },
        options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } }
      });

      new Chart(document.getElementById('chart-tokens'), {
        type: 'line',
        data: {
          labels: d.tokens.map(function(x) { return x.day; }),
          datasets: [
            { label: 'Tokens in', data: d.tokens.map(function(x) { return x.tokens_in; }), borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.1)', tension: 0.3, fill: true },
            { label: 'Tokens out', data: d.tokens.map(function(x) { return x.tokens_out; }), borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.1)', tension: 0.3, fill: true }
          ]
        },
        options: { responsive: true, scales: { y: { beginAtZero: true } } }
      });

      var weeks = Array.from(new Set(d.successRate.map(function(x) { return x.week; }))).sort();
      var lanes = Array.from(new Set(d.successRate.map(function(x) { return x.lane; })));
      var datasets = lanes.map(function(lane, i) {
        return {
          label: lane,
          data: weeks.map(function(week) {
            var row = d.successRate.find(function(x) { return x.week === week && x.lane === lane; });
            return row ? Math.round(row.ok_count / row.total * 100) : null;
          }),
          backgroundColor: COLORS[i % COLORS.length]
        };
      });
      new Chart(document.getElementById('chart-success-rate'), {
        type: 'bar',
        data: { labels: weeks, datasets: datasets },
        options: {
          responsive: true,
          scales: {
            y: { beginAtZero: true, max: 100, ticks: { callback: function(v) { return v + '%'; } } }
          }
        }
      });

      var tbody = document.getElementById('latency-table');
      if (!d.latency.length) {
        tbody.innerHTML = '<tr><td colspan="4" class="px-3 py-4 text-muted text-xs">no data</td></tr>';
      } else {
        tbody.innerHTML = d.latency.map(function(r) {
          var secs = r.avg_seconds != null ? r.avg_seconds.toFixed(1) + 's' : '—';
          return '<tr class="border-t">' +
            '<td class="px-3 py-2 text-sm font-mono">' + r.model + '</td>' +
            '<td class="px-3 py-2 text-sm text-muted">' + r.engine + '</td>' +
            '<td class="px-3 py-2 text-sm font-mono">' + secs + '</td>' +
            '<td class="px-3 py-2 text-sm text-muted">' + r.runs + '</td></tr>';
        }).join('');
      }
    })
    .catch(function(err) { console.error('metrics fetch error', err); });
})();
</script>`)}
    `;
    return c.html(
      page({ title: "Metrics", section: "metrics", body, isHtmx: isHtmx(c.req.raw.headers) }),
    );
  });

  // -------- Logs --------
  app.get("/logs", (c) => {
    const q = (key: string) => c.req.query(key);
    const filter = {
      lane: q("lane") || undefined,
      engine: q("engine") || undefined,
      model: q("model") || undefined,
      status: q("status") || undefined,
      repo: q("repo") || undefined,
      dateFrom: q("dateFrom") || undefined,
      dateTo: q("dateTo") || undefined,
      errorSearch: q("errorSearch") || undefined,
    };
    const page_ = Math.max(1, parseInt(q("page") ?? "1", 10) || 1);
    const limit = 50;
    const offset = (page_ - 1) * limit;
    const runs = listRunsFiltered(db, { ...filter, limit: limit + 1, offset });
    const hasMore = runs.length > limit;
    const rows = hasMore ? runs.slice(0, limit) : runs;
    const distincts = getRunDistincts(db);

    const selOpts = (list: string[], current: string | undefined, all = "all") =>
      raw(
        `<option value="">${all}</option>` +
          list
            .map(
              (v) =>
                `<option value="${escapeAttr(v)}"${current === v ? " selected" : ""}>${escapeAttr(v)}</option>`,
            )
            .join(""),
      );

    const filterForm = html`
      <form method="get" action="/admin/logs" class="flex flex-wrap gap-2 mb-4 items-end">
        <div class="flex flex-col text-xs">
          <label class="text-muted mb-0.5">Lane</label>
          <select name="lane" class="border rounded px-1 py-0.5 text-sm">
            ${selOpts(distincts.lanes, filter.lane)}
          </select>
        </div>
        <div class="flex flex-col text-xs">
          <label class="text-muted mb-0.5">Engine</label>
          <select name="engine" class="border rounded px-1 py-0.5 text-sm">
            ${selOpts(distincts.engines, filter.engine)}
          </select>
        </div>
        <div class="flex flex-col text-xs">
          <label class="text-muted mb-0.5">Model</label>
          <select name="model" class="border rounded px-1 py-0.5 text-sm">
            ${selOpts(distincts.models, filter.model)}
          </select>
        </div>
        <div class="flex flex-col text-xs">
          <label class="text-muted mb-0.5">Status</label>
          <select name="status" class="border rounded px-1 py-0.5 text-sm">
            ${selOpts(["ok", "error", "running"], filter.status)}
          </select>
        </div>
        <div class="flex flex-col text-xs">
          <label class="text-muted mb-0.5">Repo</label>
          <select name="repo" class="border rounded px-1 py-0.5 text-sm">
            ${selOpts(distincts.repos, filter.repo)}
          </select>
        </div>
        <div class="flex flex-col text-xs">
          <label class="text-muted mb-0.5">From</label>
          <input
            type="date"
            name="dateFrom"
            value="${filter.dateFrom ?? ""}"
            class="border rounded px-1 py-0.5 text-sm"
          />
        </div>
        <div class="flex flex-col text-xs">
          <label class="text-muted mb-0.5">To</label>
          <input
            type="date"
            name="dateTo"
            value="${filter.dateTo ?? ""}"
            class="border rounded px-1 py-0.5 text-sm"
          />
        </div>
        <div class="flex flex-col text-xs flex-1 min-w-40">
          <label class="text-muted mb-0.5">Error search</label>
          <input
            type="text"
            name="errorSearch"
            value="${filter.errorSearch ?? ""}"
            placeholder="substring…"
            class="border rounded px-1 py-0.5 text-sm"
          />
        </div>
        <button
          type="submit"
          class="bg-slate-700 text-white px-3 py-1 rounded text-sm hover:bg-slate-800"
        >
          Filter
        </button>
        <a href="/admin/logs" class="text-muted text-sm hover:underline self-end pb-1">reset</a>
      </form>
    `;

    const tableRows =
      rows.length === 0
        ? raw(
            "<tr><td colspan='8' class='text-muted py-4 text-center'><em>no runs match</em></td></tr>",
          )
        : rows.map(
            (r) => html`
              <tr class="border-t hover:bg-surface">
                <td class="px-2 py-1">#${r.id}</td>
                <td class="px-2 py-1 text-xs text-muted whitespace-nowrap">
                  ${time(r.started_at)}
                </td>
                <td class="px-2 py-1 text-xs">${r.lane}</td>
                <td class="px-2 py-1 text-xs">${r.engine}/${r.model ?? "?"}</td>
                <td class="px-2 py-1">
                  <span class="${runStatusClass(r.status)} px-1.5 py-0.5 rounded text-xs"
                    >${r.status}</span
                  >
                </td>
                <td class="px-2 py-1 text-xs">${r.repo ?? "—"}</td>
                <td class="px-2 py-1 text-xs whitespace-nowrap">
                  ${r.tokens_in ?? "-"}/${r.tokens_out ?? "-"}
                </td>
                <td class="px-2 py-1 text-xs whitespace-nowrap">
                  ${r.cost_usd != null ? "$" + r.cost_usd.toFixed(4) : "—"}
                </td>
              </tr>
              ${r.log_path
                ? html`<tr class="border-b bg-surface">
                    <td colspan="8" class="px-2 pb-1">
                      <details>
                        <summary
                          class="cursor-pointer text-xs text-blue-700 hover:underline select-none"
                        >
                          show log
                        </summary>
                        <div
                          hx-get="/admin/api/runs/${r.id}/log"
                          hx-trigger="intersect once"
                          hx-swap="outerHTML"
                          class="text-xs text-muted py-1"
                        >
                          loading…
                        </div>
                      </details>
                    </td>
                  </tr>`
                : html`<tr class="border-b">
                    <td colspan="8" class="px-2 pb-1 text-xs text-muted">
                      ${r.error ? r.error : raw("<em>no log file</em>")}
                    </td>
                  </tr>`}
            `,
          );

    const pagination = html`
      <div class="flex gap-3 items-center mt-4 text-sm">
        ${page_ > 1
          ? html`<a
              href="/admin/logs?${buildQueryString({ ...filter, page: String(page_ - 1) })}"
              class="text-blue-700 hover:underline"
              >&larr; prev</a
            >`
          : raw("")}
        <span class="text-muted">page ${page_}</span>
        ${hasMore
          ? html`<a
              href="/admin/logs?${buildQueryString({ ...filter, page: String(page_ + 1) })}"
              class="text-blue-700 hover:underline"
              >next &rarr;</a
            >`
          : raw("")}
      </div>
    `;

    const body = html`
      <div class="flex items-center justify-between mb-4">
        <h1 class="text-2xl font-semibold">Logs</h1>
        <div class="flex gap-2">
          <a
            href="/admin/api/export/runs.csv"
            class="text-xs px-2 py-1 rounded border border-subtle hover:bg-sunken"
            >CSV</a
          >
          <a
            href="/admin/api/export/runs.json"
            class="text-xs px-2 py-1 rounded border border-subtle hover:bg-sunken"
            >JSON</a
          >
        </div>
      </div>
      ${filterForm}
      <div class="overflow-x-auto">
        <table class="w-full text-sm bg-elevated border rounded shadow-sm">
          <thead class="bg-surface text-secondary text-left text-xs">
            <tr>
              <th class="px-2 py-2">id</th>
              <th class="px-2 py-2">started</th>
              <th class="px-2 py-2">lane</th>
              <th class="px-2 py-2">engine/model</th>
              <th class="px-2 py-2">status</th>
              <th class="px-2 py-2">repo</th>
              <th class="px-2 py-2">tokens in/out</th>
              <th class="px-2 py-2">cost</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows}
          </tbody>
        </table>
      </div>
      ${pagination}
    `;

    return c.html(
      page({ title: "Logs", section: "logs", body, isHtmx: isHtmx(c.req.raw.headers) }),
    );
  });

  app.get("/api/runs/:id/log", (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.html("<span class='text-red-500'>bad id</span>", 400);

    const run = getRunById(db, id);
    if (!run) return c.html("<span class='text-muted'>run not found</span>");
    if (!run.log_path) return c.html("<span class='text-muted'>no log file for this run</span>");

    if (!existsSync(run.log_path))
      return c.html(
        `<span class='text-muted'>log file missing: ${escapeHtml(run.log_path)}</span>`,
      );

    const lines = readFileSync(run.log_path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as Record<string, unknown>[];

    if (lines.length === 0 || !lines[0])
      return c.html("<span class='text-muted'>empty log file</span>");

    const entry = lines[0];
    const fmtPre = (label: string, val: unknown) => {
      if (val == null) return raw("");
      const text = typeof val === "string" ? val : JSON.stringify(val, null, 2);
      return html`
        <div class="mt-2">
          <div class="font-semibold text-secondary mb-0.5">${label}</div>
          <pre
            class="bg-sunken rounded p-2 overflow-x-auto text-xs whitespace-pre-wrap break-words max-h-64 overflow-y-auto"
          >
${text}</pre
          >
        </div>
      `;
    };

    const meta = html`
      <div class="flex flex-wrap gap-4 text-xs text-secondary mb-1">
        <span>timestamp: ${entry.timestamp as string}</span>
        <span>duration: ${entry.duration_ms as number}ms</span>
        ${entry.tokens_in != null
          ? html`<span>tokens in: ${entry.tokens_in as number}</span>`
          : raw("")}
        ${entry.tokens_out != null
          ? html`<span>tokens out: ${entry.tokens_out as number}</span>`
          : raw("")}
        ${entry.cost_usd != null
          ? html`<span>cost: $${(entry.cost_usd as number).toFixed(6)}</span>`
          : raw("")}
      </div>
    `;

    const fragment = html`
      <div class="border-t pt-2 mt-1">
        ${meta} ${fmtPre("system_prompt", entry.system_prompt)}
        ${fmtPre("user_prompt", entry.user_prompt)} ${fmtPre("raw_response", entry.raw_response)}
        ${entry.error_message ? fmtPre("error", entry.error_message) : raw("")}
      </div>
    `;

    return c.html(fragment.value);
  });

  // -------- Prompts --------
  app.get("/prompts", (c) => {
    const config = getConfig();
    const builtinDir = resolve(getProjectRoot(), "prompts", "templates");
    const overrideDir = resolve(config.dataDir, "prompts", "overrides");
    const builtins = existsSync(builtinDir)
      ? readdirSync(builtinDir).filter((n) => n.endsWith(".md"))
      : [];
    const overrides = existsSync(overrideDir)
      ? readdirSync(overrideDir).filter((n) => n.endsWith(".md"))
      : [];

    const list: TrustedHtml | TrustedHtml[] =
      builtins.length === 0
        ? raw("<li class='text-muted'>none</li>")
        : builtins.map(
            (n) =>
              html`<li>
                <a
                  href="/admin/prompts/${encodeURIComponent(n.replace(/\.md$/, ""))}"
                  class="text-blue-700 hover:underline"
                  >${n}</a
                >
              </li>`,
          );
    const overrideList: TrustedHtml | TrustedHtml[] =
      overrides.length === 0
        ? raw("<li class='text-muted'>none</li>")
        : overrides.map(
            (n) =>
              html`<li>
                <span class="text-secondary">${n}</span>
                <a
                  href="/admin/prompts/${encodeURIComponent(n.replace(/\.md$/, ""))}?override=1"
                  class="text-blue-700 hover:underline text-xs"
                  >edit</a
                >
              </li>`,
          );

    const body = html`
      <h1 class="text-2xl font-semibold mb-4">Prompts</h1>
      <div class="grid grid-cols-2 gap-6">
        <section class="bg-elevated rounded shadow-sm border p-4">
          <h2 class="font-medium mb-2">Built-in templates</h2>
          <p class="text-xs text-muted mb-2">
            Repo-tracked. Click to view; saving creates an override at the same key.
          </p>
          <ul class="space-y-1">
            ${list}
          </ul>
        </section>
        <section class="bg-elevated rounded shadow-sm border p-4">
          <h2 class="font-medium mb-2">Active overrides</h2>
          <p class="text-xs text-muted mb-2">Stored at <code>${overrideDir}</code>.</p>
          <ul class="space-y-1">
            ${overrideList}
          </ul>
        </section>
      </div>
    `;
    return c.html(
      page({ title: "Prompts", section: "prompts", body, isHtmx: isHtmx(c.req.raw.headers) }),
    );
  });

  app.get("/prompts/:key", (c) => {
    const key = c.req.param("key");
    const config = getConfig();
    const builtinPath = resolve(getProjectRoot(), "prompts", "templates", `${key}.md`);
    const overridePath = resolve(config.dataDir, "prompts", "overrides", `${key}.md`);
    const overrideExists = existsSync(overridePath);
    const builtinExists = existsSync(builtinPath);
    const useOverride = c.req.query("override") === "1" || overrideExists;
    const text =
      useOverride && overrideExists
        ? readFileSync(overridePath, "utf8")
        : builtinExists
          ? readFileSync(builtinPath, "utf8")
          : "";

    const body = html`
      <h1 class="text-2xl font-semibold mb-2">${key}</h1>
      <p class="text-xs text-muted mb-4">
        Builtin: <code>${builtinPath}</code>${builtinExists ? "" : " (missing)"} · Override:
        <code>${overridePath}</code> ${overrideExists ? "(active)" : "(none)"}
      </p>
      <div id="flash" class="mb-3"></div>

      <form hx-post="/admin/prompts/${encodeURIComponent(key)}" hx-target="#flash">
        <textarea
          name="content"
          rows="22"
          spellcheck="false"
          class="w-full border rounded px-3 py-2 text-sm"
        >
${text}</textarea
        >
        <div class="mt-3 flex gap-2">
          <button class="bg-slate-900 text-white rounded px-4 py-2 text-sm">
            Save as override
          </button>
          ${overrideExists
            ? html`<button
                type="button"
                hx-delete="/admin/prompts/${encodeURIComponent(key)}"
                hx-target="#flash"
                hx-confirm="Delete override and revert to builtin?"
                class="bg-red-100 text-red-700 rounded px-4 py-2 text-sm"
              >
                Delete override
              </button>`
            : raw("")}
        </div>
      </form>
    `;
    return c.html(
      page({
        title: key,
        section: "prompts",
        body,
        isHtmx: isHtmx(c.req.raw.headers),
        breadcrumb: [{ label: "Prompts", href: "/admin/prompts" }, { label: key }],
      }),
    );
  });

  app.post("/prompts/:key", async (c) => {
    const key = c.req.param("key");
    if (!/^[a-z0-9_-]+$/i.test(key)) return c.html(flash("error", "Bad key"), 400);
    const form = await c.req.parseBody();
    const content = String(form.content ?? "");
    const overridePath = resolve(getConfig().dataDir, "prompts", "overrides", `${key}.md`);
    writeFileSync(overridePath, content, { mode: 0o600 });
    return c.html(flash("ok", `Saved override at ${overridePath}`));
  });

  app.delete("/prompts/:key", (c) => {
    const key = c.req.param("key");
    if (!/^[a-z0-9_-]+$/i.test(key)) return c.html(flash("error", "Bad key"), 400);
    const overridePath = resolve(getConfig().dataDir, "prompts", "overrides", `${key}.md`);
    if (existsSync(overridePath)) {
      unlinkSync(overridePath);
      return c.html(flash("ok", `Deleted override at ${overridePath}`));
    }
    return c.html(flash("ok", "No override to delete"));
  });

  // -------- Settings (global YAML) --------
  app.get("/settings", (c) => {
    const config = getConfig();
    const path = resolve(config.dataDir, "config", "openronin.yaml");
    const text = existsSync(path) ? readFileSync(path, "utf8") : "";
    const body = html`
      <h1 class="text-2xl font-semibold mb-4">Settings</h1>
      <p class="text-xs text-muted mb-4">
        Global config at <code>${path}</code> — fs.watch reloads on save.
      </p>
      <div id="flash" class="mb-3"></div>
      <form hx-post="/admin/settings" hx-target="#flash">
        <textarea
          name="yaml"
          rows="24"
          spellcheck="false"
          class="w-full border rounded px-3 py-2 text-sm"
        >
${text}</textarea
        >
        <div class="mt-3">
          <button class="bg-slate-900 text-white rounded px-4 py-2 text-sm">Save</button>
        </div>
      </form>
    `;
    return c.html(
      page({ title: "Settings", section: "settings", body, isHtmx: isHtmx(c.req.raw.headers) }),
    );
  });

  app.post("/settings", async (c) => {
    const form = await c.req.parseBody();
    const text = String(form.yaml ?? "");
    try {
      YAML.parse(text);
    } catch (error) {
      return c.html(
        flash("error", `Invalid YAML: ${error instanceof Error ? error.message : String(error)}`),
        400,
      );
    }
    const path = resolve(getConfig().dataDir, "config", "openronin.yaml");
    writeFileSync(path, text, { mode: 0o600 });
    return c.html(flash("ok", `Saved ${path}`));
  });

  // -------- Audit log page --------
  app.get("/audit", (c) => {
    const limit = Number(c.req.query("limit") ?? "100");
    const rows = db
      .prepare(
        `SELECT id, method, path, actor, created_at
         FROM admin_audit ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as {
      id: number;
      method: string;
      path: string;
      actor: string;
      created_at: string;
    }[];

    const methodClass = (m: string) =>
      m === "POST" ? "badge-success" : m === "DELETE" ? "badge-danger" : "badge-info";

    const tableRows = rows.map(
      (r) => html`<tr class="border-t">
        <td class="px-3 py-1.5 text-xs text-muted font-mono">${String(r.id)}</td>
        <td class="px-3 py-1.5">
          <span class="${methodClass(r.method)} px-1.5 py-0.5 rounded text-xs font-mono"
            >${r.method}</span
          >
        </td>
        <td class="px-3 py-1.5 font-mono text-sm">${r.path}</td>
        <td class="px-3 py-1.5 text-sm text-muted">${r.actor}</td>
        <td class="px-3 py-1.5 text-sm">${time(r.created_at)}</td>
      </tr>`,
    );

    const body = html`
      <div class="flex items-center justify-between mb-4">
        <h1 class="text-2xl font-bold">Audit Log</h1>
        <div class="flex gap-2">
          <a
            href="/admin/api/export/audit.csv"
            class="text-xs px-2 py-1 rounded border border-subtle hover:bg-sunken"
            >Export CSV</a
          >
        </div>
      </div>
      <p class="text-sm text-muted mb-4">All POST/PUT/DELETE admin actions are recorded here.</p>
      <div class="mobile-scroll-x">
        <table class="w-full text-sm bg-elevated border rounded shadow-sm mobile-table">
          <thead class="bg-surface text-secondary text-left text-xs">
            <tr>
              <th class="px-3 py-2">ID</th>
              <th class="px-3 py-2">Method</th>
              <th class="px-3 py-2">Path</th>
              <th class="px-3 py-2">Actor</th>
              <th class="px-3 py-2">Time</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows}
          </tbody>
        </table>
      </div>
      ${rows.length === 0
        ? html`<p class="text-muted text-sm mt-4">No audit entries yet.</p>`
        : raw("")}
    `;
    return c.html(
      page({ title: "Audit", section: "audit", body, isHtmx: isHtmx(c.req.raw.headers) }),
    );
  });

  // -------- CSV/JSON exports --------
  app.get("/api/export/tasks.csv", (_c) => {
    const rows = db
      .prepare(
        `SELECT t.id, r.owner||'/'||r.name AS repo, t.external_id, t.kind,
                t.status, t.priority, t.last_run_at, t.next_due_at, t.last_error
         FROM tasks t JOIN repos r ON r.id = t.repo_id
         ORDER BY t.id DESC LIMIT 10000`,
      )
      .all() as Record<string, unknown>[];
    const header = "id,repo,external_id,kind,status,priority,last_run_at,next_due_at,last_error";
    const csvRows = rows.map((r) =>
      [
        r.id,
        r.repo,
        r.external_id,
        r.kind,
        r.status,
        r.priority,
        r.last_run_at ?? "",
        r.next_due_at ?? "",
        (r.last_error ?? "").toString().replace(/"/g, '""'),
      ]
        .map((v) => `"${v}"`)
        .join(","),
    );
    return new Response([header, ...csvRows].join("\n"), {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": 'attachment; filename="tasks.csv"',
      },
    });
  });

  app.get("/api/export/tasks.json", (c) => {
    const rows = db
      .prepare(
        `SELECT t.id, r.owner||'/'||r.name AS repo, t.external_id, t.kind,
                t.status, t.priority, t.last_run_at, t.next_due_at, t.last_error
         FROM tasks t JOIN repos r ON r.id = t.repo_id
         ORDER BY t.id DESC LIMIT 10000`,
      )
      .all();
    return c.json(rows);
  });

  app.get("/api/export/runs.csv", (_c) => {
    const rows = db
      .prepare(
        `SELECT ru.id, r.owner||'/'||r.name AS repo, ru.lane, ru.engine, ru.model,
                ru.started_at, ru.finished_at, ru.tokens_in, ru.tokens_out,
                ru.cost_usd, ru.status, ru.error
         FROM runs ru
         JOIN tasks t ON t.id = ru.task_id
         JOIN repos r ON r.id = t.repo_id
         ORDER BY ru.id DESC LIMIT 10000`,
      )
      .all() as Record<string, unknown>[];
    const header =
      "id,repo,lane,engine,model,started_at,finished_at,tokens_in,tokens_out,cost_usd,status,error";
    const csvRows = rows.map((r) =>
      [
        r.id,
        r.repo,
        r.lane,
        r.engine,
        r.model ?? "",
        r.started_at,
        r.finished_at ?? "",
        r.tokens_in ?? "",
        r.tokens_out ?? "",
        r.cost_usd ?? "",
        r.status,
        (r.error ?? "").toString().replace(/"/g, '""'),
      ]
        .map((v) => `"${v}"`)
        .join(","),
    );
    return new Response([header, ...csvRows].join("\n"), {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": 'attachment; filename="runs.csv"',
      },
    });
  });

  app.get("/api/export/runs.json", (c) => {
    const rows = db
      .prepare(
        `SELECT ru.id, r.owner||'/'||r.name AS repo, ru.lane, ru.engine, ru.model,
                ru.started_at, ru.finished_at, ru.tokens_in, ru.tokens_out,
                ru.cost_usd, ru.status, ru.error
         FROM runs ru
         JOIN tasks t ON t.id = ru.task_id
         JOIN repos r ON r.id = t.repo_id
         ORDER BY ru.id DESC LIMIT 10000`,
      )
      .all();
    return c.json(rows);
  });

  app.get("/api/export/audit.csv", (_c) => {
    const rows = db
      .prepare(
        "SELECT id, method, path, actor, created_at FROM admin_audit ORDER BY id DESC LIMIT 10000",
      )
      .all() as Record<string, unknown>[];
    const header = "id,method,path,actor,created_at";
    const csvRows = rows.map((r) =>
      [r.id, r.method, r.path, r.actor, r.created_at].map((v) => `"${v}"`).join(","),
    );
    return new Response([header, ...csvRows].join("\n"), {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": 'attachment; filename="audit.csv"',
      },
    });
  });

  return app;
}

// ---- helpers ----

// Render a panel of recent errored runs at the top of the dashboard so
// failures are visible at a glance, not buried in /admin/logs.
function recentErrorsPanel(db: Db): TrustedHtml {
  const errs = db
    .prepare(
      `SELECT r.id, r.task_id, r.lane, r.engine, r.model, r.started_at, substr(r.error,1,300) AS error
         FROM runs r
        WHERE r.status='error'
          AND r.started_at >= datetime('now','-24 hours')
        ORDER BY r.id DESC
        LIMIT 5`,
    )
    .all() as Array<{
    id: number;
    task_id: number;
    lane: string;
    engine: string;
    model: string | null;
    started_at: string;
    error: string | null;
  }>;
  if (errs.length === 0) return raw("");
  return html`<section class="mb-6">
    <h2 class="text-lg font-semibold mb-2 text-red-700">
      Recent errors (last 24h, ${errs.length})
    </h2>
    <ul class="space-y-1.5 bg-red-50 border border-red-200 rounded p-3 text-sm">
      ${errs.map(
        (e) =>
          html`<li class="flex items-start gap-2">
            <span class="text-red-600 mt-0.5">●</span>
            <div class="flex-1">
              <div class="text-xs text-muted">
                <a href="/admin/tasks/${e.task_id}" class="text-blue-700 hover:underline"
                  >task #${e.task_id}</a
                >
                ·
                <span class="font-mono">${e.lane}</span>
                ·
                <span class="font-mono">${e.engine}/${e.model ?? "?"}</span>
                · ${time(e.started_at)}
              </div>
              <div class="text-red-900 break-words">${(e.error ?? "").slice(0, 240)}</div>
            </div>
          </li>`,
      )}
    </ul>
  </section>`;
}

function statCard(label: string, value: number, color = "slate", href?: string): TrustedHtml {
  const C: Record<string, { border: string; text: string }> = {
    slate: { border: "var(--border-strong)", text: "var(--fg-primary)" },
    blue: { border: "var(--status-info-border)", text: "var(--status-info-fg)" },
    green: { border: "var(--status-success-border)", text: "var(--status-success-fg)" },
    yellow: { border: "var(--status-warning-border)", text: "var(--status-warning-fg)" },
    red: { border: "var(--status-danger-border)", text: "var(--status-danger-fg)" },
  };
  const { border, text } = C[color] ?? C["slate"]!;
  const inner = raw(
    `<div class="text-xs uppercase tracking-wide text-muted font-medium mb-1">${escapeHtml(label)}</div>` +
      `<div class="text-3xl font-bold leading-none" style="color:${text}">${escapeHtml(String(value))}</div>`,
  );
  const baseStyle = `border-left:3px solid ${border}`;
  if (href) {
    return html`<a
      href="${href}"
      class="block rounded-lg bg-elevated border border-subtle shadow-sm p-4 hover:shadow-md transition-shadow"
      style="${baseStyle}"
      >${inner}</a
    >`;
  }
  return html`<div
    class="rounded-lg bg-elevated border border-subtle shadow-sm p-4"
    style="${baseStyle}"
  >
    ${inner}
  </div>`;
}

function flash(kind: "ok" | "error", message: string): string {
  const cls = kind === "ok" ? "badge-success" : "badge-danger";
  return html`<div class="border rounded px-3 py-2 text-sm ${cls}">${message}</div>`.toString();
}

// Annotated deploy config examples — surfaced via 'Show config example'
// on the repo settings page. Two variants, fully commented, copy-pastable.
function deployConfigExamplePanel(): TrustedHtml {
  const localExample = `# Mode "local" — commands run on this openronin host itself.
# Use this for self-deploy of openronin, or for any project that lives
# on the same machine as openronin.
deploy:
  mode: local
  trigger_branch: main          # only push events on this ref trigger deploy
  bot_login: openronin-bot      # which GitHub user must be the pusher
  require_bot_push: true        # set false to also accept human pushes
  commands:
    # Each command runs in a fresh \`bash -c\` on the openronin host.
    # Use absolute paths — there's no implicit cwd.
    - cd /opt/myapp && git pull --ff-only
    - cd /opt/myapp && pnpm install --frozen-lockfile
    - cd /opt/myapp && pnpm build
    # --no-block is critical for self-restart: returns immediately so the
    # current process can finish the request before systemd kills it.
    - sudo /bin/systemctl --no-block restart myapp`;

  const sshExample = `# Mode "ssh" — commands are wrapped in \`ssh user@host\` and run on the
# remote target. Use this for projects deployed elsewhere.
deploy:
  mode: ssh
  trigger_branch: main
  bot_login: openronin-bot      # GITHUB user whose pushes trigger deploy
  require_bot_push: true
  ssh:
    # LINUX user on the target server (NOT a GitHub login!).
    # Whatever you'd type in 'ssh THIS_USER@host'.
    user: deploy
    # Hostname or IP of the target. NO 'user@' prefix here.
    host: example.com           # or 10.0.0.5, srv.acme.tld, etc.
    port: 22                    # default 22; set if non-standard
    # Path to the matching PRIVATE key on THIS openronin host. The
    # public-key half of this pair must be in ~/.ssh/authorized_keys
    # of the LINUX user above on the target. Use 'Show SSH public key'
    # to copy it. Leave empty to use ~/.ssh/id_ed25519 / id_rsa.
    key_path: /var/lib/openronin/secrets/ssh/id_ed25519
    # Disable to skip host-key verification (NOT recommended for prod).
    strict_host_key_checking: true
  commands:
    # Each command runs in a fresh remote shell. Use absolute paths.
    # No interactive prompts — sudo must be passwordless.
    - cd /opt/myapp && git pull --ff-only
    - cd /opt/myapp && npm ci --omit=dev
    - cd /opt/myapp && npm run build
    - sudo /bin/systemctl --no-block restart myapp`;

  return html`<div class="bg-blue-50 border border-blue-200 rounded p-3 text-sm space-y-3">
    <p class="text-blue-900">
      Скопируй один из примеров ниже в YAML репозитория (выше на этой странице) и поправь под себя.
      После сохранения конфиг подхватится без рестарта.
    </p>

    <details open>
      <summary class="font-medium cursor-pointer">Local — деплой на этом же сервере</summary>
      <pre
        class="bg-slate-900 text-slate-100 p-3 rounded text-xs overflow-x-auto select-all mt-2"
      ><code>${localExample}</code></pre>
      <p class="text-xs text-secondary mt-1">
        Pre-req: пользователю <code>claude</code> должен быть прописан sudoers-entry для
        <code>systemctl --no-block restart &lt;service&gt;</code> (см.
        <code>/etc/sudoers.d/openronin-deploy</code>).
      </p>
    </details>

    <details>
      <summary class="font-medium cursor-pointer">SSH — деплой на удалённый сервер</summary>
      <pre
        class="bg-slate-900 text-slate-100 p-3 rounded text-xs overflow-x-auto select-all mt-2"
      ><code>${sshExample}</code></pre>
      <ol class="text-xs text-secondary mt-2 space-y-1 list-decimal list-inside">
        <li>Нажми «Show SSH public key» — скопируй открытый ключ.</li>
        <li>
          На target-сервере под нужным пользователем добавь его в
          <code>~/.ssh/authorized_keys</code>.
        </li>
        <li>
          В YAML укажи <code>ssh.host: user@host</code> и <code>ssh.key_path</code> = путь к
          приватному ключу здесь (обычно совпадает с тем, что показывает «Show SSH public key» без
          <code>.pub</code>).
        </li>
        <li>
          На target-сервере sudo тоже должен быть passwordless для команд, которые ты вызываешь —
          иначе ssh подвиснет на запросе пароля.
        </li>
        <li>Нажми «Deploy now» один раз — увидишь, прошло или нет.</li>
      </ol>
    </details>

    <details>
      <summary class="font-medium cursor-pointer">Поля по порядку</summary>
      <dl class="text-xs grid grid-cols-[180px_1fr] gap-x-2 gap-y-1 mt-2">
        <dt><code>mode</code></dt>
        <dd>disabled (default) | local | ssh</dd>
        <dt><code>trigger_branch</code></dt>
        <dd>push на эту ветку запускает деплой; обычно <code>main</code></dd>
        <dt><code>bot_login</code></dt>
        <dd>GitHub-логин, чьи push'и считаются доверенными (НЕ ssh-юзер!)</dd>
        <dt><code>require_bot_push</code></dt>
        <dd>если true — деплой только на push'и от bot_login</dd>
        <dt><code>ssh.user</code></dt>
        <dd>Linux-пользователь на target-сервере (то, что после ssh)</dd>
        <dt><code>ssh.host</code></dt>
        <dd>hostname или IP, БЕЗ префикса <code>user@</code></dd>
        <dt><code>ssh.port</code></dt>
        <dd>SSH-порт; default 22</dd>
        <dt><code>ssh.key_path</code></dt>
        <dd>путь к приватному ключу НА ЭТОМ сервере; пустая строка = ~/.ssh/id_*</dd>
        <dt><code>ssh.strict_host_key_checking</code></dt>
        <dd>true (default) — проверка known_hosts; false — отключить (не рекомендуется)</dd>
        <dt><code>commands</code></dt>
        <dd>
          массив shell-команд, выполняются последовательно; первый ненулевой exit code = деплой
          failed
        </dd>
      </dl>
    </details>
  </div>`;
}

// Manual webhook setup panel — for repos where the bot's PAT can't create
// webhooks via the API. Shows callback URL, secret, content-type, events,
// and a one-click link to GitHub's webhook creation form. Includes a
// "rotate secret" mini-action and a "copy" button per field.
function webhookInfoPanel(
  repoId: number,
  callback: string,
  secret: string,
  ghHooksUrl: string,
  notice?: string,
): TrustedHtml {
  const events = "issues, issue_comment, pull_request, pull_request_review";
  return html`<div class="bg-blue-50 border border-blue-200 rounded p-3 text-sm space-y-2">
    ${notice ? html`<div class="text-green-800 text-xs">✓ ${notice}</div>` : raw("")}
    <p class="text-blue-900">
      Скопируй значения ниже в
      <a class="underline" target="_blank" href="${ghHooksUrl}"
        >GitHub → Settings → Webhooks → Add</a
      >. Это обходной путь для приватных репозиториев, где у бота нет admin-прав.
    </p>
    <dl class="grid grid-cols-[120px_1fr] gap-y-1 gap-x-2">
      <dt class="text-secondary">Payload URL</dt>
      <dd>
        <code class="bg-elevated px-1.5 py-0.5 rounded select-all break-all">${callback}</code>
      </dd>
      <dt class="text-secondary">Content type</dt>
      <dd><code class="bg-elevated px-1.5 py-0.5 rounded">application/json</code></dd>
      <dt class="text-secondary">Secret</dt>
      <dd>
        <code class="bg-elevated px-1.5 py-0.5 rounded select-all break-all">${secret}</code>
      </dd>
      <dt class="text-secondary">SSL</dt>
      <dd><span class="text-secondary">Enable verification (recommended)</span></dd>
      <dt class="text-secondary">Events</dt>
      <dd>
        <span class="text-secondary">«Let me select individual events»: ${events}</span>
      </dd>
      <dt class="text-secondary">Active</dt>
      <dd><span class="text-secondary">checked</span></dd>
    </dl>
    <div class="flex gap-2 pt-1 text-xs">
      <button
        type="button"
        hx-post="/admin/api/repos/${repoId}/rotate-webhook-secret"
        hx-target="closest div.bg-blue-50"
        hx-swap="outerHTML"
        class="bg-yellow-600 hover:bg-yellow-700 text-white rounded px-2 py-1"
        onclick="return confirm('Rotate secret? You will need to re-paste it on GitHub.')"
      >
        Rotate secret
      </button>
      <a
        href="${ghHooksUrl}"
        target="_blank"
        class="bg-slate-700 hover:bg-slate-800 text-white rounded px-2 py-1"
        >Open GitHub webhook form ↗</a
      >
    </div>
  </div>`;
}

// Manual label setup panel — for when the bot's token can't create labels
// (read-only collaborator, etc.). Includes copy-friendly name + color +
// description per label and a direct deep-link to GitHub's "new label"
// form with the name prefilled via the q= query param.
function labelInfoPanel(
  owner: string,
  name: string,
  labels: Array<{ name: string; color: string; description: string }>,
): TrustedHtml {
  const labelsUrl = `https://github.com/${owner}/${name}/labels`;
  return html`<div class="bg-blue-50 border border-blue-200 rounded p-3 text-sm space-y-2">
    <p class="text-blue-900">
      Создай эти лейблы вручную в
      <a class="underline" target="_blank" href="${labelsUrl}">GitHub → Labels</a> через кнопку «New
      label». Обходной путь, если у бота нет прав на создание.
    </p>
    <ul class="space-y-2">
      ${labels.map(
        (l) =>
          html`<li class="bg-elevated rounded p-2 border">
            <div class="flex items-baseline gap-2 flex-wrap">
              <span
                class="inline-block rounded px-2 py-0.5 text-xs font-mono"
                style="background-color: #${l.color}; color: ${pickContrastColor(l.color)}"
                >${l.name}</span
              >
              <code class="text-xs select-all">${l.name}</code>
              <span class="text-muted text-xs">color #${l.color}</span>
            </div>
            <div class="text-xs text-secondary mt-1">${l.description}</div>
            <div class="text-xs mt-1">
              <a
                target="_blank"
                href="https://github.com/${owner}/${name}/labels?q=${encodeURIComponent(l.name)}"
                class="text-blue-700 underline"
                >check on GitHub ↗</a
              >
            </div>
          </li>`,
      )}
    </ul>
    <p class="text-xs text-secondary">
      После создания нажми «Verify / create labels» — бот пере-проверит и поймёт, что они уже есть.
    </p>
  </div>`;
}

// Pick black or white text color for readability on a hex background.
function pickContrastColor(hexColor: string): string {
  const r = parseInt(hexColor.slice(0, 2), 16);
  const g = parseInt(hexColor.slice(2, 4), 16);
  const b = parseInt(hexColor.slice(4, 6), 16);
  // Standard luminance check
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  return luma > 160 ? "#000" : "#fff";
}

// Pause toggle widget — used both as the header indicator (auto-refreshed)
// and as the response body of the pause/resume endpoints (so HTMX swaps
// in-place without a page reload.
//
// The hidden `.pause-active` span is a CSS hook: the header rule
// `#app-header:has(.pause-active)` adds a warning-coloured top border when ON.
export function pauseControl(paused: boolean, reason?: string): string {
  if (paused) {
    return html`<div class="inline-flex items-center gap-2">
      <span class="pause-active hidden"></span>
      <span
        class="inline-flex items-center gap-1 text-xs text-amber-300"
        title="${reason ?? "system mutations are paused"}"
      >
        <span class="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block shrink-0"></span>
        paused
      </span>
      <form
        hx-post="/admin/api/resume"
        hx-target="#pause-state-container"
        hx-swap="innerHTML"
        class="inline"
      >
        <button
          type="submit"
          role="switch"
          aria-checked="true"
          title="Click to resume"
          class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full bg-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:ring-offset-1 focus:ring-offset-slate-900"
        >
          <span
            class="absolute right-[3px] top-[3px] h-3.5 w-3.5 rounded-full bg-white shadow"
          ></span>
        </button>
      </form>
    </div>`.toString();
  }
  return html`<div class="inline-flex items-center gap-2">
    <span class="inline-flex items-center gap-1 text-xs text-slate-400">
      <span class="w-1.5 h-1.5 rounded-full bg-green-400 inline-block shrink-0"></span>
      running
    </span>
    <form
      hx-post="/admin/api/pause"
      hx-target="#pause-state-container"
      hx-swap="innerHTML"
      hx-confirm="Pause all mutations? Webhooks still queue tasks but the worker will skip them until resumed."
      class="inline"
    >
      <button
        type="submit"
        role="switch"
        aria-checked="false"
        title="Click to pause"
        class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full bg-slate-600 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-1 focus:ring-offset-slate-900"
      >
        <span class="absolute left-[3px] top-[3px] h-3.5 w-3.5 rounded-full bg-white shadow"></span>
      </button>
    </form>
  </div>`.toString();
}

function runStatusClass(status: string): string {
  if (status === "ok") return "badge-success";
  if (status === "running") return "badge-info";
  if (status === "error") return "badge-danger";
  return "badge-neutral";
}

function runStatusTone(status: string): BadgeTone {
  if (status === "ok") return "success";
  if (status === "running") return "info";
  if (status === "error") return "danger";
  return "neutral";
}

function taskStatusClass(status: string): string {
  if (status === "done") return "badge-success";
  if (status === "running") return "badge-info";
  if (status === "pending") return "badge-warning";
  if (status === "error") return "badge-danger";
  return "badge-neutral";
}

function getProjectRoot(): string {
  // dist/server/admin.js → ../..
  return resolve(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "..", "..");
}

function safeJson(s: string): { decision?: string; close_reason?: string } | null {
  try {
    return JSON.parse(s) as { decision?: string; close_reason?: string };
  } catch {
    return null;
  }
}

function reloadConfig(current: RuntimeConfig): RuntimeConfig {
  return loadConfig({ dataDir: current.dataDir });
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

function buildQueryString(params: Record<string, string | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  return parts.join("&");
}

interface ActivePr {
  taskId: number;
  prNumber: number;
  url: string;
  repo: string;
  title: string;
  branch: string;
  status: string;
  iterations: number;
  maxIterations: number;
  lastTouched: string | null;
  newFeedbackCount: number;
  ownerPendingReviewCount: number;
}

// Per-call timeout for the live-data variant. Octokit's retry plugin can chain
// 10-second waits when GitHub is flaky; rendering the dashboard must not block.
const LIVE_FETCH_TIMEOUT_MS = 4000;

async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((res) => {
    timer = setTimeout(() => res(fallback), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Cheap variant: only DB data, no GitHub calls. Used to render the dashboard
// instantly; the panel then asks for live counts via HTMX.
function fetchActivePrsFromDb(db: Db, config: RuntimeConfig): ActivePr[] {
  const branches = listPrBranches(db, 200).filter(
    (b) => b.pr_number != null && b.status !== "closed",
  );
  const out: ActivePr[] = [];
  for (const b of branches) {
    const task = db
      .prepare(
        `SELECT t.*, r.provider AS provider, r.owner AS owner, r.name AS repo_name
         FROM tasks t JOIN repos r ON r.id = t.repo_id WHERE t.id = ?`,
      )
      .get(b.task_id) as
      | { id: number; provider: string; owner: string; repo_name: string }
      | undefined;
    if (!task) continue;
    const repoCfg = config.repos.find((r) => r.owner === task.owner && r.name === task.repo_name);
    if (!repoCfg) continue;
    out.push({
      taskId: b.task_id,
      prNumber: b.pr_number ?? 0,
      url: b.pr_url ?? `https://github.com/${repoCfg.owner}/${repoCfg.name}/pull/${b.pr_number}`,
      repo: `${repoCfg.owner}/${repoCfg.name}`,
      title: `PR #${b.pr_number}`,
      branch: b.branch,
      status: b.status,
      iterations: b.iterations,
      maxIterations: repoCfg.pr_dialog_max_iterations,
      lastTouched: b.updated_at,
      newFeedbackCount: 0,
      ownerPendingReviewCount: 0,
    });
  }
  return out;
}

async function fetchActivePrs(db: Db, config: RuntimeConfig): Promise<ActivePr[]> {
  const branches = listPrBranches(db, 200).filter(
    (b) => b.pr_number != null && b.status !== "closed",
  );
  if (branches.length === 0) return [];

  let provider: GithubVcsProvider | undefined;
  try {
    provider = new GithubVcsProvider();
  } catch {
    provider = undefined;
  }

  const out: ActivePr[] = [];
  for (const b of branches) {
    const task = db
      .prepare(
        `SELECT t.*, r.provider AS provider, r.owner AS owner, r.name AS repo_name
         FROM tasks t JOIN repos r ON r.id = t.repo_id WHERE t.id = ?`,
      )
      .get(b.task_id) as
      | { id: number; provider: string; owner: string; repo_name: string }
      | undefined;
    if (!task) continue;
    const repoCfg = config.repos.find((r) => r.owner === task.owner && r.name === task.repo_name);
    if (!repoCfg) continue;

    let title = `PR #${b.pr_number}`;
    let newFeedbackCount = 0;
    let ownerPendingReviewCount = 0;
    if (provider) {
      const itemPromise = provider
        .getItem({ owner: repoCfg.owner, name: repoCfg.name }, Number(b.pr_number))
        .catch(() => undefined);
      const since = b.updated_at ?? b.created_at;
      const feedbackPromise = provider
        .listAllPrFeedback({ owner: repoCfg.owner, name: repoCfg.name }, Number(b.pr_number))
        .catch(() => []);
      const reviewsPromise = provider
        .listPrReviews({ owner: repoCfg.owner, name: repoCfg.name }, Number(b.pr_number))
        .catch(() => []);

      const [item, feedback, reviews] = await Promise.all([
        withTimeout(itemPromise, LIVE_FETCH_TIMEOUT_MS, undefined),
        withTimeout(feedbackPromise, LIVE_FETCH_TIMEOUT_MS, [] as Awaited<typeof feedbackPromise>),
        withTimeout(reviewsPromise, LIVE_FETCH_TIMEOUT_MS, [] as Awaited<typeof reviewsPromise>),
      ]);
      if (item) title = item.title;
      newFeedbackCount = feedback.filter(
        (c) =>
          new Date(c.createdAt).getTime() > parseSqliteUtc(since).getTime() &&
          !repoCfg.pr_dialog_skip_authors.includes(c.author) &&
          !isBotMessage(c.body),
      ).length;
      ownerPendingReviewCount = reviews.filter((r) => r.state === "PENDING").length;
    }

    out.push({
      taskId: b.task_id,
      prNumber: b.pr_number ?? 0,
      url: b.pr_url ?? `https://github.com/${repoCfg.owner}/${repoCfg.name}/pull/${b.pr_number}`,
      repo: `${repoCfg.owner}/${repoCfg.name}`,
      title,
      branch: b.branch,
      status: b.status,
      iterations: b.iterations,
      maxIterations: repoCfg.pr_dialog_max_iterations,
      lastTouched: b.updated_at,
      newFeedbackCount,
      ownerPendingReviewCount,
    });
  }
  return out;
}

function prStatusClass(status: string): string {
  if (status === "open") return "badge-success";
  if (status === "needs_human") return "badge-warning";
  if (status === "guardrail_blocked" || status === "dirty") return "badge-danger";
  if (status === "closed") return "badge-neutral";
  return "badge-neutral";
}

function deploySection(db: Db, config: RuntimeConfig): TrustedHtml {
  const repos = listRepos(db, { watchedOnly: true });
  const deployRepos = repos.filter((r) => {
    const repoCfg = config.repos.find((c) => c.owner === r.owner && c.name === r.name);
    return repoCfg && repoCfg.deploy.commands.length > 0;
  });

  if (deployRepos.length === 0) {
    return raw("");
  }

  const recent = listRecentDeploys(db, 5);

  const lastDeploy = recent.find((d) => d.status === "ok");
  const markerHtml: TrustedHtml = lastDeploy
    ? html`<p class="text-sm text-green-700 font-mono mb-3">
        deployed @ ${lastDeploy.sha.slice(0, 8)} at
        ${lastDeploy.finished_at ?? lastDeploy.started_at}
      </p>`
    : raw(`<p class="text-sm text-muted mb-3">no successful deploy yet</p>`);

  const rows: TrustedHtml =
    recent.length === 0
      ? raw("<tr><td colspan=5 class='py-2 text-muted text-xs px-2'>no deploys yet</td></tr>")
      : html`${recent.map(
          (d) => html`<tr class="border-t">
            <td class="px-2 py-1.5 text-xs font-mono">${d.sha.slice(0, 8)}</td>
            <td class="px-2 py-1.5 text-xs">${d.branch}</td>
            <td class="px-2 py-1.5 text-xs">${d.triggered_by}</td>
            <td class="px-2 py-1.5">
              <span
                class="${d.status === "ok"
                  ? "badge-success"
                  : d.status === "running"
                    ? "badge-info"
                    : "badge-danger"} px-1.5 py-0.5 rounded text-xs"
                >${d.status}</span
              >
            </td>
            <td class="px-2 py-1.5 text-xs text-muted max-w-xs truncate">
              ${d.status === "error" ? (d.error ?? "") : (d.finished_at ?? d.started_at)}
            </td>
          </tr>`,
        )}`;

  return html`
    <h2 class="text-lg font-semibold mb-2">Deploy (CD)</h2>
    ${markerHtml}
    <table class="w-full text-sm bg-elevated border rounded shadow-sm">
      <thead class="bg-surface text-secondary text-left text-xs">
        <tr>
          <th class="px-2 py-2">SHA</th>
          <th class="px-2 py-2">Branch</th>
          <th class="px-2 py-2">By</th>
          <th class="px-2 py-2">Status</th>
          <th class="px-2 py-2">Detail</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `;
}

function prAwaitingLabel(p: ActivePr): import("./layout.js").TrustedHtml {
  const parts: import("./layout.js").TrustedHtml[] = [];
  if (p.ownerPendingReviewCount > 0) {
    parts.push(
      raw(
        `<span class="text-amber-700">⚠ ${p.ownerPendingReviewCount} unsubmitted draft review${p.ownerPendingReviewCount > 1 ? "s" : ""}</span>`,
      ),
    );
  }
  if (p.newFeedbackCount > 0) {
    parts.push(
      raw(
        `<span class="text-blue-700">${p.newFeedbackCount} new comment${p.newFeedbackCount > 1 ? "s" : ""}</span>`,
      ),
    );
  }
  if (p.status === "needs_human") {
    parts.push(raw(`<span class="text-amber-700">awaiting your reply</span>`));
  }
  if (parts.length === 0) parts.push(raw(`<span class="text-muted">idle</span>`));
  return html`${parts}`;
}
