import { spawn } from "node:child_process";
import type { Engine, EngineResult, EngineRunOptions } from "./types.js";
import { RateLimited } from "./types.js";

interface ClaudeCodeEngineOptions {
  binary?: string;
  defaultModel?: string;
}

interface ClaudeJsonResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  api_error_status?: number;
  duration_ms?: number;
  num_turns?: number;
  result?: string;
  stop_reason?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export class ClaudeCodeEngine implements Engine {
  readonly id = "claude_code";
  readonly defaultModel: string;
  private readonly binary: string;

  constructor(options: ClaudeCodeEngineOptions = {}) {
    this.binary = options.binary ?? process.env.OPENRONIN_CLAUDE_BIN ?? "claude";
    this.defaultModel = options.defaultModel ?? "sonnet";
  }

  async run(opts: EngineRunOptions): Promise<EngineResult> {
    const model = opts.model ?? this.defaultModel;
    const args = [
      "--print",
      "--model",
      model,
      "--output-format",
      "json",
      "--permission-mode",
      mapPermission(opts.tools ?? "read-only"),
    ];
    if (opts.maxBudgetUsd && opts.maxBudgetUsd > 0) {
      args.push("--max-budget-usd", String(opts.maxBudgetUsd));
    }
    if (opts.systemPrompt) {
      args.push("--append-system-prompt", opts.systemPrompt);
    }

    const started = Date.now();
    const { stdout, stderr, code } = await runProcess(this.binary, args, {
      input: opts.userPrompt,
      cwd: opts.workdir,
      timeoutMs: opts.timeoutMs,
    });

    if (code !== 0) {
      // Before raising a generic exit-code error, see if the JSON payload
      // describes a rate-limit. The Claude Code CLI exits non-zero but still
      // emits a structured result on stdout for these.
      const rl = detectClaudeRateLimit(stdout);
      if (rl) throw rl;
      throw new Error(`claude exited ${code}: ${stderr.slice(0, 500) || stdout.slice(0, 500)}`);
    }

    let payload: ClaudeJsonResult;
    try {
      payload = JSON.parse(stdout) as ClaudeJsonResult;
    } catch (error) {
      throw new Error(
        `claude returned non-JSON: ${stdout.slice(0, 300)}\n${(error as Error).message}`,
      );
    }

    if (payload.is_error) {
      // Defensive: rate-limit could in theory arrive on a code-0 path.
      const rl = detectClaudeRateLimit(stdout);
      if (rl) throw rl;
      throw new Error(`claude reported error: ${payload.result ?? "(no message)"}`);
    }

    const content = payload.result ?? "";
    let json: unknown;
    if (opts.expectJson) json = parseJsonLoose(content);

    return {
      content,
      json,
      usage: {
        tokensIn: payload.usage?.input_tokens,
        tokensOut: payload.usage?.output_tokens,
        costUsd: payload.total_cost_usd,
      },
      finishReason: payload.stop_reason,
      durationMs: payload.duration_ms ?? Date.now() - started,
      raw: payload,
    };
  }
}

// Detect a rate-limit response in Claude Code's stdout JSON. Returns a
// RateLimited error ready to throw, or null if this is some other kind of
// failure.
//
// Example payload from a real 429:
//   { "is_error": true, "api_error_status": 429,
//     "result": "You've hit your limit · resets 7am (Europe/Moscow)", ... }
export function detectClaudeRateLimit(stdout: string): RateLimited | null {
  let payload: ClaudeJsonResult;
  try {
    payload = JSON.parse(stdout) as ClaudeJsonResult;
  } catch {
    return null;
  }
  const isLimit =
    payload.api_error_status === 429 ||
    /you've hit your limit|rate limit|usage limit/i.test(payload.result ?? "");
  if (!isLimit) return null;
  const resetAt = parseClaudeResetTime(payload.result ?? "");
  return new RateLimited(resetAt, "claude_code", payload.result ?? "");
}

// Parse the human-readable reset time Claude Code reports, e.g.
// "resets 7am (Europe/Moscow)" or "resets 7:30pm (Europe/Moscow)".
// Returns the next absolute UTC instant when that local-time clock strikes.
//
// We currently only know how to handle Europe/Moscow (UTC+3, no DST).
// Other timezones return null and the caller falls back to a fixed cooldown.
export function parseClaudeResetTime(text: string, now = new Date()): Date | null {
  const m = text.match(/resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i);
  if (!m) return null;
  let hour = parseInt(m[1] ?? "", 10);
  if (Number.isNaN(hour)) return null;
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const meridiem = m[3]?.toLowerCase();
  const tz = (m[4] ?? "").trim();

  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;

  let tzOffsetHours: number | null = null;
  if (!tz || tz === "Europe/Moscow") tzOffsetHours = 3; // MSK = UTC+3
  if (tz === "UTC" || tz === "GMT") tzOffsetHours = 0;
  if (tzOffsetHours === null) return null;

  const utcHour = hour - tzOffsetHours;
  const reset = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), utcHour, minute),
  );
  if (reset.getTime() <= now.getTime()) {
    reset.setUTCDate(reset.getUTCDate() + 1);
  }
  return reset;
}

function mapPermission(policy: NonNullable<EngineRunOptions["tools"]>): string {
  switch (policy) {
    case "read-write":
    case "git-write":
      return "acceptEdits";
    default:
      return "default";
  }
}

interface ProcessResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

interface RunProcessOptions {
  input?: string;
  cwd?: string;
  timeoutMs?: number;
}

function runProcess(bin: string, args: string[], opts: RunProcessOptions): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2000).unref();
      }, opts.timeoutMs);
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });

    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

function parseJsonLoose(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const fence = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
    if (fence?.[1]) {
      try {
        return JSON.parse(fence[1]);
      } catch {
        // fall through
      }
    }
    const brace = text.match(/\{[\s\S]*\}/);
    if (brace?.[0]) {
      try {
        return JSON.parse(brace[0]);
      } catch {
        // fall through
      }
    }
  }
  return undefined;
}
