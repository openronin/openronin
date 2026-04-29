import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { healthzRoute } from "./healthz.js";
import { webhooksRoute } from "./webhooks.js";
import { adminRoute } from "./admin.js";
import { apiRoute } from "./api.js";
import type { RuntimeConfig } from "../config/schema.js";
import type { Db } from "../storage/db.js";
import type { SchedulerHandle } from "../scheduler/index.js";

const STARTED_AT = Date.now();

interface StartArgs {
  getConfig: () => RuntimeConfig;
  db: Db;
  scheduler?: SchedulerHandle;
}

export async function startServer({ getConfig, db, scheduler }: StartArgs): Promise<void> {
  const app = new Hono();
  app.route("/healthz", healthzRoute({ db, startedAt: STARTED_AT, getConfig }));
  app.route("/webhooks", webhooksRoute({ db, getConfig, scheduler }));
  app.route("/api", apiRoute({ db, getConfig }));
  // Hono route("/admin", ...) doesn't match the trailing-slash form when the subapp
  // has app.get("/"). Manually redirect "/admin/" → "/admin" to keep both URLs working.
  app.get("/admin/", (c) => c.redirect("/admin", 301));
  app.route("/admin", adminRoute({ db, getConfig, scheduler, startedAt: STARTED_AT }));
  app.get("/", (c) => c.json({ name: "openronin", version: "0.0.1" }));

  const port = getConfig().global.server.port;
  serve({ fetch: app.fetch, port }, (info) => {
    const config = getConfig();
    console.log(`openronin listening on http://localhost:${info.port}`);
    console.log(`baseUrl: ${config.global.server.baseUrl}`);
    console.log(`dataDir: ${config.dataDir}`);
    console.log(`watched repos: ${config.repos.length}`);
  });
}
