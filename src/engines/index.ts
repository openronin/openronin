import type { Engine } from "./types.js";
import { MimoEngine } from "./mimo.js";
import { ClaudeCodeEngine } from "./claude-code.js";
import { AnthropicEngine } from "./anthropic.js";
import { MultiAgentEngine } from "./multi-agent.js";

export type {
  Engine,
  AgentRole,
  EngineRunOptions,
  EngineResult,
  EngineUsage,
  ToolPolicy,
} from "./types.js";
export { MimoEngine } from "./mimo.js";
export { ClaudeCodeEngine } from "./claude-code.js";
export { AnthropicEngine } from "./anthropic.js";
export { MultiAgentEngine } from "./multi-agent.js";

export type EngineProviderId = "mimo" | "claude_code" | "anthropic" | "multi_agent";

export function getEngine(provider: EngineProviderId): Engine {
  switch (provider) {
    case "mimo":
      return new MimoEngine();
    case "claude_code":
      return new ClaudeCodeEngine();
    case "anthropic":
      return new AnthropicEngine();
    case "multi_agent":
      return new MultiAgentEngine();
    default: {
      const exhaustive: never = provider;
      throw new Error(`Unknown engine: ${String(exhaustive)}`);
    }
  }
}
