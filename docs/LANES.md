# Lanes

A **lane** is a (trigger, engine, output) triple. Tasks pass through lanes as their state evolves. The lane router (`pickLane` in `src/scheduler/worker.ts`) decides which lane runs next based on task type, status, configured lanes for the repo, and the state of any associated PR branch.

This page describes each lane: what it does, when it runs, what it produces, and the configuration knobs that control it.

## Lane summary

| Lane | Mandatory? | Engine class | Mutates code? | Talks to user? |
|---|---|---|---|---|
| triage | yes | supervisor | no | optional (via labels) |
| analyze | recommended | supervisor | no | yes (via comments) |
| patch | yes (for autonomy) | worker | yes | yes (via PR) |
| patch_multi | opt-in | worker + reviewer | yes | yes |
| pr_dialog | yes (with patch) | worker | yes | yes |
| conflict_resolve | opt-in | worker | yes | no |
| auto_merge | opt-in | — | merges only | no |
| deploy | opt-in | shell | n/a | no |

"Mandatory" means the system is degraded without it: e.g. `patch` without `pr_dialog` opens PRs but never iterates on feedback.

---

## triage

**Trigger:** any new issue or PR appears on a watched repo, picked up either by webhook (fast) or reconcile poll (cadence-bound).

**Engine:** supervisor (cheap classifier, default `mimo`).

**What it does:** reads the title, body, and labels; classifies the item as one of `keep_open`, `close`, `convert_to_discussion`, etc. with a confidence score and rationale. Optionally adds labels and posts a comment summarising the decision.

**What it does NOT do:** mutate code, expand requirements, or commit to a course of action. Triage is read-only routing.

**Output:** decision JSON persisted to `tasks.decision_json` + (optionally) labels + (optionally) comment.

**Config knobs:**
- `lanes` includes `triage`
- `engine_overrides.triage` — override the supervisor model for this repo
- `prompt_overrides.triage` — supply a custom triage prompt (the default lives in `prompts/templates/review-item.md`)

---

## analyze

**Trigger:** issue gets the `openronin:do-it` label (or whatever `patch_trigger_label` is configured to).

**Engine:** supervisor.

**What it does:** reads the full issue thread (including the bot's own previous questions, so re-opens are handled correctly), and decides:

- **`state: ready`** — produces `expanded_requirements` to feed downstream lanes. The task moves to `patch`.
- **`state: needs_clarification`** — produces a list of `questions[]` and posts them as a comment; sets the `openronin:awaiting-answer` label. The task pauses until the human posts a non-bot reply.

**Skip-logic.** If `awaiting-answer` is already set AND no non-bot comments have been posted since the questions were asked, analyze short-circuits without calling the engine — preventing the bot from spamming the same questions every poll cycle.

**Conversation rules.** The prompt instructs the analyzer to treat the latest comment as authoritative, not re-ask questions already answered, and treat re-opens as follow-ups (not fresh starts).

**Output:** decision JSON; possibly a comment with questions; possibly the `awaiting-answer` label.

**Config knobs:**
- `lanes` includes `analyze`
- `patch_trigger_label` — which label triggers it (default `openronin:do-it`)
- `awaiting_answer_label` — which label marks "waiting for human reply"
- `engine_overrides.analyze`
- `prompt_overrides.analyze`

---

## patch

**Trigger:** analyze finished with `state: ready` AND no existing PR branch is in `created` or `open` state for this task.

**Engine:** worker (`claude_code` by default).

**What it does:**

1. Posts an "I'm taking this one" acknowledgement comment + reaction.
2. Sets the `openronin:in-progress` label.
3. Clones the repo into a worktree under `$OPENRONIN_DATA_DIR/work/<repo>/<task>/`.
4. Creates a new branch off `patch_default_base`.
5. Spawns Claude Code with the issue body + analyze's `expanded_requirements` + the patch prompt template. The agent has read/write access only to the worktree — no ambient credentials, no shell access to anything outside.
6. After the agent finishes, **auto-commits leftover dirty changes** if no file in `protected_paths` was touched (the agent sometimes makes edits without explicit `git add`).
7. Validates the diff size against `max_diff_lines`. If exceeded → `guardrail_blocked`.
8. Pushes the branch (with `force-with-lease` fallback if a stale branch exists from a crashed prior attempt).
9. Opens a draft PR (or marks ready if `draft_pr: false`).
10. Posts the PR-opened acknowledgement comment.

**Failure modes** (each persists to `pr_branches.status`):
- `dirty` — agent left a worktree state that couldn't be cleanly committed (e.g. rebases mid-flight). Marks `awaiting-action` label.
- `no_changes` — agent decided no code changes were needed. Posts an explanation, marks `awaiting-action`.
- `guardrail_blocked` — diff too large or touched protected paths. Posts an explanation.
- `needs_human` — agent explicitly punted.
- `error` — engine threw. Recoverable with manual re-kick after diagnosing.

These are **terminal** — the lane router won't pick them up again until the row is manually unstuck (delete via DB, or re-trigger the task).

**Config knobs:**
- `lanes` includes `patch`
- `patch_trigger_label`, `patch_default_base`
- `protected_paths` — files the agent must not modify
- `max_diff_lines` — size cap
- `draft_pr` — open as draft (default true)
- `engine_overrides.patch`
- `prompt_overrides.patch`

---

## patch_multi

**Trigger:** same as patch, but only when the configured engine is `multi_agent`.

**Engine:** coder (`claude_code`) + reviewer (`anthropic` native API).

**What it does:** runs patch as above, then runs a second pass where a reviewer agent critiques the diff against the original requirements. The coder iterates up to `patch_multi_max_critique_iterations` times before pushing.

**Use this for:** non-trivial features where you want a second pair of eyes before the human sees it. **Don't use this for:** small fixes — it doubles the cost.

**Config knobs:**
- `engine_overrides.patch: { provider: multi_agent }` (or set globally)
- `patch_multi_max_critique_iterations` (default 2, max 5)

---

## pr_dialog

**Trigger:** new feedback arrives on a PR the bot owns. "New" means: posted after `pr_branches.last_seen_at`, by a non-bot author. Both inline review comments and issue-style comments count.

**Engine:** worker.

**What it does:**

1. Posts 👀 reaction on each new comment (acknowledgement).
2. Reads all unresolved threads and issue comments since the last iteration.
3. Spawns Claude Code with the PR diff + thread context + the pr-dialog prompt.
4. Agent produces a JSON contract: per-comment replies (`kind: addressed | declined | clarifying`) + an iteration summary.
5. Posts threaded replies via REST `pulls.createReplyForReviewComment`. Issue comments get quote-replies (no native threading).
6. If the agent made code changes: commits, pushes, +1 reaction, **resolves** the threads via GraphQL `resolveReviewThread`.
7. Increments `pr_branches.iterations` (only on successful push).

**Iteration cap:** `pr_dialog_max_iterations` (default 10). After the cap, the lane refuses to run and marks `awaiting-action`.

**Skip authors:** comments from authors in `pr_dialog_skip_authors` (e.g. CI bots, dependabot) are ignored.

**Config knobs:**
- `lanes` includes `pr_dialog`
- `pr_dialog_max_iterations`
- `pr_dialog_skip_authors`
- `engine_overrides.pr_dialog`
- `prompt_overrides.pr_dialog`

---

## conflict_resolve

**Trigger:** during `tryAutoMerge`, GitHub reports `mergeable: false`.

**Engine:** worker.

**What it does:**

1. Increments `pr_branches.conflict_resolutions_count`. Bails if over `auto_merge.resolve_conflicts_max_attempts` (default 3).
2. Clones the PR branch, fetches the base, starts `git rebase`.
3. For each conflicted commit: identifies conflict files, asks the agent to resolve them (system prompt strictly forbids running git commands), validates that no `<<<<<<<` / `=======` / `>>>>>>>` markers remain via regex, runs `git add` + `rebase --continue`.
4. Cap of 8 rebase steps per attempt (some commits have many conflicts — 8 is enough for most real cases).
5. Force-pushes with explicit `--force-with-lease=<branch>:<pre-rebase-sha>` to avoid stale-info rejects.
6. Returns control to `tryAutoMerge` which re-fetches the PR and decides whether to merge.

**Post-rebase CI wait.** Force-pushing bumps the head SHA, but GitHub doesn't immediately re-trigger CI. If the immediate combined-status check returns `no_checks`, the lane sets a `justRebased` flag and blocks merge until CI registers (polled at the next reconcile cycle).

**Config knobs:**
- `auto_merge.resolve_conflicts: true`
- `auto_merge.resolve_conflicts_max_attempts` (default 3, max 10)

---

## auto_merge

**Trigger:** end of `pr_dialog` with all replies `kind: addressed`, no unresolved threads, mergeable=true, CI green (or `no_checks` and `require_checks_pass: false`).

**Engine:** none (a sequence of REST + GraphQL calls).

**What it does:**

1. If draft and `unblock_draft: true`: marks ready for review (GraphQL `markReadyForReview`).
2. Calls `pulls.merge` with the configured strategy (`merge` / `squash` / `rebase`).
3. Closes the linked issue (if any).
4. Sets `pr_branches.status = closed`.

**Config knobs:**
- `auto_merge.enabled` — opt-in (default false)
- `auto_merge.strategy` — `squash` (default), `merge`, or `rebase`
- `auto_merge.require_checks_pass` (default true)
- `auto_merge.unblock_draft` (default true) — automatically marks ready before merge
- `auto_merge.resolve_conflicts` and `resolve_conflicts_max_attempts` — see above

---

## deploy

**Trigger:** GitHub `push` event on `trigger_branch` by a user matching `bot_login` (when `require_bot_push: true`, which is the default).

**Engine:** shell.

**What it does:** runs the configured `commands` in sequence. First failure stops the chain. Each command runs in a fresh `bash -c` (mode `local`) or wrapped in `ssh user@host` (mode `ssh`).

**Self-deploy.** openronin can deploy itself. The trick is `KillMode=process` in the systemd unit (so the deploying process isn't killed when the cgroup gets SIGTERM mid-restart) plus `scheduler.trackActivity()` keeping graceful-shutdown waiting until the deploy finishes. The example deploy panel in the admin UI documents the exact incantation.

**Config knobs:**
- `deploy.mode` — `disabled` (default), `local`, or `ssh`
- `deploy.trigger_branch` (default `main`)
- `deploy.bot_login` — which GitHub user's pushes trigger
- `deploy.require_bot_push` (default true)
- `deploy.commands` — list of shell commands
- `deploy.ssh.{user, host, port, key_path, strict_host_key_checking}` — for `mode: ssh`

The "Show config example" button in the admin UI generates a copy-pasteable annotated YAML for both modes.

---

## How a task moves between lanes

```
                     issue created
                          │
                          ▼
                       triage
                          │
                          ▼
              user adds openronin:do-it
                          │
                          ▼
                       analyze
                       /     \
              ready /        \ needs_clarification
                   /          \
                  ▼            ▼
                patch     awaiting-answer ──┐
                  │       (paused for       │  user replies
                  │        human reply)     │  (label removed)
                  │            └────────────┘  loops back to analyze
                  ▼
                 PR opened
                  │
                  ▼
              [waiting for feedback]
                  │
                  ▼
                pr_dialog ◀──── new comment
                  │     ▲           │
                  │     └───────────┘
                  │       (loops while comments arrive)
                  │
                  ▼
               auto_merge ──── mergeable=false ──▶ conflict_resolve
                  │                                        │
                  │ ◀──────────────────────────────────────┘
                  ▼
               PR merged + issue closed
                  │
                  ▼  (if push by bot to trigger_branch)
                deploy
```
