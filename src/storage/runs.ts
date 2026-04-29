import type { Db } from "./db.js";
import type { EngineUsage } from "../engines/index.js";

export interface RunRow {
  id: number;
  task_id: number;
  lane: string;
  engine: string;
  model: string | null;
  started_at: string;
  finished_at: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  status: string;
  error: string | null;
  log_path: string | null;
  prompt_log_path: string | null;
}

export function createRun(
  db: Db,
  args: { taskId: number; lane: string; engine: string; model?: string },
): number {
  const result = db
    .prepare("INSERT INTO runs (task_id, lane, engine, model) VALUES (?, ?, ?, ?)")
    .run(args.taskId, args.lane, args.engine, args.model ?? null);
  return Number(result.lastInsertRowid);
}

export interface FinishArgs {
  status: "ok" | "error";
  usage?: EngineUsage;
  error?: string;
  logPath?: string;
  promptLogPath?: string;
}

export function finishRun(db: Db, runId: number, args: FinishArgs): void {
  db.prepare(
    `UPDATE runs SET
       finished_at = datetime('now'),
       tokens_in = ?,
       tokens_out = ?,
       cost_usd = ?,
       status = ?,
       error = ?,
       log_path = ?,
       prompt_log_path = ?
     WHERE id = ?`,
  ).run(
    args.usage?.tokensIn ?? null,
    args.usage?.tokensOut ?? null,
    args.usage?.costUsd ?? null,
    args.status,
    args.error ?? null,
    args.logPath ?? null,
    args.promptLogPath ?? null,
    runId,
  );
}

export function getRunsByTask(db: Db, taskId: number): RunRow[] {
  return db
    .prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC")
    .all(taskId) as RunRow[];
}

export interface CostWindow {
  totalCostUsd: number;
  runs: number;
}

export function getCostUsdSince(db: Db, sinceIso: string): CostWindow {
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) AS total, COUNT(*) AS runs FROM runs WHERE started_at >= ?",
    )
    .get(sinceIso) as { total: number; runs: number };
  return { totalCostUsd: row.total, runs: row.runs };
}

export function listRecentRuns(db: Db, limit = 50): RunRow[] {
  return db.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?").all(limit) as RunRow[];
}

export interface CostGroup {
  key: string;
  cost: number;
  runs: number;
}

export function getCostGroupedByLane(db: Db, sinceIso: string): CostGroup[] {
  return db
    .prepare(
      `SELECT lane AS key, COALESCE(SUM(cost_usd), 0) AS cost, COUNT(*) AS runs
       FROM runs WHERE started_at >= ? GROUP BY lane ORDER BY cost DESC`,
    )
    .all(sinceIso) as CostGroup[];
}

export function getCostGroupedByEngine(db: Db, sinceIso: string): CostGroup[] {
  return db
    .prepare(
      `SELECT engine AS key, COALESCE(SUM(cost_usd), 0) AS cost, COUNT(*) AS runs
       FROM runs WHERE started_at >= ? GROUP BY engine ORDER BY cost DESC`,
    )
    .all(sinceIso) as CostGroup[];
}

export function getCostGroupedByRepo(db: Db, sinceIso: string): CostGroup[] {
  return db
    .prepare(
      `SELECT r.owner || '/' || r.name AS key,
              COALESCE(SUM(ru.cost_usd), 0) AS cost,
              COUNT(*) AS runs
       FROM runs ru
       JOIN tasks t ON t.id = ru.task_id
       JOIN repos r ON r.id = t.repo_id
       WHERE ru.started_at >= ?
       GROUP BY r.id ORDER BY cost DESC`,
    )
    .all(sinceIso) as CostGroup[];
}

export interface TasksPerDay {
  day: string;
  count: number;
}

export function getTasksPerDay(db: Db, sinceIso: string): TasksPerDay[] {
  return db
    .prepare(
      `SELECT DATE(started_at) AS day, COUNT(*) AS count
       FROM runs WHERE started_at >= ?
       GROUP BY day ORDER BY day`,
    )
    .all(sinceIso) as TasksPerDay[];
}

export interface SuccessRateRow {
  week: string;
  lane: string;
  ok_count: number;
  total: number;
}

export function getSuccessRateByLane(db: Db, sinceIso: string): SuccessRateRow[] {
  return db
    .prepare(
      `SELECT strftime('%Y-W%W', started_at) AS week, lane,
              SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok_count,
              COUNT(*) AS total
       FROM runs WHERE started_at >= ?
       GROUP BY week, lane ORDER BY week, lane`,
    )
    .all(sinceIso) as SuccessRateRow[];
}

export interface LatencyRow {
  model: string;
  engine: string;
  avg_seconds: number;
  runs: number;
}

export function getAvgLatencyByModel(db: Db, sinceIso: string): LatencyRow[] {
  return db
    .prepare(
      `SELECT COALESCE(model, engine) AS model, engine,
              AVG((julianday(finished_at) - julianday(started_at)) * 86400) AS avg_seconds,
              COUNT(*) AS runs
       FROM runs WHERE finished_at IS NOT NULL AND started_at >= ?
       GROUP BY COALESCE(model, engine), engine ORDER BY avg_seconds DESC`,
    )
    .all(sinceIso) as LatencyRow[];
}

export interface TokensPerDay {
  day: string;
  tokens_in: number;
  tokens_out: number;
}

export function getTokensPerDay(db: Db, sinceIso: string): TokensPerDay[] {
  return db
    .prepare(
      `SELECT DATE(started_at) AS day,
              COALESCE(SUM(tokens_in), 0) AS tokens_in,
              COALESCE(SUM(tokens_out), 0) AS tokens_out
       FROM runs WHERE started_at >= ?
       GROUP BY day ORDER BY day`,
    )
    .all(sinceIso) as TokensPerDay[];
}

export interface RunFilter {
  lane?: string;
  engine?: string;
  model?: string;
  status?: string;
  repo?: string;
  dateFrom?: string;
  dateTo?: string;
  errorSearch?: string;
  limit?: number;
  offset?: number;
}

export interface RunRowWithRepo extends RunRow {
  repo: string | null;
}

function buildRunFilter(filter: RunFilter): { where: string; params: (string | number)[] } {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (filter.lane) {
    conditions.push("ru.lane = ?");
    params.push(filter.lane);
  }
  if (filter.engine) {
    conditions.push("ru.engine = ?");
    params.push(filter.engine);
  }
  if (filter.model) {
    conditions.push("ru.model = ?");
    params.push(filter.model);
  }
  if (filter.status) {
    conditions.push("ru.status = ?");
    params.push(filter.status);
  }
  if (filter.repo) {
    conditions.push("(r.owner || '/' || r.name) = ?");
    params.push(filter.repo);
  }
  if (filter.dateFrom) {
    conditions.push("ru.started_at >= ?");
    params.push(filter.dateFrom);
  }
  if (filter.dateTo) {
    conditions.push("ru.started_at <= ?");
    params.push(filter.dateTo + "T23:59:59");
  }
  if (filter.errorSearch) {
    conditions.push("ru.error LIKE ?");
    params.push(`%${filter.errorSearch}%`);
  }
  return {
    where: conditions.length ? "WHERE " + conditions.join(" AND ") : "",
    params,
  };
}

export function listRunsFiltered(db: Db, filter: RunFilter): RunRowWithRepo[] {
  const { where, params } = buildRunFilter(filter);
  const limit = filter.limit ?? 50;
  const offset = filter.offset ?? 0;
  return db
    .prepare(
      `SELECT ru.*, r.owner || '/' || r.name AS repo
       FROM runs ru
       LEFT JOIN tasks t ON t.id = ru.task_id
       LEFT JOIN repos r ON r.id = t.repo_id
       ${where}
       ORDER BY ru.started_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as RunRowWithRepo[];
}

export interface RunDistincts {
  lanes: string[];
  engines: string[];
  models: string[];
  repos: string[];
}

export function getRunDistincts(db: Db): RunDistincts {
  const lanes = (
    db.prepare("SELECT DISTINCT lane FROM runs ORDER BY lane").all() as { lane: string }[]
  ).map((r) => r.lane);
  const engines = (
    db.prepare("SELECT DISTINCT engine FROM runs ORDER BY engine").all() as { engine: string }[]
  ).map((r) => r.engine);
  const models = (
    db.prepare("SELECT DISTINCT model FROM runs WHERE model IS NOT NULL ORDER BY model").all() as {
      model: string;
    }[]
  ).map((r) => r.model);
  const repos = (
    db
      .prepare(
        `SELECT DISTINCT r.owner || '/' || r.name AS repo
         FROM runs ru
         LEFT JOIN tasks t ON t.id = ru.task_id
         LEFT JOIN repos r ON r.id = t.repo_id
         WHERE repo IS NOT NULL ORDER BY repo`,
      )
      .all() as { repo: string }[]
  ).map((r) => r.repo);
  return { lanes, engines, models, repos };
}

export function getRunById(db: Db, id: number): RunRow | null {
  return (db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | null) ?? null;
}
