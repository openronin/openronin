// The real Director tick — replaces the foundation no-op.
//
// Flow:
//   1. Pre-flight: rollover-day, ensure budget state, check budget gate.
//   2. Capture state snapshot (open issues, recent runs/PRs, chat).
//   3. Capture (or reuse) the charter version.
//   4. Build prompt (system + user) and call the LLM.
//   5. Parse JSON output against TickOutputSchema.
//   6. Record each decision into director_decisions; in dry_run mode mark
//      outcome=dry_run; in propose/semi_auto/full_auto mark outcome=pending
//      (execution lands in PR #23). For now, every decision is dry_run-ed
//      regardless of mode — execution is opt-in with the next PR.
//   7. Append a status message to the chat with the LLM's observations +
//      reasoning + decision summary.
//
// LLM-call costs are charged to the think-budget; if a tick somehow blows
// the daily think cap, the gate will refuse next ticks until rollover.

import type { Db } from "../storage/db.js";
import type { RepoConfig } from "../config/schema.js";
import { repoKey } from "../config/schema.js";
import { AnthropicEngine } from "../engines/anthropic.js";
import type { Engine } from "../engines/types.js";
import { appendMessage } from "./chat.js";
import { captureCharterVersion } from "./charter.js";
import {
  ensureBudgetState,
  rolloverDayIfNeeded,
  checkBudgetGate,
  recordThinkSpend,
  markTick,
} from "./budget.js";
import { recordDecision } from "./decisions.js";
import { captureStateSnapshot } from "./state.js";
import { composePrompt } from "./prompt.js";
import { parseTickOutput, type ParsedDecision, type TickOutput } from "./decision-schema.js";
import type { DecisionType, DirectorConfig } from "./types.js";
import YAML from "yaml";

const DEFAULT_THINK_MODEL = "claude-sonnet-4-6";
const TICK_TIMEOUT_MS = 120_000; // 2 min — generous for a 30k-token thinking call

export type TickRunOptions = {
  db: Db;
  repoId: number;
  repo: RepoConfig;
  director: DirectorConfig;
  dataDir: string;
  // Engine factory (overridable for tests).
  engineFactory?: () => Engine;
};

export type TickRunResult = {
  status: "ok" | "skipped" | "paused" | "error";
  detail: string;
  decisionsLogged: number;
  costUsd: number;
};

export async function runTick(opts: TickRunOptions): Promise<TickRunResult> {
  const { db, repoId, repo, director, dataDir } = opts;
  if (!director.charter) {
    return { status: "skipped", detail: "no charter", decisionsLogged: 0, costUsd: 0 };
  }

  rolloverDayIfNeeded(db, repoId);
  const budget = ensureBudgetState(db, repoId, director.budget);
  const gate = checkBudgetGate(budget, director.budget);
  if (!gate.ok) {
    appendMessage(db, {
      repoId,
      role: "system",
      type: "tick_log",
      body: `tick skipped: ${gate.reason}`,
      metadata: { repo: repoKey(repo), mode: director.mode },
    });
    return {
      status: "paused",
      detail: gate.reason,
      decisionsLogged: 0,
      costUsd: 0,
    };
  }

  const charterVersion = captureCharterVersion(db, repoId, director.charter);
  const state = captureStateSnapshot(db, repoId, repo.owner, repo.name);
  const charterYaml = YAML.stringify(director.charter);
  const prompt = composePrompt({
    ownerName: repo.owner,
    repoName: repo.name,
    charterYaml,
    mode: director.mode,
    state,
    dataDir,
    repoConfig: repo,
  });

  const engine = opts.engineFactory ? opts.engineFactory() : defaultEngineFactory();
  const model = process.env.OPENRONIN_DIRECTOR_THINK_MODEL ?? DEFAULT_THINK_MODEL;

  let llmResult;
  try {
    llmResult = await engine.run({
      systemPrompt: prompt.systemPrompt,
      userPrompt: prompt.userPrompt,
      timeoutMs: TICK_TIMEOUT_MS,
      model,
      expectJson: true,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    appendMessage(db, {
      repoId,
      role: "system",
      type: "error",
      body: `LLM call failed: ${detail}`,
      metadata: { repo: repoKey(repo), mode: director.mode, charterVersion },
    });
    markTick(db, repoId);
    return { status: "error", detail, decisionsLogged: 0, costUsd: 0 };
  }

  const cost = llmResult.usage.costUsd ?? 0;
  recordThinkSpend(db, repoId, cost);

  const parsed = parseTickOutput(llmResult.json);
  if (!parsed.ok) {
    appendMessage(db, {
      repoId,
      role: "system",
      type: "error",
      body: `tick output failed schema validation: ${parsed.error.slice(0, 500)}\n\nraw content (truncated): ${llmResult.content.slice(0, 1000)}`,
      metadata: {
        repo: repoKey(repo),
        mode: director.mode,
        charterVersion,
        tokensIn: llmResult.usage.tokensIn,
        tokensOut: llmResult.usage.tokensOut,
        costUsd: cost,
      },
    });
    markTick(db, repoId);
    return { status: "error", detail: "schema-invalid", decisionsLogged: 0, costUsd: cost };
  }

  const tick = parsed.value;
  const decisionIds = recordTickDecisions(db, {
    repoId,
    tick,
    charterVersion,
    mode: director.mode,
    cost,
  });

  appendMessage(db, {
    repoId,
    role: "director",
    type: "status",
    body: renderChatPost(tick, director.mode, charterVersion, llmResult.usage),
    metadata: {
      repo: repoKey(repo),
      mode: director.mode,
      charterVersion,
      decisionIds,
      costUsd: cost,
      tokensIn: llmResult.usage.tokensIn,
      tokensOut: llmResult.usage.tokensOut,
      durationMs: llmResult.durationMs,
    },
  });

  markTick(db, repoId);

  return {
    status: "ok",
    detail: `${tick.decisions.length} decision(s)`,
    decisionsLogged: decisionIds.length,
    costUsd: cost,
  };
}

function defaultEngineFactory(): Engine {
  return new AnthropicEngine({
    defaultModel: process.env.OPENRONIN_DIRECTOR_THINK_MODEL ?? DEFAULT_THINK_MODEL,
  });
}

function recordTickDecisions(
  db: Db,
  args: {
    repoId: number;
    tick: TickOutput;
    charterVersion: number;
    mode: DirectorConfig["mode"];
    cost: number;
  },
): number[] {
  const ids: number[] = [];
  // Spread think cost across decisions for a rough per-decision audit, but
  // round-down rest goes to first row to keep the sum exactly equal.
  const n = args.tick.decisions.length;
  const each = n > 0 ? Math.floor((args.cost / n) * 1e6) / 1e6 : 0;
  let remainder = args.cost - each * n;
  for (const d of args.tick.decisions) {
    const slice = each + remainder;
    remainder = 0; // only first row gets the leftover
    ids.push(
      recordDirectorDecision(db, args.repoId, args.charterVersion, args.mode, d, args.tick, slice).id,
    );
  }
  return ids;
}

function recordDirectorDecision(
  db: Db,
  repoId: number,
  charterVersion: number,
  mode: DirectorConfig["mode"],
  d: ParsedDecision,
  tick: TickOutput,
  costUsd: number,
) {
  // In dry_run we never execute. In other modes execution is gated and
  // implemented in PR #23 — until then, the safe behaviour is to mark
  // pending and let the human review.
  const outcome = mode === "dry_run" ? "dry_run" : "pending";
  return recordDecision(db, {
    repoId,
    decisionType: d.type as DecisionType,
    rationale: d.rationale,
    charterVersion,
    stateSnapshot: {
      observations: tick.observations,
      reasoning: tick.reasoning,
      priorityId: "priority_id" in d ? d.priority_id : undefined,
    },
    payload: "payload" in d ? d.payload : null,
    outcome,
    costUsd,
  });
}

function renderChatPost(
  tick: TickOutput,
  mode: string,
  charterVersion: number,
  usage: { tokensIn?: number; tokensOut?: number; costUsd?: number },
): string {
  const lines: string[] = [];
  lines.push(`**Tick** (mode=\`${mode}\`, charter v${charterVersion})`);
  lines.push("");
  lines.push("**Observations**");
  lines.push(tick.observations);
  lines.push("");
  lines.push("**Reasoning**");
  lines.push(tick.reasoning);
  lines.push("");
  if (tick.decisions.length === 1 && tick.decisions[0]?.type === "no_op") {
    lines.push("**Decision:** no_op — " + (tick.decisions[0]?.rationale ?? ""));
  } else {
    lines.push(`**Decisions** (${tick.decisions.length}):`);
    for (const [i, d] of tick.decisions.entries()) {
      lines.push(`${i + 1}. \`${d.type}\` — ${d.rationale}`);
      if ("payload" in d && d.payload) {
        const summary = summarisePayload(d.type, d.payload as Record<string, unknown>);
        if (summary) lines.push(`   ${summary}`);
      }
    }
  }
  lines.push("");
  lines.push(
    `_tokens in/out ${usage.tokensIn ?? "?"}/${usage.tokensOut ?? "?"}, cost $${(usage.costUsd ?? 0).toFixed(4)}_`,
  );
  return lines.join("\n");
}

function summarisePayload(type: string, payload: Record<string, unknown>): string {
  switch (type) {
    case "create_issue":
      return `→ "${truncate(String(payload.title ?? ""), 80)}" [${(payload.labels as string[] | undefined)?.join(", ") ?? "no labels"}]`;
    case "comment_on_issue":
    case "comment_on_pr": {
      const num = payload.issue_number ?? payload.pr_number;
      return `→ #${num as number}: ${truncate(String(payload.body ?? ""), 80)}`;
    }
    case "label_issue":
    case "label_pr": {
      const num = payload.issue_number ?? payload.pr_number;
      const add = (payload.add as string[] | undefined) ?? [];
      const remove = (payload.remove as string[] | undefined) ?? [];
      return `→ #${num as number}${add.length ? ` +[${add.join(",")}]` : ""}${remove.length ? ` -[${remove.join(",")}]` : ""}`;
    }
    case "approve_pr":
    case "merge_pr":
    case "close_issue":
      return `→ #${(payload.pr_number ?? payload.issue_number) as number}`;
    case "ask_user":
      return `→ "${truncate(String(payload.question ?? ""), 100)}"`;
    case "amend_charter":
      return `→ ${truncate(String(payload.proposed_changes ?? ""), 100)}`;
    default:
      return "";
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
