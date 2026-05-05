// Persona/voice layer for the Director.
//
// Verifies:
//   • PersonaSchema fills in sane defaults so old charters keep working
//   • CharterSchema accepts an explicit persona override
//   • The composed prompt embeds the persona block + voice/style verbatim
//     so the LLM actually inhabits the configured voice
//   • runTick falls back to the default persona when the input charter is a
//     bare object literal (tests bypass Zod, prod doesn't — but we don't
//     want a crash in either case)

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CharterSchema, PersonaSchema } from "../dist/director/types.js";
import { buildSystemPrompt, renderPersonaBlock } from "../dist/director/prompt.js";
import { initDb } from "../dist/storage/db.js";
import { runTick } from "../dist/director/tick.js";

test("PersonaSchema fills defaults when given empty input", () => {
  const persona = PersonaSchema.parse({});
  assert.equal(persona.name, "Director");
  assert.match(persona.role, /product owner|project manager/i);
  assert.ok(persona.voice.length > 0);
  assert.ok(persona.style.length > 0);
});

test("PersonaSchema accepts explicit override", () => {
  const persona = PersonaSchema.parse({
    name: "Лёша",
    role: "PM",
    voice: "дружелюбный, без формализмов",
    style: "короткие сообщения, признаёт неопределённость",
  });
  assert.equal(persona.name, "Лёша");
  assert.match(persona.voice, /дружелюбный/);
});

test("CharterSchema embeds persona with defaults", () => {
  const charter = CharterSchema.parse({
    vision: "Reliable, observable AI dev agent.",
    priorities: [{ id: "x", weight: 0.5, rubric: "y" }],
  });
  assert.ok(charter.persona);
  assert.equal(charter.persona.name, "Director");
});

test("buildSystemPrompt weaves persona name + voice into system text", () => {
  const persona = PersonaSchema.parse({
    name: "Лёша",
    voice: "конкретный, без воды",
  });
  const sys = buildSystemPrompt(persona);
  assert.match(sys, /You are Лёша/);
  assert.match(sys, /конкретный, без воды/);
});

test("renderPersonaBlock includes name, role, voice, style", () => {
  const persona = PersonaSchema.parse({
    name: "Anna",
    role: "PM",
    voice: "warm",
    style: "asks not guesses",
  });
  const block = renderPersonaBlock(persona);
  assert.match(block, /Anna/);
  assert.match(block, /PM/);
  assert.match(block, /warm/);
  assert.match(block, /asks not guesses/);
});

const sampleCharter = {
  vision: "Reliable, observable AI dev agent.",
  priorities: [{ id: "reliability", weight: 1.0, rubric: "graceful failure" }],
  out_of_bounds: [],
  out_of_bounds_paths: [],
  definition_of_done: [],
};

const sampleBudget = {
  initial_daily_usd: 2.0,
  initial_weekly_usd: 10.0,
  max_daily_usd: 10.0,
  max_weekly_usd: 50.0,
  think_daily_usd: 1.0,
  pause_on_failure_streak: 3,
  good_outcome_quarantine_days: 7,
};

const sampleDirector = {
  enabled: true,
  mode: "dry_run",
  cadence_hours: 6,
  bot_prefix: "👔 director:",
  language: "English",
  charter: sampleCharter,
  budget: sampleBudget,
  authority: {
    can_create_issues: true,
    can_label: true,
    can_close_issues: false,
    can_comment: true,
    can_approve_pr: true,
    can_merge: false,
    can_modify_charter: false,
  },
};

const sampleRepo = {
  provider: "github",
  owner: "openronin",
  name: "openronin",
  watched: true,
  lanes: ["triage"],
  director: sampleDirector,
};

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "openronin-persona-test-"));
  const db = initDb(dir);
  const result = db
    .prepare(
      `INSERT INTO repos (provider, owner, name, watched, config_json)
       VALUES ('github', 'openronin', 'openronin', 1, '{}')
       RETURNING id`,
    )
    .get();
  return { db, dir, repoId: result.id };
}

test("runTick: persona absent on charter falls back to defaults; system prompt names 'Director'", async () => {
  const { db, dir, repoId } = freshDb();
  let capturedSystem = "";
  let capturedUser = "";
  try {
    await runTick({
      db,
      repoId,
      repo: sampleRepo,
      director: sampleDirector,
      dataDir: dir,
      engineFactory: () => ({
        id: "mock",
        defaultModel: "mock",
        async run(opts) {
          capturedSystem = opts.systemPrompt;
          capturedUser = opts.userPrompt;
          return {
            content: "{}",
            json: {
              observations: "Steady state, nothing pressing this tick.",
              reasoning: "Routine planning per charter; nothing actionable.",
              decisions: [{ type: "no_op", rationale: "Nothing actionable this tick." }],
            },
            usage: { tokensIn: 1000, tokensOut: 200, costUsd: 0.001 },
            finishReason: "end_turn",
            durationMs: 100,
          };
        },
      }),
    });
    assert.match(capturedSystem, /You are Director/);
    assert.match(capturedUser, /Your name:.*Director/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runTick: explicit persona on charter is propagated into system + user prompt", async () => {
  const { db, dir, repoId } = freshDb();
  let capturedSystem = "";
  let capturedUser = "";
  const personaCharter = {
    ...sampleCharter,
    persona: {
      name: "Лёша",
      role: "PM",
      voice: "конкретный, без воды",
      style: "короткие сообщения, признаёт неопределённость",
    },
  };
  const personaDirector = { ...sampleDirector, charter: personaCharter };
  const personaRepo = { ...sampleRepo, director: personaDirector };
  try {
    await runTick({
      db,
      repoId,
      repo: personaRepo,
      director: personaDirector,
      dataDir: dir,
      engineFactory: () => ({
        id: "mock",
        defaultModel: "mock",
        async run(opts) {
          capturedSystem = opts.systemPrompt;
          capturedUser = opts.userPrompt;
          return {
            content: "{}",
            json: {
              observations: "Steady state, ничего срочного — мониторим charter priorities.",
              reasoning: "Routine planning per charter; nothing pressing this tick.",
              decisions: [{ type: "no_op", rationale: "Nothing actionable this tick." }],
            },
            usage: { tokensIn: 1000, tokensOut: 200, costUsd: 0.001 },
            finishReason: "end_turn",
            durationMs: 100,
          };
        },
      }),
    });
    assert.match(capturedSystem, /You are Лёша/);
    assert.match(capturedSystem, /конкретный, без воды/);
    assert.match(capturedUser, /Your name:.*Лёша/);
    assert.match(capturedUser, /короткие сообщения/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
