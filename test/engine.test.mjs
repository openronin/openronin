import { test } from "node:test";
import assert from "node:assert/strict";

test("MimoEngine: success path with mocked fetch returns content + usage", async () => {
  process.env.XIAOMI_MIMO_API_KEY = "test-key";
  const { MimoEngine } = await import("../dist/engines/mimo.js");

  const fakeResponse = {
    choices: [{ message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
  };

  let captured;
  const fakeFetch = async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify(fakeResponse), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const engine = new MimoEngine({
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    fetch: fakeFetch,
  });
  const result = await engine.run({
    systemPrompt: "you are terse",
    userPrompt: "ping",
    timeoutMs: 5000,
  });

  assert.equal(result.content, "pong");
  assert.equal(result.usage.tokensIn, 10);
  assert.equal(result.usage.tokensOut, 1);
  assert.equal(result.finishReason, "stop");
  assert.equal(captured.url, "https://example.test/v1/chat/completions");
  const body = JSON.parse(captured.init.body);
  assert.equal(body.model, "mimo-v2.5-pro");
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0].role, "system");
});

test("MimoEngine: error response surfaces as thrown error", async () => {
  const { MimoEngine } = await import("../dist/engines/mimo.js");

  const fakeFetch = async () =>
    new Response(JSON.stringify({ error: { code: "400", message: "Not supported model X" } }), {
      status: 400,
    });

  const engine = new MimoEngine({ apiKey: "k", fetch: fakeFetch });
  await assert.rejects(
    () => engine.run({ systemPrompt: "s", userPrompt: "u", timeoutMs: 5000 }),
    /Not supported model X/,
  );
});

test("MimoEngine: expectJson parses fenced JSON from response", async () => {
  const { MimoEngine } = await import("../dist/engines/mimo.js");

  const fakeFetch = async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: '```json\n{"answer":"42"}\n```' }, finish_reason: "stop" }],
        usage: {},
      }),
      { status: 200 },
    );

  const engine = new MimoEngine({ apiKey: "k", fetch: fakeFetch });
  const result = await engine.run({
    systemPrompt: "s",
    userPrompt: "u",
    timeoutMs: 5000,
    expectJson: true,
  });
  assert.deepEqual(result.json, { answer: "42" });
});

test("getEngine factory returns the correct provider", async () => {
  process.env.XIAOMI_MIMO_API_KEY = "test-key";
  const { getEngine } = await import("../dist/engines/index.js");
  assert.equal(getEngine("mimo").id, "mimo");
  assert.equal(getEngine("claude_code").id, "claude_code");
});
