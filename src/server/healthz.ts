import { Hono } from "hono";
import type { Db } from "../storage/db.js";
import type { RuntimeConfig } from "../config/schema.js";
import { readRecoveryReport, recoveryReportAgeSec } from "../storage/recovery.js";
import { queueStats } from "../scheduler/queue.js";

interface Args {
  db: Db;
  startedAt: number;
  getConfig: () => RuntimeConfig;
}

interface RecoveryHealthBlock {
  ts: string;
  recovered: boolean;
  clean_shutdown: boolean;
  age_sec: number;
  tasks: number;
  runs: number;
  deploys: number;
}

export interface HealthzResponse {
  status: "ok" | "degraded" | "down";
  version: string;
  db_ok: boolean;
  data_dir: string;
  watched_repos: number;
  uptime_s: number;
  active_runs: number;
  queued_runs: number;
  last_recovery: RecoveryHealthBlock | null;
  ts: string;
}

export function buildHealthz(args: Args): HealthzResponse {
  const { db, startedAt, getConfig } = args;
  let dbOk = false;
  let activeRuns = 0;
  let queuedRuns = 0;
  try {
    const row = db.prepare("SELECT 1 AS ok").get() as { ok: number };
    dbOk = row.ok === 1;
  } catch {
    dbOk = false;
  }
  if (dbOk) {
    try {
      const running = db
        .prepare("SELECT COUNT(*) AS n FROM runs WHERE status = 'running'")
        .get() as { n: number };
      activeRuns = running.n;
    } catch {
      // Fall through with active_runs=0 rather than failing health entirely.
    }
    try {
      queuedRuns = queueStats(db).due;
    } catch {
      // Same — keep the endpoint responsive even if the count query trips.
    }
  }
  const config = getConfig();
  const report = readRecoveryReport(config.dataDir);
  const recoveryBlock: RecoveryHealthBlock | null = report
    ? {
        ts: report.ts,
        recovered: report.recovered,
        clean_shutdown: report.clean_shutdown,
        age_sec: recoveryReportAgeSec(report),
        tasks: report.tasks,
        runs: report.runs,
        deploys: report.deploys,
      }
    : null;
  return {
    status: dbOk ? "ok" : "down",
    version: "0.0.1",
    db_ok: dbOk,
    data_dir: config.dataDir,
    watched_repos: config.repos.length,
    uptime_s: Math.floor((Date.now() - startedAt) / 1000),
    active_runs: activeRuns,
    queued_runs: queuedRuns,
    last_recovery: recoveryBlock,
    ts: new Date().toISOString(),
  };
}

export function healthzRoute(args: Args): Hono {
  const app = new Hono();
  app.get("/", (c) => {
    const body = buildHealthz(args);
    // 503 only when the DB is genuinely unreachable. `degraded` is reserved
    // for future signals (e.g. last_recovery younger than N seconds) — keep
    // that path returning 200 so noisy boots don't trip external monitors.
    const httpStatus = body.status === "down" ? 503 : 200;
    return c.json(body, httpStatus);
  });
  return app;
}
