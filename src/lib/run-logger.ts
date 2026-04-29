import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { scrubSecrets } from "./git.js";

export interface RunLogEntry {
  run_id: number;
  lane: string;
  engine: string;
  model: string | null;
  status: "ok" | "error";
  repo: string;
  timestamp: string;
  system_prompt: string;
  user_prompt: string;
  raw_response: unknown;
  tokens_in: number | undefined;
  tokens_out: number | undefined;
  cost_usd: number | undefined;
  error_message: string | undefined;
  duration_ms: number;
}

export function writeRunLog(
  dataDir: string,
  runId: number,
  entry: Omit<RunLogEntry, "run_id">,
): string {
  const month = entry.timestamp.slice(0, 7); // YYYY-MM
  const dir = resolve(dataDir, "logs", "runs", month);
  mkdirSync(dir, { recursive: true });
  const logPath = resolve(dir, `${runId}.jsonl`);

  const safeEntry: RunLogEntry = {
    run_id: runId,
    ...entry,
    system_prompt: scrubSecrets(entry.system_prompt),
    user_prompt: scrubSecrets(entry.user_prompt),
    raw_response:
      typeof entry.raw_response === "string"
        ? scrubSecrets(entry.raw_response)
        : entry.raw_response,
    error_message: entry.error_message ? scrubSecrets(entry.error_message) : undefined,
  };

  appendFileSync(logPath, JSON.stringify(safeEntry) + "\n", "utf8");
  return logPath;
}
