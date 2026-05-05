// Decision executor — turns a ParsedDecision into a real side-effect.
//
// Called from tick.ts after the LLM has produced + validated decisions.
// The outcome is determined by the composition of:
//   1. director.mode    — dry_run | propose | semi_auto | full_auto
//   2. director.authority — per-decision-type permissions
//
// Decision matrix (mode × decision_type → outcome):
//
//   |              | dry_run  | propose  | semi_auto | full_auto |
//   | no_op        | executed | executed | executed  | executed  |
//   | ask_user     | dry_run  | executed | executed  | executed  |  (posts a `question` chat message)
//   | create_issue | dry_run  | pending  | executed  | executed  |
//   | comment_*    | dry_run  | pending  | executed  | executed  |
//   | label_*      | dry_run  | pending  | executed  | executed  |
//   | close_issue  | dry_run  | pending  | pending   | pending   |  unless authority.can_close_issues
//   | approve_pr   | dry_run  | pending  | executed  | executed  |  unless !authority.can_approve_pr
//   | merge_pr     | dry_run  | pending  | pending   | executed  |  unless !authority.can_merge
//   | amend_charter| dry_run  | pending  | pending   | pending   |  unless authority.can_modify_charter
//
// `pending` means: the decision sits in `director_decisions(outcome='pending')`
// and a `proposal`-type chat message is posted asking for human approval.
// PR #3b adds the HTMX buttons that flip pending → executed/rejected.
//
// `dry_run` means: nothing is done. The decision is logged and a chat message
// summarises it, but no side-effect runs.
//
// `executed` means: the side-effect ran successfully and the artifact ref
// (issue/PR number, comment id) is recorded in outcome_details.
//
// `failed` means: the side-effect was attempted and threw. Bumps failure
// streak in tick.ts.
//
// `skipped` means: gated by authority — the operator hasn't opted in to
// this kind of decision.

import type { Db } from "../storage/db.js";
import type { RepoConfig } from "../config/schema.js";
import { repoKey } from "../config/schema.js";
import type { VcsProvider, VcsRepoRef } from "../providers/vcs.js";
import { getDecisionById, setDecisionOutcome, setDecisionPayload } from "./decisions.js";
import { appendMessage } from "./chat.js";
import { recordNote } from "./notes.js";
import type { ParsedDecision } from "./decision-schema.js";
import type { DecisionOutcome, DirectorAuthority, DirectorConfig } from "./types.js";

const PROPOSAL_BUTTONS_HINT =
  "Approve / reject in /admin/director/<repo>. Telegram bridge approves via /approve <id>.";

export type ExecuteOptions = {
  db: Db;
  decisionId: number;
  repoId: number;
  repo: RepoConfig;
  director: DirectorConfig;
  decision: ParsedDecision;
  // Lazy accessor — VcsProvider construction can require env vars and is
  // pointless for dry_run / pending paths. Tests pass a mock here.
  getVcs: () => VcsProvider;
  charterVersion: number;
};

export type ExecuteResult = {
  outcome: DecisionOutcome;
  details: string;
};

export async function executeDecision(opts: ExecuteOptions): Promise<ExecuteResult> {
  const { db, decisionId, repoId, repo, director, decision } = opts;
  const repoRef: VcsRepoRef = { owner: repo.owner, name: repo.name };

  // 1. Mode = dry_run → never act.
  if (director.mode === "dry_run") {
    return finalize(db, decisionId, "dry_run", "mode=dry_run; not executed");
  }

  // 2. Authority gate. Some decision types are off-limits unless the operator
  //    explicitly opted in. These return `skipped` regardless of mode.
  const auth = authorityFor(decision, director.authority);
  if (auth.gated) {
    postChat(
      db,
      repoId,
      repo,
      "system",
      "tick_log",
      `decision skipped: ${auth.reason}`,
      decisionId,
    );
    return finalize(db, decisionId, "skipped", auth.reason);
  }

  // 3. Per-mode dispatch.
  // Some decisions in some modes need human approval — flip to pending and
  // post a proposal in the chat.
  const needsApproval = decisionNeedsApproval(decision, director.mode, director.authority);
  if (needsApproval) {
    postProposal(db, repoId, repo, decision, decisionId);
    return finalize(db, decisionId, "pending", "queued for human approval");
  }

  // 4. Execute the side-effect via VcsProvider. Each branch is small so the
  //    fact that we hit the API is obvious in code review.
  try {
    const detail = await runDecision(opts, repoRef);
    return finalize(db, decisionId, "executed", detail);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    postChat(
      db,
      repoId,
      repo,
      "system",
      "error",
      `failed to execute ${decision.type} (decision #${decisionId}): ${detail}`,
      decisionId,
    );
    return finalize(db, decisionId, "failed", detail);
  }
}

// ── Authority gating ─────────────────────────────────────────────────────

function authorityFor(
  decision: ParsedDecision,
  authority: DirectorAuthority,
): { gated: false } | { gated: true; reason: string } {
  switch (decision.type) {
    case "create_issue":
      if (!authority.can_create_issues)
        return { gated: true, reason: "authority: can_create_issues=false" };
      return { gated: false };
    case "comment_on_issue":
    case "comment_on_pr":
      if (!authority.can_comment) return { gated: true, reason: "authority: can_comment=false" };
      return { gated: false };
    case "label_issue":
    case "label_pr":
      if (!authority.can_label) return { gated: true, reason: "authority: can_label=false" };
      return { gated: false };
    case "close_issue":
      if (!authority.can_close_issues)
        return { gated: true, reason: "authority: can_close_issues=false" };
      return { gated: false };
    case "approve_pr":
      if (!authority.can_approve_pr)
        return { gated: true, reason: "authority: can_approve_pr=false" };
      return { gated: false };
    case "merge_pr":
      if (!authority.can_merge) return { gated: true, reason: "authority: can_merge=false" };
      return { gated: false };
    case "amend_charter":
      if (!authority.can_modify_charter)
        return { gated: true, reason: "authority: can_modify_charter=false" };
      return { gated: false };
    case "remember_preference":
      // Always allowed — it's an internal memory write, doesn't touch
      // the repo or the YAML. Operator can prune via /admin if undesired.
      return { gated: false };
    case "ask_user":
    case "no_op":
      return { gated: false };
  }
}

// ── Per-mode approval requirement ────────────────────────────────────────

function decisionNeedsApproval(
  decision: ParsedDecision,
  mode: DirectorConfig["mode"],
  _authority: DirectorAuthority,
): boolean {
  // no_op / ask_user / remember_preference don't touch the repo — safe to
  // execute in every mode, no approval required.
  if (
    decision.type === "no_op" ||
    decision.type === "ask_user" ||
    decision.type === "remember_preference"
  ) {
    return false;
  }
  // amend_charter is always proposal-only — even full_auto must not silently
  // mutate the constitution. Authority gating is what unlocks the proposal
  // surface in the first place.
  if (decision.type === "amend_charter") return true;

  switch (mode) {
    case "propose":
      return true;
    case "semi_auto":
      // semi_auto auto-executes everything except merges, which are the
      // single highest-stakes operation.
      return decision.type === "merge_pr";
    case "full_auto":
      return false;
    case "dry_run":
    case "disabled":
      // dry_run was already short-circuited; disabled never reaches here.
      return true;
  }
}

// ── Side-effect runners ──────────────────────────────────────────────────

async function runDecision(opts: ExecuteOptions, repoRef: VcsRepoRef): Promise<string> {
  const { db, decisionId, repoId, repo, decision, getVcs } = opts;
  // Decisions that need a real API call grab the provider here. ask_user,
  // no_op, and remember_preference never call getVcs(), so VcsProvider
  // construction is deferred for those code paths.
  const needsVcs =
    decision.type !== "ask_user" &&
    decision.type !== "no_op" &&
    decision.type !== "remember_preference";
  const vcs = needsVcs ? getVcs() : (null as unknown as VcsProvider);

  switch (decision.type) {
    case "no_op":
      return "no_op";

    case "ask_user": {
      // Post a `question`-type chat message. Carries decisionId so the chat
      // UI can render it inline with the originating tick.
      const body =
        decision.payload.question +
        (decision.payload.context ? `\n\n_Context:_ ${decision.payload.context}` : "");
      postChat(db, repoId, repo, "director", "question", body, decisionId);
      return "question posted to chat";
    }

    case "create_issue": {
      const r = await vcs.createIssue(repoRef, {
        title: decision.payload.title,
        body: decision.payload.body,
        labels: decision.payload.labels,
      });
      return `issue #${r.number} created (${r.url})`;
    }

    case "comment_on_issue": {
      const r = await vcs.postComment(
        repoRef,
        decision.payload.issue_number,
        decision.payload.body,
      );
      return `comment posted on #${decision.payload.issue_number} (${r.url})`;
    }

    case "comment_on_pr": {
      const r = await vcs.postComment(repoRef, decision.payload.pr_number, decision.payload.body);
      return `comment posted on PR #${decision.payload.pr_number} (${r.url})`;
    }

    case "label_issue": {
      await vcs.addLabels(repoRef, decision.payload.issue_number, decision.payload.add);
      await vcs.removeLabels(repoRef, decision.payload.issue_number, decision.payload.remove);
      return `labelled #${decision.payload.issue_number}`;
    }

    case "label_pr": {
      await vcs.addLabels(repoRef, decision.payload.pr_number, decision.payload.add);
      await vcs.removeLabels(repoRef, decision.payload.pr_number, decision.payload.remove);
      return `labelled PR #${decision.payload.pr_number}`;
    }

    case "close_issue": {
      // Post the reason as a comment first so the human reading the closed
      // issue understands why. Then close.
      await vcs.postComment(repoRef, decision.payload.issue_number, decision.payload.reason);
      await vcs.closeItem(repoRef, decision.payload.issue_number, "not_planned");
      return `closed #${decision.payload.issue_number}`;
    }

    case "approve_pr": {
      await vcs.approvePullRequest(repoRef, decision.payload.pr_number, decision.payload.body);
      return `approved PR #${decision.payload.pr_number}`;
    }

    case "merge_pr": {
      const r = await vcs.mergePullRequest(
        repoRef,
        decision.payload.pr_number,
        decision.payload.strategy,
      );
      if (!r.merged) throw new Error(r.message ?? "merge refused");
      return `merged PR #${decision.payload.pr_number} (sha ${r.sha?.slice(0, 7) ?? "?"})`;
    }

    case "amend_charter":
      // Should never reach here — amend_charter always needs approval and
      // is intercepted earlier. If we do, fail loudly.
      throw new Error("amend_charter cannot auto-execute (must be human-applied)");

    case "remember_preference": {
      // Persist a long-term note. The next tick's state-snapshot will
      // surface it under "Standing notes" and the LLM can act on it.
      const note = recordNote(db, {
        repoId,
        kind: decision.payload.kind ?? "preference",
        body: decision.payload.body,
      });
      return `noted #${note.id} (${note.kind})`;
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function finalize(
  db: Db,
  decisionId: number,
  outcome: DecisionOutcome,
  details: string,
): ExecuteResult {
  setDecisionOutcome(db, decisionId, outcome, details);
  return { outcome, details };
}

function postChat(
  db: Db,
  repoId: number,
  repo: RepoConfig,
  role: "director" | "user" | "system",
  type: "question" | "proposal" | "tick_log" | "error" | "status",
  body: string,
  decisionId: number,
): void {
  appendMessage(db, {
    repoId,
    role,
    type,
    body,
    metadata: { repo: repoKey(repo), decisionId },
    decisionId,
  });
}

function postProposal(
  db: Db,
  repoId: number,
  repo: RepoConfig,
  decision: ParsedDecision,
  decisionId: number,
): void {
  const summary = summariseProposal(decision);
  const body = `**Proposal #${decisionId}** — \`${decision.type}\`\n\n${decision.rationale}\n\n${summary}\n\n_${PROPOSAL_BUTTONS_HINT}_`;
  postChat(db, repoId, repo, "director", "proposal", body, decisionId);
}

function summariseProposal(d: ParsedDecision): string {
  switch (d.type) {
    case "create_issue":
      return `**${d.payload.title}**\n\n${truncate(d.payload.body, 500)}\n\nLabels: \`${d.payload.labels.join("`, `") || "(none)"}\`, priority: \`${d.payload.priority}\``;
    case "comment_on_issue":
      return `→ comment on issue #${d.payload.issue_number}:\n\n> ${truncate(d.payload.body, 400)}`;
    case "comment_on_pr":
      return `→ comment on PR #${d.payload.pr_number}:\n\n> ${truncate(d.payload.body, 400)}`;
    case "label_issue":
      return `→ on issue #${d.payload.issue_number}: add \`${d.payload.add.join("`, `") || "(none)"}\`, remove \`${d.payload.remove.join("`, `") || "(none)"}\``;
    case "label_pr":
      return `→ on PR #${d.payload.pr_number}: add \`${d.payload.add.join("`, `") || "(none)"}\`, remove \`${d.payload.remove.join("`, `") || "(none)"}\``;
    case "close_issue":
      return `→ close issue #${d.payload.issue_number} with reason:\n\n> ${truncate(d.payload.reason, 300)}`;
    case "approve_pr":
      return `→ approve PR #${d.payload.pr_number}${d.payload.body ? `\n\n> ${truncate(d.payload.body, 300)}` : ""}`;
    case "merge_pr":
      return `→ merge PR #${d.payload.pr_number} via \`${d.payload.strategy}\``;
    case "ask_user":
      return `→ question:\n\n> ${truncate(d.payload.question, 400)}`;
    case "amend_charter":
      return `→ proposed charter changes:\n\n> ${truncate(d.payload.proposed_changes, 600)}`;
    case "no_op":
      return "(no_op)";
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

// ── Type-aware payload merge for edit-before-approve ─────────────────────
//
// Operators can tweak a proposal before approving it (rename a sloppy issue
// title, soften an aggressive comment, drop a label). We don't trust the
// HTTP form blindly — only known fields per decision_type are honoured.
// Anything else is dropped silently rather than rejected so a UI quirk
// can't break approvals.
const EDITABLE_FIELDS: Record<string, readonly string[]> = {
  create_issue: ["title", "body", "labels", "priority"],
  comment_on_issue: ["body"],
  comment_on_pr: ["body"],
  label_issue: ["add", "remove"],
  label_pr: ["add", "remove"],
  close_issue: ["reason"],
  approve_pr: ["body"],
  merge_pr: ["strategy"],
  ask_user: ["question", "context"],
  amend_charter: ["proposed_changes", "rationale"],
  remember_preference: ["body", "kind"],
};

export function editableFieldsFor(decisionType: string): readonly string[] {
  return EDITABLE_FIELDS[decisionType] ?? [];
}

export function mergePayloadOverrides(
  decisionType: string,
  original: unknown,
  overrides: Record<string, unknown>,
): unknown {
  const fields = EDITABLE_FIELDS[decisionType];
  if (!fields) return original; // no_op or unknown type — refuse to edit
  const base =
    original && typeof original === "object" ? (original as Record<string, unknown>) : {};
  const merged: Record<string, unknown> = { ...base };
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(overrides, f)) {
      merged[f] = overrides[f];
    }
  }
  return merged;
}

// ── Human approve / reject (from /admin/director or Telegram) ────────────
//
// `pending` decisions sit in the queue until a human acts. These two
// functions are the single entry-points for that action — they live here
// (not in admin.ts) so the same logic can be reused from the Telegram
// bridge in PR #4 without duplication.

export type ApproveOptions = {
  db: Db;
  decisionId: number;
  repo: RepoConfig;
  director: DirectorConfig;
  actor: string; // "admin" | "telegram:<userId>" — for chat metadata
  getVcs: () => VcsProvider;
  // Optional human edits to the proposed payload. Merged on top of the
  // stored payload before execution and persisted back to the decision row
  // so the audit trail captures what was actually executed, not what was
  // initially proposed. Type-aware merge — only fields valid for the given
  // decision_type are honoured (others are dropped).
  overrides?: Record<string, unknown>;
};

export type ApproveResult =
  | { ok: true; outcome: DecisionOutcome; details: string }
  | { ok: false; reason: string };

// Approve a pending decision: re-runs authority gating (operator might have
// flipped a `can_*` since the decision was queued) then executes the
// side-effect, just like `executeDecision` would in `full_auto` mode.
export async function approveDecision(opts: ApproveOptions): Promise<ApproveResult> {
  const { db, decisionId, repo, director, actor } = opts;
  const decision = getDecisionById(db, decisionId);
  if (!decision) return { ok: false, reason: `decision ${decisionId} not found` };
  if (decision.outcome !== "pending") {
    return { ok: false, reason: `decision ${decisionId} is ${decision.outcome}, not pending` };
  }
  if (decision.repoId !== getRepoIdForRepo(db, repo)) {
    return { ok: false, reason: `decision ${decisionId} belongs to a different repo` };
  }

  // Apply human edits (if any) on top of the stored payload. Only fields
  // valid for this decision-type pass through; everything else is dropped.
  // We persist the merged payload back to the row before execution so a
  // failed run still leaves the audit trail showing what we tried.
  let effectivePayload = decision.payload;
  if (opts.overrides && Object.keys(opts.overrides).length > 0) {
    effectivePayload = mergePayloadOverrides(
      decision.decisionType,
      decision.payload,
      opts.overrides,
    );
    setDecisionPayload(db, decisionId, effectivePayload);
  }

  // Reconstruct a ParsedDecision-shaped object from the stored row. The
  // schema-validation already ran when the decision was first recorded;
  // re-validating here is paranoia we'd pay on every approve. Skip it.
  const parsed = {
    type: decision.decisionType,
    rationale: decision.rationale,
    payload: effectivePayload,
  } as unknown as ParsedDecision;

  // Re-check authority — operator may have flipped a `can_*` between the
  // proposal and now.
  const auth = authorityFor(parsed, director.authority);
  if (auth.gated) {
    setDecisionOutcome(db, decisionId, "skipped", auth.reason);
    appendMessage(db, {
      repoId: decision.repoId,
      role: "system",
      type: "tick_log",
      body: `approval skipped: ${auth.reason}`,
      metadata: { repo: repoKey(repo), actor, decisionId },
      decisionId,
    });
    return { ok: true, outcome: "skipped", details: auth.reason };
  }

  appendMessage(db, {
    repoId: decision.repoId,
    role: "user",
    type: "answer",
    body: `Approved decision #${decisionId} (${decision.decisionType})`,
    metadata: { repo: repoKey(repo), actor, decisionId, action: "approve" },
    decisionId,
  });

  try {
    const detail = await runDecision(
      {
        db,
        decisionId,
        repoId: decision.repoId,
        repo,
        director,
        decision: parsed,
        getVcs: opts.getVcs,
        charterVersion: decision.charterVersion ?? 0,
      },
      { owner: repo.owner, name: repo.name },
    );
    setDecisionOutcome(db, decisionId, "executed", detail);
    appendMessage(db, {
      repoId: decision.repoId,
      role: "director",
      type: "report",
      body: `Decision #${decisionId} executed: ${detail}`,
      metadata: { repo: repoKey(repo), actor, decisionId },
      decisionId,
    });
    return { ok: true, outcome: "executed", details: detail };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    setDecisionOutcome(db, decisionId, "failed", detail);
    appendMessage(db, {
      repoId: decision.repoId,
      role: "system",
      type: "error",
      body: `Decision #${decisionId} failed on approval execute: ${detail}`,
      metadata: { repo: repoKey(repo), actor, decisionId },
      decisionId,
    });
    return { ok: true, outcome: "failed", details: detail };
  }
}

export type RejectOptions = {
  db: Db;
  decisionId: number;
  repo: RepoConfig;
  actor: string;
  reason?: string;
};

export function rejectDecision(opts: RejectOptions): ApproveResult {
  const { db, decisionId, repo, actor, reason } = opts;
  const decision = getDecisionById(db, decisionId);
  if (!decision) return { ok: false, reason: `decision ${decisionId} not found` };
  if (decision.outcome !== "pending") {
    return { ok: false, reason: `decision ${decisionId} is ${decision.outcome}, not pending` };
  }
  if (decision.repoId !== getRepoIdForRepo(db, repo)) {
    return { ok: false, reason: `decision ${decisionId} belongs to a different repo` };
  }

  const detail = reason ? `rejected: ${reason}` : "rejected by human";
  setDecisionOutcome(db, decisionId, "rejected", detail);
  appendMessage(db, {
    repoId: decision.repoId,
    role: "user",
    type: "veto",
    body: `Rejected decision #${decisionId} (${decision.decisionType})${reason ? `\n\n_Reason:_ ${reason}` : ""}`,
    metadata: { repo: repoKey(repo), actor, decisionId, action: "reject" },
    decisionId,
  });
  return { ok: true, outcome: "rejected", details: detail };
}

// Helper: look up our internal repo_id from a RepoConfig (provider/owner/name).
// Defence-in-depth check that the decision being approved belongs to the
// repo the request claimed it does.
function getRepoIdForRepo(db: Db, repo: RepoConfig): number {
  const row = db
    .prepare(`SELECT id FROM repos WHERE provider = ? AND owner = ? AND name = ?`)
    .get(repo.provider, repo.owner, repo.name) as { id: number } | undefined;
  return row?.id ?? -1;
}
