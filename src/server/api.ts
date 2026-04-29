import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../storage/db.js";
import type { RuntimeConfig } from "../config/schema.js";
import {
  getCostGroupedByLane,
  getCostGroupedByEngine,
  getCostGroupedByRepo,
  getCostUsdSince,
} from "../storage/runs.js";
import { GithubVcsProvider } from "../providers/github.js";
import { isPaused } from "../lib/pause.js";
import { enqueue } from "../scheduler/queue.js";

interface Args {
  db: Db;
  getConfig: () => RuntimeConfig;
}

function safeCompare(a: string, b: string): boolean {
  const key = Buffer.alloc(32);
  const ha = createHmac("sha256", key).update(a).digest();
  const hb = createHmac("sha256", key).update(b).digest();
  return timingSafeEqual(ha, hb);
}

function parseWindow(w: string): string {
  const m = w.match(/^(\d+)([hdw])$/);
  if (!m) return new Date(Date.now() - 86400_000).toISOString();
  const mul: Record<string, number> = { h: 3600_000, d: 86400_000, w: 604800_000 };
  return new Date(Date.now() - parseInt(m[1]!) * (mul[m[2]!] ?? 86400_000)).toISOString();
}

export function apiRoute({ db, getConfig }: Args): Hono {
  const app = new Hono();

  // Public health check — no auth required
  app.get("/health", (c) => c.json({ ok: true }));

  // Bearer token auth for all other routes
  app.use("*", async (c, next) => {
    if (c.req.path.endsWith("/health")) return next();
    const token = process.env.OPENRONIN_API_TOKEN;
    if (!token) {
      return c.json(
        { error: { code: "api_disabled", message: "API disabled, set OPENRONIN_API_TOKEN" } },
        503,
      );
    }
    const authHeader = c.req.header("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return c.json({ error: { code: "unauthorized", message: "Bearer token required" } }, 401);
    }
    const provided = authHeader.slice(7);
    if (!safeCompare(token, provided)) {
      return c.json({ error: { code: "unauthorized", message: "Invalid token" } }, 401);
    }
    await next();
  });

  // GET /api/status
  app.get("/status", (c) => {
    const config = getConfig();
    const since24h = new Date(Date.now() - 86400_000).toISOString();
    const stats = db
      .prepare(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'pending') AS queued,
           COUNT(*) FILTER (WHERE status = 'running') AS running,
           COUNT(*) FILTER (WHERE status = 'done' AND last_run_at >= ?) AS done_24h
         FROM tasks`,
      )
      .get(since24h) as { queued: number; running: number; done_24h: number };
    const costRow = db
      .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM runs WHERE started_at >= ?")
      .get(since24h) as { total: number };
    const recentErrors = db
      .prepare(
        `SELECT t.id, r.owner || '/' || r.name AS repo, t.external_id, t.last_error, t.last_run_at
         FROM tasks t JOIN repos r ON r.id = t.repo_id
         WHERE t.last_error IS NOT NULL
         ORDER BY t.last_run_at DESC LIMIT 5`,
      )
      .all() as {
      id: number;
      repo: string;
      external_id: string;
      last_error: string;
      last_run_at: string;
    }[];
    return c.json({
      queued: stats.queued,
      running: stats.running,
      done_24h: stats.done_24h,
      today_cost_usd: costRow.total,
      paused: isPaused(config.dataDir),
      recent_errors: recentErrors,
    });
  });

  // GET /api/tasks?status=&repo=&limit=
  app.get("/tasks", (c) => {
    const status = c.req.query("status") ?? "";
    const repo = c.req.query("repo") ?? "";
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50") || 50, 200);

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (status) {
      conditions.push("t.status = ?");
      params.push(status);
    }
    if (repo.includes("/")) {
      const sep = repo.indexOf("/");
      const owner = repo.slice(0, sep);
      const name = repo.slice(sep + 1);
      if (owner && name) {
        conditions.push("r.owner = ? AND r.name = ?");
        params.push(owner, name);
      }
    }
    params.push(limit);

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `SELECT t.id, t.external_id, t.kind, t.status, t.priority,
                        t.last_run_at, t.last_error, t.next_due_at,
                        r.owner || '/' || r.name AS repo
                 FROM tasks t JOIN repos r ON r.id = t.repo_id ${where}
                 ORDER BY t.id DESC LIMIT ?`;

    const stmt = db.prepare(sql);
    const rows = stmt.all.apply(stmt, params as never[]) as unknown[];
    return c.json({ tasks: rows });
  });

  // GET /api/tasks/:id
  app.get("/tasks/:id", (c) => {
    const id = parseInt(c.req.param("id"));
    if (isNaN(id)) {
      return c.json({ error: { code: "bad_request", message: "Invalid task id" } }, 400);
    }
    const task = db
      .prepare(
        `SELECT t.id, t.external_id, t.kind, t.status, t.priority, t.last_run_at,
                t.last_error, t.next_due_at, t.decision_json,
                r.owner || '/' || r.name AS repo, r.provider
         FROM tasks t JOIN repos r ON r.id = t.repo_id WHERE t.id = ?`,
      )
      .get(id);
    if (!task) {
      return c.json({ error: { code: "not_found", message: "Task not found" } }, 404);
    }
    const runs = db
      .prepare(
        `SELECT id, lane, engine, model, started_at, finished_at, status, cost_usd, error
         FROM runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 10`,
      )
      .all(id);
    return c.json({ task, runs });
  });

  // POST /api/tasks/:id/enqueue
  app.post("/tasks/:id/enqueue", (c) => {
    const id = parseInt(c.req.param("id"));
    if (isNaN(id)) {
      return c.json({ error: { code: "bad_request", message: "Invalid task id" } }, 400);
    }
    const task = db.prepare("SELECT id FROM tasks WHERE id = ?").get(id);
    if (!task) {
      return c.json({ error: { code: "not_found", message: "Task not found" } }, 404);
    }
    enqueue(db, id, "high", null);
    return c.json({ ok: true, task_id: id, message: `Task ${id} enqueued with high priority` });
  });

  // POST /api/tasks/:id/cancel
  app.post("/tasks/:id/cancel", (c) => {
    const id = parseInt(c.req.param("id"));
    if (isNaN(id)) {
      return c.json({ error: { code: "bad_request", message: "Invalid task id" } }, 400);
    }
    const task = db.prepare("SELECT id FROM tasks WHERE id = ?").get(id);
    if (!task) {
      return c.json({ error: { code: "not_found", message: "Task not found" } }, 404);
    }
    db.prepare(
      "UPDATE tasks SET status = 'done', last_error = 'cancelled by api' WHERE id = ?",
    ).run(id);
    return c.json({ ok: true, task_id: id, message: `Task ${id} cancelled` });
  });

  // GET /api/prs
  app.get("/prs", (c) => {
    const prs = db
      .prepare(
        `SELECT pb.id, pb.branch, pb.pr_number, pb.pr_url, pb.status, pb.iterations,
                pb.created_at, pb.updated_at,
                r.owner || '/' || r.name AS repo, t.external_id AS issue_id
         FROM pr_branches pb
         JOIN tasks t ON t.id = pb.task_id
         JOIN repos r ON r.id = t.repo_id
         WHERE pb.status NOT IN ('closed', 'guardrail_blocked')
         ORDER BY pb.updated_at DESC LIMIT 50`,
      )
      .all();
    return c.json({ prs });
  });

  // POST /api/pause
  app.post("/pause", async (c) => {
    const config = getConfig();
    let reason = "";
    const ct = c.req.header("Content-Type") ?? "";
    if (ct.includes("application/json")) {
      try {
        const body = await c.req.json<{ reason?: string }>();
        reason = body.reason ?? "";
      } catch {
        // body is optional
      }
    }
    writeFileSync(join(config.dataDir, ".PAUSE"), reason || "paused via API");
    return c.json({ ok: true, message: "Scheduler paused", reason });
  });

  // POST /api/resume
  app.post("/resume", (c) => {
    const config = getConfig();
    const pauseFile = join(config.dataDir, ".PAUSE");
    if (existsSync(pauseFile)) {
      rmSync(pauseFile);
    }
    return c.json({ ok: true, message: "Scheduler resumed" });
  });

  // GET /api/cost?since=24h
  app.get("/cost", (c) => {
    const since = c.req.query("since") ?? "24h";
    const iso = parseWindow(since);
    const total = getCostUsdSince(db, iso);
    return c.json({
      since,
      total_cost_usd: total.totalCostUsd,
      total_runs: total.runs,
      by_lane: getCostGroupedByLane(db, iso),
      by_engine: getCostGroupedByEngine(db, iso),
      by_repo: getCostGroupedByRepo(db, iso),
    });
  });

  // POST /api/issues
  app.post("/issues", async (c) => {
    let body: { repo?: string; title?: string; body?: string; label_openronin?: boolean };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: "bad_request", message: "Invalid JSON body" } }, 400);
    }
    if (!body.repo || !body.title) {
      return c.json(
        { error: { code: "bad_request", message: "repo and title are required" } },
        400,
      );
    }
    const sep = body.repo.indexOf("/");
    if (sep < 1 || sep === body.repo.length - 1) {
      return c.json(
        { error: { code: "bad_request", message: "repo must be in owner/name format" } },
        400,
      );
    }
    const owner = body.repo.slice(0, sep);
    const name = body.repo.slice(sep + 1);
    try {
      const github = new GithubVcsProvider();
      const result = await github.createIssue(
        { owner, name },
        {
          title: body.title,
          body: body.body,
          labels: body.label_openronin ? ["openronin:do-it"] : [],
        },
      );
      return c.json({ ok: true, issue_url: result.url, issue_number: result.number });
    } catch (err) {
      return c.json({ error: { code: "github_error", message: String(err) } }, 502);
    }
  });

  return app;
}
