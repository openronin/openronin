import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Persisted summary of the last crash-recovery sweep. Lives outside the DB
// so the healthz endpoint can answer "when did we last recover, and from
// what?" without touching the live runs/tasks tables (which themselves get
// rewritten on each boot's recovery pass). The file is small and atomically
// replaced via write-then-rename so a SIGKILL mid-write can't corrupt it.
export interface RecoveryReport {
  // ISO timestamp the recovery sweep ran.
  ts: string;
  // Whether anything was actually recovered. False means a clean shutdown:
  // no rows were in 'running' state at startup.
  recovered: boolean;
  // Counts mirror recoverStuckTasks return shape.
  tasks: number;
  runs: number;
  deploys: number;
  // Whether the previous shutdown looked clean from this side (no orphaned
  // running rows of any kind). Mirrors `recovered === false` but kept
  // explicit for readability of operators inspecting the file.
  clean_shutdown: boolean;
}

function recoveryDir(dataDir: string): string {
  return resolve(dataDir, "recovery");
}

function reportPath(dataDir: string): string {
  return resolve(recoveryDir(dataDir), "last.json");
}

// Atomic write — render to a tmp sibling, then rename. SQLite's WAL plus
// systemd's TimeoutStopSec can mean SIGKILL strikes mid-write; rename is
// the only way to guarantee the operator never sees a half-written file.
export function writeRecoveryReport(dataDir: string, report: RecoveryReport): string {
  const dir = recoveryDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const target = reportPath(dataDir);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(report, null, 2) + "\n", { mode: 0o644 });
  renameSync(tmp, target);
  return target;
}

export function readRecoveryReport(dataDir: string): RecoveryReport | null {
  const path = reportPath(dataDir);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<RecoveryReport>;
    if (typeof parsed.ts !== "string") return null;
    return {
      ts: parsed.ts,
      recovered: Boolean(parsed.recovered),
      tasks: Number(parsed.tasks ?? 0),
      runs: Number(parsed.runs ?? 0),
      deploys: Number(parsed.deploys ?? 0),
      clean_shutdown: Boolean(parsed.clean_shutdown),
    };
  } catch {
    return null;
  }
}

export function recoveryReportAgeSec(report: RecoveryReport, now = Date.now()): number {
  const t = Date.parse(report.ts);
  if (Number.isNaN(t)) return -1;
  return Math.max(0, Math.floor((now - t) / 1000));
}
