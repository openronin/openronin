import { runCli } from "./cli/index.js";
import { startServer } from "./server/index.js";
import { loadConfig, watchConfig } from "./config/loader.js";
import { initDb } from "./storage/db.js";
import { syncReposFromConfig } from "./storage/repos.js";
import { startScheduler } from "./scheduler/index.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  const isServerMode = !cmd || cmd === "server";
  if (!isServerMode) {
    const result = await runCli(argv);
    process.exit(result.exitCode);
  }

  let config = loadConfig();
  const db = initDb(config.dataDir);
  syncReposFromConfig(db, config.repos);

  watchConfig(config.dataDir, () => {
    try {
      config = loadConfig({ dataDir: config.dataDir });
      syncReposFromConfig(db, config.repos);
      console.log(`[config] reloaded; ${config.repos.length} watched repo(s)`);
    } catch (error) {
      console.error("[config] reload error:", error);
    }
  });

  const { parseDurationMs } = await import("./scheduler/cadence.js");
  const sCfg = config.global.scheduler;
  const scheduler = startScheduler(db, () => config, {
    reconcileIntervalMs: parseDurationMs(sCfg.reconcile_interval),
    drainIntervalMs: parseDurationMs(sCfg.drain_interval),
    drainBatchSize: sCfg.drain_batch_size,
  });
  // Graceful shutdown: stop accepting new work, then wait up to 2 min for
  // in-flight workers to finish. Without this, every deploy SIGTERM kills
  // a mid-flight patch lane and crash-recovery resets it on next boot.
  // systemd's default TimeoutStopSec is 90s; if our wait exceeds it we'll
  // get SIGKILL anyway, so we cap the wait similarly.
  let shuttingDown = false;
  const gracefulExit = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} — waiting for workers to finish (max 90s)`);
    const result = await scheduler.stop(90_000);
    console.log(
      `[shutdown] ${result.idle ? "drained" : "forced"} after ${Math.round(result.waitedMs / 1000)}s`,
    );
    process.exit(0);
  };
  process.on("SIGTERM", () => void gracefulExit("SIGTERM"));
  process.on("SIGINT", () => void gracefulExit("SIGINT"));

  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  if (tgToken) {
    const { startTelegramPoller } = await import("./providers/telegram.js");
    void startTelegramPoller(db, () => config, tgToken);
  }

  await startServer({ getConfig: () => config, db, scheduler });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
