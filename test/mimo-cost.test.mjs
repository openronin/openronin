import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateMimoCostUsd } from "../dist/engines/mimo.js";

// Helper to compare floats with the precision we care about for currency.
const close = (a, b) => Math.abs(a - b) < 1e-9;

test("low tier: 100K input + 100K output costs $0.04 + $0.20", () => {
  const cost = estimateMimoCostUsd({
    prompt_tokens: 100_000,
    completion_tokens: 100_000,
  });
  // 100K * 0.40/M = 0.04; 100K * 2/M = 0.20.
  assert.ok(close(cost, 0.04 + 0.2), `got ${cost}`);
});

test("high tier: 1M input + 1M output uses $0.80 + $4 rates", () => {
  const cost = estimateMimoCostUsd({
    prompt_tokens: 1_000_000,
    completion_tokens: 1_000_000,
  });
  assert.ok(close(cost, 0.8 + 4), `got ${cost}`);
});

test("high tier kicks in above 256K prompt tokens", () => {
  const lo = estimateMimoCostUsd({ prompt_tokens: 256_000, completion_tokens: 0 });
  const hi = estimateMimoCostUsd({ prompt_tokens: 256_001, completion_tokens: 0 });
  // 256K → low tier ($0.40/M); 256K+1 → high tier ($0.80/M).
  assert.ok(close(lo, (256_000 * 0.4) / 1_000_000));
  assert.ok(close(hi, (256_001 * 0.8) / 1_000_000));
});

test("cache reads are billed at the cheaper cache rate, not as fresh input", () => {
  // Stay under 256K so we test the LOW-tier path: 200K fresh + 50K cache.
  const cost = estimateMimoCostUsd({
    prompt_tokens: 250_000,
    completion_tokens: 0,
    prompt_tokens_details: { cached_tokens: 50_000 },
  });
  // Fresh: 200K @ 0.40/M = 0.08. Cache: 50K @ 0.08/M = 0.004. Total = 0.084.
  assert.ok(close(cost, 0.08 + 0.004), `got ${cost}`);
});

test("zero usage produces zero cost", () => {
  assert.equal(estimateMimoCostUsd({}), 0);
  assert.equal(estimateMimoCostUsd({ prompt_tokens: 0, completion_tokens: 0 }), 0);
});

test("typical analyze run: 5K in / 1K out = ~$0.004", () => {
  const cost = estimateMimoCostUsd({
    prompt_tokens: 5_000,
    completion_tokens: 1_000,
  });
  // 5K * 0.40/M = 0.002, 1K * 2/M = 0.002. Sum = 0.004.
  assert.ok(close(cost, 0.004), `got ${cost}`);
});
