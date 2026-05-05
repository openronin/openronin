// Engine split: chat-reply ticks prefer MIMO, scheduled ticks prefer Anthropic.
//
// We don't actually instantiate either engine here — the test sets the
// env-var-driven inputs and asserts on the type tag of the chosen engine
// (`engine.id`). Production env always provides at least one key, so the
// fallthrough behaviour matters too.

import { test } from "node:test";
import assert from "node:assert/strict";

import { selectThinkEngine } from "../dist/director/tick.js";

function withEnv(overrides, body) {
  const saved = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try {
    body();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("selectThinkEngine: defaults prefer Anthropic when both keys present", () => {
  withEnv(
    {
      ANTHROPIC_API_KEY: "sk-test",
      XIAOMI_MIMO_API_KEY: "mimo-test",
      OPENRONIN_DIRECTOR_THINK_ENGINE: undefined,
      OPENRONIN_DIRECTOR_THINK_MODEL: undefined,
      OPENRONIN_DIRECTOR_CHAT_MODEL: undefined,
    },
    () => {
      const { engine } = selectThinkEngine();
      assert.equal(engine.id, "anthropic");
    },
  );
});

test("selectThinkEngine: preferCheap=true picks MIMO when both keys present", () => {
  withEnv(
    {
      ANTHROPIC_API_KEY: "sk-test",
      XIAOMI_MIMO_API_KEY: "mimo-test",
      OPENRONIN_DIRECTOR_THINK_ENGINE: undefined,
    },
    () => {
      const { engine } = selectThinkEngine({ preferCheap: true });
      assert.equal(engine.id, "mimo");
    },
  );
});

test("selectThinkEngine: preferCheap honours OPENRONIN_DIRECTOR_CHAT_MODEL", () => {
  withEnv(
    {
      ANTHROPIC_API_KEY: "sk-test",
      XIAOMI_MIMO_API_KEY: "mimo-test",
      OPENRONIN_DIRECTOR_THINK_ENGINE: undefined,
      OPENRONIN_DIRECTOR_CHAT_MODEL: "mimo-v2.5-flash",
    },
    () => {
      const { model } = selectThinkEngine({ preferCheap: true });
      assert.equal(model, "mimo-v2.5-flash");
    },
  );
});

test("selectThinkEngine: explicit override beats preferCheap", () => {
  withEnv(
    {
      ANTHROPIC_API_KEY: "sk-test",
      XIAOMI_MIMO_API_KEY: "mimo-test",
      OPENRONIN_DIRECTOR_THINK_ENGINE: "anthropic",
    },
    () => {
      const { engine } = selectThinkEngine({ preferCheap: true });
      assert.equal(engine.id, "anthropic");
    },
  );
});

test("selectThinkEngine: preferCheap falls through to Anthropic if MIMO unset", () => {
  withEnv(
    {
      ANTHROPIC_API_KEY: "sk-test",
      XIAOMI_MIMO_API_KEY: undefined,
      OPENRONIN_DIRECTOR_THINK_ENGINE: undefined,
    },
    () => {
      const { engine } = selectThinkEngine({ preferCheap: true });
      assert.equal(engine.id, "anthropic");
    },
  );
});
