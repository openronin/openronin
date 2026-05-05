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
import { MimoEngine } from "../engines/mimo.js";
import type { Engine } from "../engines/types.js";
import { appendMessage } from "./chat.js";
import { captureCharterVersion } from "./charter.js";
import {
  bumpFailureStreak,
  checkBudgetGate,
  ensureBudgetState,
  markTick,
  recordThinkSpend,
  resetFailureStreak,
  rolloverDayIfNeeded,
} from "./budget.js";
import { recordDecision } from "./decisions.js";
import { captureStateSnapshot } from "./state.js";
import { composePrompt } from "./prompt.js";
import { recalibrateBudget, shouldRecalibrateToday } from "./retrospective.js";
import { parseTickOutput, type ParsedDecision, type TickOutput } from "./decision-schema.js";
import { executeDecision } from "./executor.js";
import { GithubVcsProvider } from "../providers/github.js";
import type { VcsProvider } from "../providers/vcs.js";
import type { DecisionType, DirectorConfig } from "./types.js";
import YAML from "yaml";

const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";
const DEFAULT_MIMO_MODEL = "mimo-v2.5-pro";
const TICK_TIMEOUT_MS = 120_000; // 2 min — generous for a 30k-token thinking call

export type TickRunOptions = {
  db: Db;
  repoId: number;
  repo: RepoConfig;
  director: DirectorConfig;
  dataDir: string;
  // Engine factory (overridable for tests).
  engineFactory?: () => Engine;
  // VcsProvider factory (overridable for tests). Defaults to GithubVcsProvider
  // for github-provider repos. Constructed lazily — only if at least one
  // decision actually needs VCS access (saves an env-var check on dry_run).
  vcsFactory?: (repo: RepoConfig) => VcsProvider;
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
  ensureBudgetState(db, repoId, director.budget);

  // Once per UTC day, recalibrate the budget caps based on recent outcomes.
  // This runs BEFORE the gate check below so a freshly-shrunk cap can
  // immediately throttle the day.
  if (shouldRecalibrateToday(db, repoId)) {
    const retro = recalibrateBudget(db, repoId, director.budget);
    if (retro) {
      appendMessage(db, {
        repoId,
        role: "system",
        type: "tick_log",
        body:
          `budget recalibrated: daily $${retro.oldDaily.toFixed(2)} → $${retro.newDaily.toFixed(2)}, ` +
          `weekly $${retro.oldWeekly.toFixed(2)} → $${retro.newWeekly.toFixed(2)} (${retro.reason})`,
        metadata: {
          repo: repoKey(repo),
          oldDaily: retro.oldDaily,
          newDaily: retro.newDaily,
          oldWeekly: retro.oldWeekly,
          newWeekly: retro.newWeekly,
          successRate: retro.sample.successRate,
          sampleSize: retro.sample.executed + retro.sample.failed + retro.sample.rejected,
        },
      });
    }
  }

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

  let engine: Engine;
  let model: string;
  try {
    ({ engine, model } = opts.engineFactory
      ? { engine: opts.engineFactory(), model: process.env.OPENRONIN_DIRECTOR_THINK_MODEL ?? "" }
      : selectThinkEngine());
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    appendMessage(db, {
      repoId,
      role: "system",
      type: "error",
      body: `director cannot start: ${detail}\n\nSet OPENRONIN_DIRECTOR_THINK_ENGINE (anthropic | mimo) and the matching API key in $OPENRONIN_DATA_DIR/director.env (or secrets.env).`,
      metadata: { repo: repoKey(repo), mode: director.mode, charterVersion },
    });
    // Treat construction failure as a regular tick failure so we don't loop:
    // mark the tick + bump the streak. The streak gate will pause us after N.
    markTick(db, repoId);
    bumpFailureStreak(db, repoId);
    return { status: "error", detail, decisionsLogged: 0, costUsd: 0 };
  }

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
      metadata: { repo: repoKey(repo), mode: director.mode, charterVersion, engine: engine.id },
    });
    markTick(db, repoId);
    bumpFailureStreak(db, repoId);
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
    bumpFailureStreak(db, repoId);
    return { status: "error", detail: "schema-invalid", decisionsLogged: 0, costUsd: cost };
  }

  const tick = parsed.value;

  // 1. Persist all decisions first with outcome=pending so the audit trail
  //    is complete even if execution crashes. Cost is split across rows.
  const recorded = recordTickDecisions(db, {
    repoId,
    tick,
    charterVersion,
    cost,
  });

  // 2. Post the LLM's observations + reasoning + decision summary to chat
  //    BEFORE executing. The status message is what the human reads first;
  //    proposal-type messages from execute step are interleaved after.
  appendMessage(db, {
    repoId,
    role: "director",
    type: "status",
    body: renderChatPost(tick, director.mode, charterVersion, llmResult.usage),
    metadata: {
      repo: repoKey(repo),
      mode: director.mode,
      charterVersion,
      decisionIds: recorded.map((r) => r.id),
      costUsd: cost,
      tokensIn: llmResult.usage.tokensIn,
      tokensOut: llmResult.usage.tokensOut,
      durationMs: llmResult.durationMs,
    },
  });

  // 3. Execute each decision through the executor. Mode + authority gates
  //    inside executor.ts decide whether each one runs, queues for approval,
  //    or is skipped. The VcsProvider is constructed lazily — only when an
  //    executor actually reaches a VCS call (dry_run, propose, and the
  //    ask_user/no_op/amend_charter cases never need VCS).
  let vcs: VcsProvider | null = null;
  const getVcs = (): VcsProvider => {
    if (vcs) return vcs;
    vcs = opts.vcsFactory ? opts.vcsFactory(repo) : defaultVcsFactory(repo);
    return vcs;
  };
  let executed = 0;
  let pending = 0;
  let failed = 0;
  let skipped = 0;
  for (const r of recorded) {
    const result = await executeDecision({
      db,
      decisionId: r.id,
      repoId,
      repo,
      director,
      decision: r.decision,
      getVcs,
      charterVersion,
    });
    if (result.outcome === "executed") executed++;
    else if (result.outcome === "pending") pending++;
    else if (result.outcome === "failed") failed++;
    else if (result.outcome === "skipped") skipped++;
  }

  markTick(db, repoId);
  // Successful tick clears any prior failure streak — next failure starts
  // counting fresh, so a run of intermittent errors doesn't permanently
  // pause the director after the first 3 transient hiccups.
  // We treat per-decision execution failures separately (they're surfaced
  // as outcome=failed) so a single broken comment on a 5-decision tick
  // doesn't trip the streak.
  resetFailureStreak(db, repoId);

  const summary = [
    `${recorded.length} decision(s)`,
    executed > 0 ? `${executed} executed` : null,
    pending > 0 ? `${pending} pending` : null,
    skipped > 0 ? `${skipped} skipped` : null,
    failed > 0 ? `${failed} failed` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return {
    status: "ok",
    detail: summary,
    decisionsLogged: recorded.length,
    costUsd: cost,
  };
}

// Pick which engine to use for the planning tick. Priority:
//   1. Explicit override via OPENRONIN_DIRECTOR_THINK_ENGINE env (anthropic | mimo)
//   2. Anthropic if ANTHROPIC_API_KEY is set
//   3. MIMO if XIAOMI_MIMO_API_KEY is set
//   4. Throw — caller surfaces this to the chat as an actionable error
//
// The model can be overridden via OPENRONIN_DIRECTOR_THINK_MODEL; defaults
// are engine-specific. MIMO's quality is lower than Sonnet but its JSON-mode
// is solid and the cost is ~10x cheaper, so it's a fine fallback for a
// dry_run-mode director that's still being calibrated.
export function selectThinkEngine(): { engine: Engine; model: string } {
  const override = (process.env.OPENRONIN_DIRECTOR_THINK_ENGINE ?? "").toLowerCase();
  const userModel = process.env.OPENRONIN_DIRECTOR_THINK_MODEL;
  const haveAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const haveMimo = !!process.env.XIAOMI_MIMO_API_KEY;

  if (override === "anthropic") {
    if (!haveAnthropic)
      throw new Error("OPENRONIN_DIRECTOR_THINK_ENGINE=anthropic but ANTHROPIC_API_KEY not set");
    return { engine: new AnthropicEngine({}), model: userModel ?? DEFAULT_ANTHROPIC_MODEL };
  }
  if (override === "mimo") {
    if (!haveMimo)
      throw new Error("OPENRONIN_DIRECTOR_THINK_ENGINE=mimo but XIAOMI_MIMO_API_KEY not set");
    return { engine: new MimoEngine({}), model: userModel ?? DEFAULT_MIMO_MODEL };
  }

  if (haveAnthropic) {
    return { engine: new AnthropicEngine({}), model: userModel ?? DEFAULT_ANTHROPIC_MODEL };
  }
  if (haveMimo) {
    return { engine: new MimoEngine({}), model: userModel ?? DEFAULT_MIMO_MODEL };
  }
  throw new Error("no LLM API key found (ANTHROPIC_API_KEY or XIAOMI_MIMO_API_KEY required)");
}

function defaultVcsFactory(repo: RepoConfig): VcsProvider {
  switch (repo.provider) {
    case "github":
      return new GithubVcsProvider();
    case "gitlab":
      // We could lazy-import GitlabVcsProvider here once the director needs
      // it. For now, the director is enabled only on github repos in
      // production; tests inject vcsFactory directly.
      throw new Error(
        "default VcsProvider for gitlab not wired into director yet — pass vcsFactory in TickRunOptions or use github provider",
      );
    case "gitea":
      throw new Error("director does not yet support the gitea provider");
  }
}

// Recorded result we hand to the executor: the decision (so the executor can
// dispatch on type) plus the freshly-allocated id (so it can update outcome).
type RecordedDecision = { id: number; decision: ParsedDecision };

function recordTickDecisions(
  db: Db,
  args: {
    repoId: number;
    tick: TickOutput;
    charterVersion: number;
    cost: number;
  },
): RecordedDecision[] {
  const out: RecordedDecision[] = [];
  // Spread think cost across decisions for a rough per-decision audit, but
  // round-down rest goes to first row to keep the sum exactly equal.
  const n = args.tick.decisions.length;
  const each = n > 0 ? Math.floor((args.cost / n) * 1e6) / 1e6 : 0;
  let remainder = args.cost - each * n;
  for (const d of args.tick.decisions) {
    const slice = each + remainder;
    remainder = 0; // only first row gets the leftover
    const row = recordDecision(db, {
      repoId: args.repoId,
      decisionType: d.type as DecisionType,
      rationale: d.rationale,
      charterVersion: args.charterVersion,
      stateSnapshot: {
        observations: args.tick.observations,
        reasoning: args.tick.reasoning,
        priorityId: "priority_id" in d ? d.priority_id : undefined,
      },
      payload: "payload" in d ? d.payload : null,
      // Always pending at record time. The executor flips it to its final
      // outcome (executed / pending-with-proposal / dry_run / failed / skipped).
      outcome: "pending",
      costUsd: slice,
    });
    out.push({ id: row.id, decision: d });
  }
  return out;
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
