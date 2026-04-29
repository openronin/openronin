export type ToolPolicy = "read-only" | "read-write" | "git-write";

export interface AgentRole {
  id: string;
  systemPrompt: string;
  tools: ToolPolicy;
  model?: string;
}

export interface EngineRunOptions {
  systemPrompt: string;
  userPrompt: string;
  workdir?: string;
  tools?: ToolPolicy;
  timeoutMs: number;
  model?: string;
  expectJson?: boolean;
  maxBudgetUsd?: number;
}

export interface EngineUsage {
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
}

export interface EngineResult {
  content: string;
  json?: unknown;
  usage: EngineUsage;
  raw?: unknown;
  finishReason?: string;
  durationMs: number;
}

export interface Engine {
  readonly id: string;
  readonly defaultModel: string;
  run(opts: EngineRunOptions): Promise<EngineResult>;
}

// Engine rate-limit signal. Thrown by an engine when the upstream provider
// rejects the call with a quota / rate-limit error and the retry is futile
// until some reset moment. Worker catches this and applies a long cooldown
// instead of the normal generic-error retry interval.
//
// resetAt is the parsed reset moment when the engine could give us one
// (e.g. Claude Code's "resets 7am (Europe/Moscow)" string). null if we
// couldn't parse — caller should fall back to a configured cooldown.
export class RateLimited extends Error {
  constructor(
    public readonly resetAt: Date | null,
    public readonly engineId: string,
    public readonly raw: string,
  ) {
    super(`${engineId} rate limit hit${resetAt ? `; resets at ${resetAt.toISOString()}` : ""}`);
    this.name = "RateLimited";
  }
}
