import type { Engine, EngineResult, EngineRunOptions } from "./types.js";

interface MimoEngineOptions {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  fetch?: typeof fetch;
}

interface OpenAIChatResponse {
  id?: string;
  choices: Array<{
    message: { role: string; content: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    // Some OpenAI-compatible providers (incl. MIMO) report cached
    // input tokens here when prompt-caching is enabled.
    prompt_tokens_details?: { cached_tokens?: number };
  };
  error?: { code?: string; message?: string };
}

// MIMO pricing (per 1M tokens, USD), as published by Xiaomi:
//   ≤256K context        >256K context
//   input        $0.40       $0.80
//   output       $2.00       $4.00
//   cache-read   $0.08       $0.16
// Tier is selected by total prompt size in tokens.
const MIMO_PRICING = {
  input_lo: 0.4,
  input_hi: 0.8,
  output_lo: 2,
  output_hi: 4,
  cache_lo: 0.08,
  cache_hi: 0.16,
} as const;
const MIMO_HIGH_TIER_THRESHOLD = 256_000;

export function estimateMimoCostUsd(usage: {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}): number {
  const promptTotal = usage.prompt_tokens ?? 0;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const freshInput = Math.max(0, promptTotal - cached);
  const output = usage.completion_tokens ?? 0;
  const isHigh = promptTotal > MIMO_HIGH_TIER_THRESHOLD;
  const inputRate = isHigh ? MIMO_PRICING.input_hi : MIMO_PRICING.input_lo;
  const outputRate = isHigh ? MIMO_PRICING.output_hi : MIMO_PRICING.output_lo;
  const cacheRate = isHigh ? MIMO_PRICING.cache_hi : MIMO_PRICING.cache_lo;
  return (freshInput * inputRate + output * outputRate + cached * cacheRate) / 1_000_000;
}

export class MimoEngine implements Engine {
  readonly id = "mimo";
  readonly defaultModel: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MimoEngineOptions = {}) {
    const apiKey = options.apiKey ?? process.env.XIAOMI_MIMO_API_KEY;
    const baseUrl =
      options.baseUrl ??
      process.env.XIAOMI_MIMO_BASE_URL ??
      "https://token-plan-sgp.xiaomimimo.com/v1";
    if (!apiKey) {
      throw new Error("MimoEngine requires XIAOMI_MIMO_API_KEY env or options.apiKey");
    }
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.defaultModel = options.defaultModel ?? "mimo-v2.5-pro";
    this.fetchImpl = options.fetch ?? fetch;
  }

  async run(opts: EngineRunOptions): Promise<EngineResult> {
    const model = opts.model ?? this.defaultModel;
    const messages = [
      { role: "system", content: opts.systemPrompt },
      { role: "user", content: opts.userPrompt },
    ];
    const body: Record<string, unknown> = { model, messages };
    if (opts.expectJson) body.response_format = { type: "json_object" };

    const started = Date.now();
    const response = await this.fetchWithRetry(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });

    const text = await response.text();
    let payload: OpenAIChatResponse;
    try {
      payload = JSON.parse(text) as OpenAIChatResponse;
    } catch (error) {
      throw new Error(
        `MIMO returned non-JSON (status ${response.status}): ${text.slice(0, 200)}\n${(error as Error).message}`,
      );
    }

    if (!response.ok || payload.error) {
      const code = payload.error?.code ?? response.status;
      const msg = payload.error?.message ?? response.statusText;
      throw new Error(`MIMO error ${code}: ${msg}`);
    }

    const choice = payload.choices[0];
    if (!choice) throw new Error("MIMO response had no choices");
    const content = choice.message.content;

    let json: unknown;
    if (opts.expectJson) {
      json = parseJsonLoose(content);
      if (json === undefined) {
        console.warn(
          `[mimo] expectJson but parse failed; raw content (first 500 chars): ${content.slice(0, 500)}`,
        );
      }
    }

    const costUsd = payload.usage ? estimateMimoCostUsd(payload.usage) : undefined;

    return {
      content,
      json,
      usage: {
        tokensIn: payload.usage?.prompt_tokens,
        tokensOut: payload.usage?.completion_tokens,
        ...(costUsd !== undefined && { costUsd }),
      },
      finishReason: choice.finish_reason,
      durationMs: Date.now() - started,
      raw: payload,
    };
  }

  private async fetchWithRetry(url: string, init: RequestInit, attempts = 3): Promise<Response> {
    let lastError: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        const response = await this.fetchImpl(url, init);
        if (response.status === 429 || response.status >= 500) {
          lastError = new Error(`HTTP ${response.status}`);
          await sleep(500 * 2 ** i);
          continue;
        }
        return response;
      } catch (error) {
        lastError = error;
        if (i < attempts - 1) await sleep(500 * 2 ** i);
      }
    }
    throw lastError ?? new Error("MIMO fetch failed");
  }
}

function parseJsonLoose(text: string): unknown {
  // Try strict parse first
  try {
    return JSON.parse(text);
  } catch {
    // Try fenced code block
    const fence = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
    if (fence?.[1]) {
      try {
        return JSON.parse(fence[1]);
      } catch {
        // fall through
      }
    }
    // Try first { ... } block
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

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
