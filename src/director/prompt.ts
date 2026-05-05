// Prompt builder for the Director's planning tick.
//
// We compose a system+user prompt from:
//   • the prompt template (lives in prompts/templates/director-tick.md
//     so it's overridable per-repo via the same mechanism as other lanes)
//   • the captured charter YAML (so the LLM is reasoning over exactly what
//     the human wrote, not a paraphrase)
//   • the state snapshot (counts, recent runs/PRs/merges, open issues)
//   • a transcript of the recent chat thread so user directives are honoured
//
// Token budget is the main constraint: with cadence_hours=6 and
// think_daily_usd=$1, we can spend ~$0.25 per tick at most. Keep state
// summaries terse, cap chat to ~25 messages, cap each message body to ~400
// chars in state.ts.

import { loadTemplate, renderTemplate } from "../prompts/registry.js";
import type { RepoConfig } from "../config/schema.js";
import type { StateSnapshot } from "./state.js";
import type { Persona } from "./types.js";

export type PromptInputs = {
  ownerName: string;
  repoName: string;
  charterYaml: string;
  mode: string;
  language: string;
  persona: Persona;
  state: StateSnapshot;
  dataDir: string;
  repoConfig: RepoConfig;
};

export type ComposedPrompt = {
  systemPrompt: string;
  userPrompt: string;
  approxTokensIn: number; // rough — for budget pre-check
};

// The system prompt is built dynamically from the persona so the LLM
// inhabits a real voice rather than the generic "Director" robot. The
// boilerplate (engine boundary, JSON contract, charter discipline) is
// invariant; only the voice/role/style is parameterised.
export function buildSystemPrompt(persona: Persona): string {
  return [
    `You are ${persona.name}, the ${persona.role} for an open-source project.`,
    "Speak in first person. You watch the project, decide what's worth working on next,",
    "and emit machine-readable decisions in strict JSON.",
    "",
    `Voice: ${persona.voice}`,
    `Style: ${persona.style}`,
    "",
    "You never edit source files — a separate code-writing agent does that. You create",
    "issues, comment on PRs, approve when ready, ask the human when uncertain. Stay",
    "strictly within the charter. Take ownership: surface stuck PRs, drifting priorities,",
    "and budget anomalies before the human has to ask.",
    "When in doubt, ask the user instead of guessing.",
  ].join(" ");
}

export function renderPersonaBlock(persona: Persona): string {
  return [
    `**Your name:** ${persona.name}`,
    `**Your role:** ${persona.role}`,
    `**Your voice:** ${persona.voice}`,
    `**Your style:** ${persona.style}`,
    "",
    "Sign your chat output as yourself — the chat surface labels each bubble with your",
    "name, so don't repeat your own name inside the body. Speak like a human PM, not a",
    "templated robot. Acknowledge user messages directly when responding to them.",
  ].join("\n");
}

export function composePrompt(inputs: PromptInputs): ComposedPrompt {
  const template = loadTemplate("director-tick", inputs.repoConfig, inputs.dataDir);
  const userPrompt = renderTemplate(template, {
    owner: inputs.ownerName,
    name: inputs.repoName,
    charter_yaml: inputs.charterYaml.trim(),
    mode: inputs.mode,
    language: inputs.language,
    persona_block: renderPersonaBlock(inputs.persona),
    state_json: JSON.stringify(inputs.state, null, 2),
    chat_transcript: renderChatTranscript(inputs.state.recentChat),
  });
  const systemPrompt = buildSystemPrompt(inputs.persona);

  return {
    systemPrompt,
    userPrompt,
    approxTokensIn: Math.ceil((systemPrompt.length + userPrompt.length) / 4),
  };
}

function renderChatTranscript(messages: StateSnapshot["recentChat"]): string {
  if (messages.length === 0) return "(empty thread — first tick on this repo)";
  return messages
    .map((m) => {
      const speaker = m.role === "director" ? "DIRECTOR" : m.role === "user" ? "USER" : "SYSTEM";
      return `[${m.ts}] ${speaker} (${m.type}): ${m.body}`;
    })
    .join("\n\n");
}
