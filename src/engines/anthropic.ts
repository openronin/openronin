import type { Engine, EngineResult, EngineRunOptions } from "./types.js";

interface AnthropicEngineOptions {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
}

interface AnthropicResponse {
  content: Array<{ type: string; text: string }>;
  usage: { input_tokens: number; output_tokens: number };
  stop_reason: string;
  error?: { type: string; message: string };
}

// Approximate pricing for cost estimation (USD per token).
// Updated for claude-sonnet-4-6; adjust if pricing changes.
const COST_PER_INPUT_TOKEN = 3 / 1_000_000;
const COST_PER_OUTPUT_TOKEN = 15 / 1_000_000;

export class AnthropicEngine implements Engine {
  readonly id = "anthropic";
  readonly defaultModel: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: AnthropicEngineOptions = {}) {
    const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("AnthropicEngine requires ANTHROPIC_API_KEY env or options.apiKey");
    }
    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
    this.defaultModel = options.defaultModel ?? "claude-sonnet-4-6";
  }

  async run(opts: EngineRunOptions): Promise<EngineResult> {
    const model = opts.model ?? this.defaultModel;
    const body: Record<string, unknown> = {
      model,
      max_tokens: 8192,
      system: opts.systemPrompt,
      messages: [{ role: "user", content: opts.userPrompt }],
    };

    const started = Date.now();
    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });

    const text = await response.text();
    let payload: AnthropicResponse;
    try {
      payload = JSON.parse(text) as AnthropicResponse;
    } catch (error) {
      throw new Error(
        `Anthropic returned non-JSON (status ${response.status}): ${text.slice(0, 300)}\n${(error as Error).message}`,
      );
    }

    if (!response.ok || payload.error) {
      throw new Error(`Anthropic error: ${payload.error?.message ?? response.statusText}`);
    }

    const content = payload.content.find((c) => c.type === "text")?.text ?? "";
    const costUsd =
      payload.usage.input_tokens * COST_PER_INPUT_TOKEN +
      payload.usage.output_tokens * COST_PER_OUTPUT_TOKEN;

    let json: unknown;
    if (opts.expectJson) json = parseJsonLoose(content);

    return {
      content,
      json,
      usage: {
        tokensIn: payload.usage.input_tokens,
        tokensOut: payload.usage.output_tokens,
        costUsd,
      },
      finishReason: payload.stop_reason,
      durationMs: Date.now() - started,
      raw: payload,
    };
  }
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
