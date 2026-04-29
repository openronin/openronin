import { Hono } from "hono";
import type { Db } from "../storage/db.js";
import type { RuntimeConfig } from "../config/schema.js";

interface Args {
  db: Db;
  startedAt: number;
  getConfig: () => RuntimeConfig;
}

export function healthzRoute({ db, startedAt, getConfig }: Args): Hono {
  const app = new Hono();
  app.get("/", (c) => {
    let dbOk = false;
    try {
      const row = db.prepare("SELECT 1 AS ok").get() as { ok: number };
      dbOk = row.ok === 1;
    } catch {
      dbOk = false;
    }
    const config = getConfig();
    return c.json({
      status: dbOk ? "ok" : "degraded",
      version: "0.0.1",
      db_ok: dbOk,
      data_dir: config.dataDir,
      watched_repos: config.repos.length,
      uptime_s: Math.floor((Date.now() - startedAt) / 1000),
      ts: new Date().toISOString(),
    });
  });
  return app;
}
