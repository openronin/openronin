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

export type PromptInputs = {
  ownerName: string;
  repoName: string;
  charterYaml: string;
  mode: string;
  state: StateSnapshot;
  dataDir: string;
  repoConfig: RepoConfig;
};

export type ComposedPrompt = {
  systemPrompt: string;
  userPrompt: string;
  approxTokensIn: number; // rough — for budget pre-check
};

const DIRECTOR_SYSTEM = [
  "You are the Director for an open-source project — a product-owner / project-manager",
  "running on a 6-hour cadence. You emit machine-readable decisions in strict JSON.",
  "You never edit source files; the code-writing agent does that. You decide what should",
  "be worked on, comment on PRs, approve when ready. Stay strictly within the charter.",
  "When in doubt, ask the user instead of guessing.",
].join(" ");

export function composePrompt(inputs: PromptInputs): ComposedPrompt {
  const template = loadTemplate("director-tick", inputs.repoConfig, inputs.dataDir);
  const userPrompt = renderTemplate(template, {
    owner: inputs.ownerName,
    name: inputs.repoName,
    charter_yaml: inputs.charterYaml.trim(),
    mode: inputs.mode,
    state_json: JSON.stringify(inputs.state, null, 2),
    chat_transcript: renderChatTranscript(inputs.state.recentChat),
  });

  return {
    systemPrompt: DIRECTOR_SYSTEM,
    userPrompt,
    approxTokensIn: Math.ceil((DIRECTOR_SYSTEM.length + userPrompt.length) / 4),
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
