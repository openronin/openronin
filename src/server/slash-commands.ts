// Slash-command parser for the admin chat composer.
//
// Mirrors the Telegram bot's commands so the admin-UI operator gets the
// same affordances. The parser is dumb and intentional: a leading `/word`
// is a command, anything else is a regular chat message and falls through
// to the existing message-append path.
//
// We don't support inline arguments yet (e.g. `/pause 2h`); each command
// is a fire-and-forget action with effect on the repo's director state.

import type { Db } from "../storage/db.js";
import { appendMessage } from "../director/chat.js";
import { ensureBudgetState, recordThinkSpend } from "../director/budget.js";
import { runDigest } from "../director/digest.js";
import { localDateInTz } from "../director/digest.js";
import type { RepoConfig } from "../config/schema.js";
import { repoKey } from "../config/schema.js";
import { MimoEngine } from "../engines/mimo.js";

void recordThinkSpend; // re-exported for tests; not used directly here
void localDateInTz; // ditto

export type SlashCommand =
  | { name: "tick"; args: string }
  | { name: "digest"; args: string }
  | { name: "pause"; args: string }
  | { name: "resume"; args: string }
  | { name: "status"; args: string }
  | { name: "budget"; args: string }
  | { name: "help"; args: string };

const KNOWN: SlashCommand["name"][] = [
  "tick",
  "digest",
  "pause",
  "resume",
  "status",
  "budget",
  "help",
];

// Returns the parsed command if `body` opens with a known `/cmd`, else null.
// Whitespace-tolerant. Body may continue with arbitrary args after the cmd.
export function parseSlashCommand(body: string): SlashCommand | null {
  const trimmed = body.trim();
  if (!trimmed.startsWith("/")) return null;
  const m = trimmed.match(/^\/([a-z_]+)(\s+(.*))?$/iu);
  if (!m || !m[1]) return null;
  const name = m[1].toLowerCase();
  if (!(KNOWN as readonly string[]).includes(name)) return null;
  return { name, args: (m[3] ?? "").trim() } as SlashCommand;
}

export type SlashCommandResult = {
  // Replacement message body to write into the chat — typically a system
  // ack of what just happened. Empty string means "don't post anything".
  echo: string;
};

// Execute the parsed command against the repo's director state. Side
// effects (clearing last_tick_at, running digest, pausing) happen in
// here; the caller writes a system message with the returned echo.
export async function runSlashCommand(opts: {
  db: Db;
  repo: RepoConfig | undefined;
  repoId: number;
  cmd: SlashCommand;
  dataDir: string;
}): Promise<SlashCommandResult> {
  const { db, repo, repoId, cmd } = opts;
  const slug = repo ? repoKey(repo) : `repo#${repoId}`;
  switch (cmd.name) {
    case "help":
      return {
        echo: [
          "**Slash commands**",
          "",
          "- `/tick` — force the next tick on the repo (≤10s).",
          "- `/digest` — run the morning digest right now (regardless of schedule).",
          "- `/pause` — pause the director for this repo.",
          "- `/resume` — resume after pause.",
          "- `/status` — show current mode, budget, last tick, pending count.",
          "- `/budget` — show budget caps + spend.",
          "- `/help` — this list.",
        ].join("\n"),
      };
    case "tick":
      db.prepare(`UPDATE director_budget_state SET last_tick_at = NULL WHERE repo_id = ?`).run(
        repoId,
      );
      return { echo: `tick requested via slash command (will fire on next loop ≤10s)` };
    case "pause":
      db.prepare(
        `UPDATE director_budget_state SET paused = 1, pause_reason = ? WHERE repo_id = ?`,
      ).run(cmd.args || "paused via /pause", repoId);
      return { echo: `director paused${cmd.args ? ` (${cmd.args})` : ""}` };
    case "resume":
      db.prepare(
        `UPDATE director_budget_state SET paused = 0, pause_reason = NULL WHERE repo_id = ?`,
      ).run(repoId);
      return { echo: `director resumed` };
    case "status": {
      const state = ensureBudgetState(db, repoId, repo?.director?.budget ?? defaultBudget());
      return {
        echo: [
          `**Status — ${slug}**`,
          `mode: \`${repo?.director?.mode ?? "?"}\` · paused: ${state.paused ? "yes" : "no"}`,
          `last tick: ${state.lastTickAt ?? "never"}`,
          `failure streak: ${state.failureStreak}`,
          `today think: $${state.spentTodayThinkUsd.toFixed(4)} / $${repo?.director?.budget.think_daily_usd.toFixed(2) ?? "?"}`,
        ].join("\n"),
      };
    }
    case "budget": {
      const state = ensureBudgetState(db, repoId, repo?.director?.budget ?? defaultBudget());
      return {
        echo: [
          `**Budget — ${slug}**`,
          `daily: $${state.spentTodayUsd.toFixed(2)} / $${state.dailyCapUsd.toFixed(2)}`,
          `weekly: $${state.spentWeekUsd.toFixed(2)} / $${state.weeklyCapUsd.toFixed(2)}`,
          `think today: $${state.spentTodayThinkUsd.toFixed(4)}`,
        ].join("\n"),
      };
    }
    case "digest":
      if (!repo?.director?.digest) {
        return { echo: "digest is not configured for this repo" };
      }
      try {
        const result = await runDigest({
          db,
          repoId,
          repo,
          digest: repo.director.digest,
          persona: repo.director.charter?.persona,
          language: repo.director.language,
          dataDir: opts.dataDir,
          engineFactory: () =>
            new MimoEngine({
              defaultModel: process.env.OPENRONIN_DIRECTOR_DIGEST_MODEL ?? "mimo-v2.5-pro",
            }),
        });
        return { echo: `digest ran: ${result.detail}` };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return { echo: `digest failed: ${detail}` };
      }
  }
}

// Tests want a no-prefix import; provide a sane default.
function defaultBudget() {
  return {
    initial_daily_usd: 2.0,
    initial_weekly_usd: 10.0,
    max_daily_usd: 10.0,
    max_weekly_usd: 50.0,
    think_daily_usd: 1.0,
    pause_on_failure_streak: 3,
    good_outcome_quarantine_days: 7,
  };
}
