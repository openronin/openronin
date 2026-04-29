import type { Db } from "../storage/db.js";
import type { RuntimeConfig, RepoConfig } from "../config/schema.js";
import {
  getEngine,
  type Engine,
  type EngineProviderId,
  type EngineRunOptions,
  type EngineResult,
} from "../engines/index.js";
import { createRun, finishRun, getCostUsdSince } from "../storage/runs.js";
import { writeRunLog } from "../lib/run-logger.js";

export type JobType = "triage" | "analyze" | "deep_review" | "patch" | "patch_multi" | "pr_dialog";

export interface SupervisorContext {
  config: RuntimeConfig;
  db: Db;
  repo: RepoConfig;
}

export interface EngineChoice {
  engine: Engine;
  model: string;
  source: "cli_override" | "repo_override" | "global_default";
}

export interface SelectionOverride {
  engine?: EngineProviderId;
  model?: string;
}

// Choose which engine + model to use for a job.
// Precedence: explicit CLI override → per-repo override → global default.
export function selectEngine(
  ctx: SupervisorContext,
  jobType: JobType,
  override?: SelectionOverride,
): EngineChoice {
  if (override?.engine) {
    const engine = getEngine(override.engine);
    return {
      engine,
      model: override.model || engine.defaultModel,
      source: "cli_override",
    };
  }

  const repoRef = ctx.repo.engine_overrides[jobType];
  if (repoRef) {
    const engine = getEngine(repoRef.provider);
    return {
      engine,
      model: repoRef.model || engine.defaultModel,
      source: "repo_override",
    };
  }

  const globalRef = ctx.config.global.engines.defaults[jobType];
  const engine = getEngine(globalRef.provider);
  return {
    engine,
    model: globalRef.model || engine.defaultModel,
    source: "global_default",
  };
}

export class CostCapExceeded extends Error {
  constructor(
    public readonly totalUsd: number,
    public readonly capUsd: number,
  ) {
    super(`Daily cost cap exceeded: $${totalUsd.toFixed(4)} >= $${capUsd}`);
    this.name = "CostCapExceeded";
  }
}

export function checkDailyCostCap(ctx: SupervisorContext): void {
  const cap = ctx.config.global.cost_caps.per_day_usd;
  if (cap <= 0) return;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { totalCostUsd } = getCostUsdSince(ctx.db, since);
  if (totalCostUsd >= cap) {
    throw new CostCapExceeded(totalCostUsd, cap);
  }
}

export interface RunJobArgs {
  jobType: JobType;
  lane: string;
  taskId: number;
  override?: SelectionOverride;
  engineOpts: Omit<EngineRunOptions, "model">;
}

export interface RunJobResult {
  result: EngineResult;
  runId: number;
  choice: EngineChoice;
}

// Run a single engine call wrapped with: cost-cap check, DB run record, error capture.
export async function runJob(ctx: SupervisorContext, args: RunJobArgs): Promise<RunJobResult> {
  checkDailyCostCap(ctx);

  const choice = selectEngine(ctx, args.jobType, args.override);
  const runId = createRun(ctx.db, {
    taskId: args.taskId,
    lane: args.lane,
    engine: choice.engine.id,
    model: choice.model,
  });

  const timestamp = new Date().toISOString();
  const repo = `${ctx.repo.owner}/${ctx.repo.name}`;

  try {
    const result = await choice.engine.run({
      ...args.engineOpts,
      model: choice.model,
    });
    const logPath = writeRunLog(ctx.config.dataDir, runId, {
      lane: args.lane,
      engine: choice.engine.id,
      model: choice.model,
      status: "ok",
      repo,
      timestamp,
      system_prompt: args.engineOpts.systemPrompt,
      user_prompt: args.engineOpts.userPrompt,
      raw_response: result.raw ?? result.content,
      tokens_in: result.usage.tokensIn,
      tokens_out: result.usage.tokensOut,
      cost_usd: result.usage.costUsd,
      error_message: undefined,
      duration_ms: result.durationMs,
    });
    finishRun(ctx.db, runId, { status: "ok", usage: result.usage, logPath });
    return { result, runId, choice };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const logPath = writeRunLog(ctx.config.dataDir, runId, {
      lane: args.lane,
      engine: choice.engine.id,
      model: choice.model,
      status: "error",
      repo,
      timestamp,
      system_prompt: args.engineOpts.systemPrompt,
      user_prompt: args.engineOpts.userPrompt,
      raw_response: null,
      tokens_in: undefined,
      tokens_out: undefined,
      cost_usd: undefined,
      error_message: message,
      duration_ms: Date.now() - new Date(timestamp).getTime(),
    });
    finishRun(ctx.db, runId, { status: "error", error: message, logPath });
    throw error;
  }
}
