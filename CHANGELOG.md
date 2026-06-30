# Changelog

All notable changes to **openronin** are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/), and the project loosely follows [SemVer](https://semver.org/) — though as a self-hosted tool with a config schema rather than a public API, "breaking" mostly means schema migrations.

## [Unreleased]

### Reliability — crash recovery audit and richer healthz (issue #39)

- **Recovery audit file.** Every boot, `recoverStuckTasks` now writes a small JSON summary to `$OPENRONIN_DATA_DIR/recovery/last.json` (atomic write-then-rename) capturing `ts`, `recovered`, per-table counts (`tasks`, `runs`, `deploys`), and a `clean_shutdown` flag. The healthz endpoint reads it back so external monitors can answer "what did the last boot recover?" without poking the DB.
- **`GET /healthz` enriched.** Response gains `active_runs` (rows in `runs.status='running'`), `queued_runs` (due tasks per `queueStats`), and a `last_recovery` block exposing the audit above with an `age_sec` field. The endpoint now returns HTTP **503** when the DB query fails (`status: "down"`); the OK path remains 200 with `status: "ok"`. Internal helpers around it are factored out as `buildHealthz()` so tests can assert response shape directly.
- The existing SIGTERM/SIGINT graceful shutdown (`scheduler.stop`) and the `recoverStuckTasks` startup sweep (which resets orphaned `runs`/`tasks`/`deploys` rows and abandons tasks that crash-loop 3× in a row) are unchanged — this change makes their outcomes visible.

### Observability — run timeline API and task-filter in logs UI (issue #38)

- **`GET /api/runs`** — new REST endpoint for programmatic access to run logs. Supports filtering by `task_id`, `lane`, `status`, `repo`, `dateFrom`, `dateTo`, `limit`, and `offset`. Returns `{ runs, total, limit, offset }` so clients can paginate. Requires bearer token (`OPENRONIN_API_TOKEN`).
- **`GET /api/runs/:id`** — fetch a single run record by ID.
- **Task ID filter in `/admin/logs`** — a new "Task ID" numeric input in the logs filter bar lets operators jump directly to all runs for a specific task without navigating through the task detail page.
- **`RunFilter.taskId`** — the underlying `listRunsFiltered` / `countRunsFiltered` storage helpers now support filtering by task ID.

### Patch lane — cost reduction (issue #30)

- **Lower `per_task_usd` default** from `$5.00` to `$0.50`. Claude Code's `--max-budget-usd` flag enforces this inside the binary, so a runaway agent loop (the root cause of the $2–$3 runs) cannot spend more than the cap per issue.
- **Issue-body truncation.** New per-repo config key `patch_body_max_chars` (default `12000`) trims the combined issue body + analyst expansion before the patch prompt is rendered. Long bodies were the primary driver of inflated input-token counts. A marker `[… body truncated …]` is appended so the agent knows context was cut.
- **Cost breakdown logging.** `runJob` now emits a single structured `console.log` line after every successful run: `[run:<id>] <lane> <engine>/<model> tokens_in=… tokens_out=… cost=$…`. This satisfies the observability acceptance criterion. The data was already written to DB and JSONL logs; the console line makes it visible in service logs without an additional query.
- **Example config updated.** `config/openronin.example.yaml` documents the new `per_task_usd`, adds a `haiku` comment under `engines.defaults.patch` for cost-sensitive repos (~25× cheaper than `sonnet`), and documents how to set a per-repo model override.



### Director — UX audit follow-through (Wave 1 + Wave 2 + Wave 3 polish)

A 12-PR sweep that grew out of an audit looking at how the Director feels to operate. Goal: stop feeling like a JSON robot, start feeling like a PM who's actually on call. Schema bumped from **v13 → v17**; 167 → 170 unit tests.

**Wave 1 — make the PM feel alive**

- **Persona / voice.** `charter.persona = { name, role, voice, style, avatar }` is woven into the system prompt so the LLM inhabits a real voice instead of templated boilerplate. The chat-bubble label drops the hardcoded `👔 director:` and becomes the persona name + avatar. Captured per charter version.
- **Reactive tick + typing indicator + per-repo lock.** Service loop wakes every 10s (was 60s) and fires when *either* cadence elapsed or there are unanswered user messages — chat directives react in <30s. New `director_active_ticks` table doubles as advisory lock and the truth source for the `🟡 \<persona\> is thinking…` indicator (polls 2s while busy / 10s when idle). `TickReason` (`scheduled` | `user_message` | `pr_event` | `deploy_failed` | `manual`) plumbed through `runTick` and into the prompt.
- **Edit-before-approve.** Each pending proposal grows an `✏ Edit & approve` button next to Approve/Reject. The form is type-aware (title/body/labels for `create_issue`; body for comments; add/remove for labels) pre-populated from the LLM's payload. Submit merges edits onto the stored payload before execution and persists the merged version back to the row, so the audit trail shows what was actually executed.
- **Decision dedup.** New `payload_hash` column + index + dedup module hash a normalised canonical form of `(decision_type, payload)` (folds case/whitespace/common prefixes/set-order for label arrays). 7-day lookback against pending+executed; duplicates land as `outcome=skipped` with a `duplicate of #N` reason instead of going through the executor. `ask_user` and `no_op` are exempt.
- **Daily morning digest.** `DigestConfigSchema` (`enabled` / `hour` / `timezone`); pure TZ-aware predicate (`Intl.DateTimeFormat`) so once-per-local-day idempotency is string-only. `runDigest` uses MIMO directly (cheap; never falls over to Sonnet) and posts ONE `status` chat message — no decisions, no executor invocation. New `prompts/templates/director-digest.md`. Service loop fires it before the planning tick on each wake; both share the per-repo lock.

**Wave 2 — proactive PM behaviour**

- **Stale watchdog.** State snapshot grows `attentionItems[]` — stale PRs (>24h), issues stuck in `awaiting-answer` (>48h), recent failed deploys, high failure-streak, full proposal queue. Surfaced under an "Attention first" prompt section so the LLM addresses stuck work before piling on new work.
- **Trust-ramp suggestion.** Once-per-week-per-repo (cooldown) the loop posts a `question` to chat suggesting mode escalation when ≥30 terminal decisions over 14d at ≥90% executed (or demotion at ≤40% over ≥10). The mode itself stays in YAML — the message tells the operator the line to flip.
- **Engine split (chat-vs-plan).** `selectThinkEngine` grows a `preferCheap` flag. Reactive ticks (`reason='user_message'`) prefer MIMO (~10× cheaper, faster); scheduled cadence ticks pull Sonnet. `OPENRONIN_DIRECTOR_CHAT_MODEL` pins the chat-reply path to a specific MIMO variant (e.g. `mimo-v2.5-flash`) without touching the planning default.
- **Standing operator notes.** Long-term "this is how I want you to behave" memory in `director_notes`. New `remember_preference` decision-type — director persists durable preferences without approval. Operator can add/delete via the Standing notes card on `/admin/director/<slug>`. Snapshot includes `standingNotes[]` (capped at 20); prompt renders them under "Standing notes from the operator".
- **Slash commands in admin chat.** Composer parses `/cmd` prefix: `/tick` `/digest` `/pause` `/resume` `/status` `/budget` `/approve-all` `/help`. Mirrors the Telegram bot's set so the same affordances exist in both surfaces. Each command echoes the typed input (audit) and posts a system response.

**Wave 3 — operational polish**

- **Pending expiry.** Pending decisions untouched for 7d auto-flip to `outcome=expired` with a chat note. The proposal queue can't silently grow.
- **Transient retry.** VCS calls in the executor wrap in `withTransientRetry`. 5xx / `ECONNRESET` / timeout / "secondary rate limit" get up to 3 attempts at 1s/5s/20s backoff. Terminal errors (404, 422) bubble out unchanged.
- **Charter diff in chat.** When the YAML changes and a new charter version is captured, the loop posts a brief diff summary (added/removed priorities, weight changes, persona renames). v1 silent; v(N+1) where N≥1 produces the note.
- **Syntax highlight.** `highlight.js` (common build) added to the admin layout; chat markdown renderer colours code-fences.
- **Bulk approve.** `✓ Approve all (N)` button in the status panel (when ≥2 pending), POST `/admin/director/:slug/decisions/approve-all`, and `/approve-all` slash command. Each runs through the same `approveDecision` path as the one-by-one button. Pending-count chip in the status panel makes queue depth visible year-round.

**Production stability fixes (not user-facing)**

- **Atomic migrations.** `applyMigrations` body wraps in `db.transaction().immediate()` so two services racing on startup serialise cleanly via SQLite's IMMEDIATE write lock. Earlier in the session this race was the source of nasty `table already exists` / `duplicate column name` crashes during deploys.
- **Fast shutdown.** Service loop `sleep` splits into 250ms slices and checks `stopping`. Telegram bridge owns an `AbortController` that wraps every `getUpdates` long-poll; `stop()` aborts mid-flight. Captured `watchConfig` cleanup is now called on exit. Final `process.exit(0)` belt-and-braces against any lingering `AbortSignal.timeout` keepalive. End-to-end shutdown drops from ~120s → <1s typical.
- **Digest engine model.** `runDigest` was passing `model: ""` to `engine.run`; MIMO rejected with `400 Not supported model`. Now reads `engine.defaultModel`.

**Tail items — close the audit roadmap**

- **Stale-task self-heal.** Worker + reconcile got an `isVcs404` predicate. A 404 from the VCS (typically after a repo rename / fork) marks the task with a year-long retry delay so the scheduler effectively forgets it — earlier in the day production was producing ~10 GET /pulls/.../reviews 404s/min on issues left over from the openronin/openronin rename until manually patched. Reconcile flips the matching `pr_branches.status` to `'closed'` so the dashboard reflects reality. Terminal errors only — non-404s keep their normal short retry.
- **Per-decision trace UI.** Schema v18 grows seven new columns on `director_decisions` (`prompt_text`, `response_text`, `tokens_in`, `tokens_out`, `duration_ms`, `engine_id`, `model`). `runTick` stamps every decision in a tick with the SAME prompt/response (one LLM call → all rows share it). New `/admin/director/:slug/decisions/:id` page renders outcome timeline + payload + state snapshot + collapsible full prompt + raw LLM response. Linked from the recent-decisions table via a clickable `#N` column. Manual decisions leave the trace columns null.
- **Outcome follow-up.** Schema v19 adds `director_outcome_followups`. Once-per-hour-per-repo sweep polls VCS for the resulting state of recent executed `create_issue` decisions in a 14-day window, capped at 5 per pass, throttled to 6h between observations of the same decision. Records `issue_open` / `issue_merged_via_pr` (state_reason=completed) / `issue_closed_no_pr` (won't-fix) / `issue_pr_open` / `fetch_error`. Surfaced as a timeline card on the per-decision trace UI with deep links into VCS. `VcsItem` grows an optional `stateReason` field; `mapIssue` propagates GitHub's `state_reason`. Doesn't yet feed into the adaptive-budget retrospective — documented as future work.

`docs/DIRECTOR.md` rewritten to reflect everything above.


### Added — director: adaptive budget retrospective

Daily/weekly budget caps now move with the director's track record instead of staying static at the YAML-configured initial values. Once per UTC day, on the first tick of the day, `recalibrateBudget()` looks at the last 14 days of terminal decision outcomes:

- **success_rate ≥ 0.80** over a meaningful sample (≥5 decisions) → caps climb 10%, capped at `max_daily_usd` / `max_weekly_usd`
- **success_rate ≤ 0.40** → caps shrink 20%, floored at the initial values
- **otherwise** → hold steady (no DB write, no chat message)

`success_rate = executed / (executed + failed + rejected)`. `skipped` is excluded — that's an operator policy choice, not an outcome. `dry_run` and `pending` are excluded as not-yet-outcomes.

Each adjustment is logged to a new `director_budget_history` table (schema migration **v13**) and surfaced as a `tick_log` chat message so the operator can see the trajectory at a glance.

Caveat: this isn't a "good outcome retrospective" in the strong sense — that would require polling the VCS for revert / CI status of merged PRs over a 7-day quarantine. Out of scope here. Code documents this honestly.

7 new tests cover empty samples, success-rate computation (excluding `skipped`), climb-with-ceiling, shrink-with-floor, insufficient-sample no-op, middling-rate hold-steady, history-table writes, once-per-day gating.


### Added — director: Telegram bridge

The director's chat thread now mirrors to Telegram for whitelisted users, and accepts management commands back. Lets an operator approve / reject / pause / resume from a phone without opening the admin UI.

- **Outbound mirror.** Each new `director_messages` row with `role='director'|'system'` is forwarded to every whitelisted Telegram chat, with a `/approve <id> · /reject <id>` reminder appended to proposals.
- **Inbound commands** (whitelist enforced):
  - `/repos`, `/status`, `/budget`, `/pending`, `/help`
  - `/approve <id>`, `/reject <id> [reason]` — same code path as the admin UI buttons (reuses `approveDecision()` / `rejectDecision()`)
  - `/pause <slug>`, `/resume <slug>`
- **Free text** from a whitelisted user is recorded as a `directive`-typed user message. Prefix with `repo:<slug> -- ` to target a specific repo when several are director-enabled.
- Configured via `OPENRONIN_DIRECTOR_TELEGRAM_TOKEN` (separate bot from the tracker provider's `TELEGRAM_BOT_TOKEN`) and `OPENRONIN_DIRECTOR_TELEGRAM_USER_IDS=12345,67890`. Bridge refuses to start if token is set but whitelist is empty.
- Runs in-process inside `openronin-director.service` alongside the tick loop. Two background async tasks: long-poll for inbound updates, 5s-interval mirror of new director messages outbound.
- 6 tests with mocked `fetch()` cover incoming directive, /approve, /reject, /pending, /pause+/resume, and unauthorized-user filter.


### Added — director: two-way admin chat (approve/reject + user messages)

The `/admin/director/<slug>` page is no longer read-only. Three new POST endpoints make it a control surface:

- `POST /admin/director/:slug/messages` — operator posts a `directive`/`answer`/`veto` message into the chat thread. Picked up by the next tick.
- `POST /admin/director/:slug/decisions/:id/approve` — re-runs authority gate, executes the side-effect via `VcsProvider`, flips outcome `pending → executed`/`failed`/`skipped`. Posts a report.
- `POST /admin/director/:slug/decisions/:id/reject` — flips outcome `pending → rejected`, records optional reason as a `veto`-typed user message.

The pending-proposal chat bubble grows inline `[✓ Approve]`/`[✗ Reject]` buttons (HTMX, no page reload). The thread also gains a `directive`/`answer`/`veto` form at the top.

`approveDecision()` / `rejectDecision()` are exported from `src/director/executor.ts` so the upcoming Telegram bridge can use the same code-path. 5 new tests exercise the full lifecycle including authority re-checks, double-approve guard, and reject-after-execute.


### Added — director: execution backend (decision side-effects via VcsProvider)

The director's `mode` toggle (`dry_run` / `propose` / `semi_auto` / `full_auto`) now actually drives execution. Previously every decision was logged with `outcome=dry_run` regardless of mode; now the executor in `src/director/executor.ts` carries each decision through a mode × authority × decision-type matrix and either:

- Logs only (`dry_run`)
- Records `outcome=pending` and posts a `proposal`-type chat message asking for human approval (`propose`, plus `merge_pr` in `semi_auto`, plus `amend_charter` always)
- Calls the relevant `VcsProvider` method and records `outcome=executed` with the artifact ref (issue/PR number, comment URL)
- Records `outcome=skipped` when the operator hasn't opted in via `authority.can_*`
- Records `outcome=failed` with the error detail when the side-effect throws

`VcsProvider` was extended with the methods the executor needs (`createIssue`, `addLabels`, `removeLabels`, `approvePullRequest`, plus the existing `postComment`, `closeItem`, `mergePullRequest`); both GitHub and GitLab implement them. The HTMX approve/reject buttons that flip a `pending` decision to `executed`/`rejected` land in the next change (PR #3b) — for now, pending decisions sit in the chat with instructions on what's coming.

15 new tests cover every cell of the matrix with a mock VcsProvider; no live API calls in the test suite.


### Fixed — director: engine fallback and failure-streak hardening

The director's LLM-tick previously assumed `ANTHROPIC_API_KEY` was always available, throwing on construction when it wasn't and looping on the same error every minute (because the construction-failure path didn't mark the tick or bump the failure streak). Now:

- Engine selection auto-detects: **Anthropic** if `ANTHROPIC_API_KEY` is set, else **MIMO** if `XIAOMI_MIMO_API_KEY` is set, else fail with an actionable error message.
- Override via `OPENRONIN_DIRECTOR_THINK_ENGINE=anthropic|mimo`.
- Engine-construction errors and schema-invalid LLM output now both `markTick` + `bumpFailureStreak` — so transient errors don't infinite-loop and the existing `pause_on_failure_streak` gate (default 3) actually trips.
- Successful ticks `resetFailureStreak` so a few intermittent failures don't permanently pause the director.
- Per-engine model defaults: `claude-sonnet-4-6` for Anthropic, `mimo-v2.5-pro` for MIMO.


### Fixed — deploy lane: robust against non-trigger-branch checkout

Deploy documentation and the admin UI config example now use `git checkout <branch> && git pull --ff-only` instead of a bare `git pull --ff-only`. This prevents failures when the target directory is checked out on a branch other than `trigger_branch` (e.g. after a squash-merge deletes the feature branch that the directory happened to be on).

### Added — Director (autonomous PM layer), foundation

A new optional service, `openronin-director.service`, adds a third architectural layer above the existing supervisor/worker split. The Director runs as a separate systemd unit but shares this codebase, the SQLite DB, and `OPENRONIN_DATA_DIR`. It's the source of intent — what the project should work on next — where the existing daemon is purely reactive to events.

This release is the **foundation only**: schema, scaffolding, charter loader, adaptive-budget tracker, decision audit trail, chat thread data layer, read-only admin timeline at `/admin/director`. The service ticks per `cadence_hours`, captures the charter version, and writes a no-op message to its chat. The LLM-driven planning tick lands in the next release.

- New schema migration **v12** — `director_messages`, `director_decisions`, `director_charter_versions`, `director_budget_state`. All new tables; nothing existing is touched.
- New per-repo YAML block: `director:` (Zod-validated). Default disabled; needs `enabled: true` plus a non-empty `charter` to do anything.
- New entry point: `node dist/index.js director:run` — the long-running director service.
- New env vars: `OPENRONIN_DIRECTOR_DISABLED` (master kill switch), `OPENRONIN_DIRECTOR_TELEGRAM_TOKEN` (reserved for the upcoming Telegram bridge).
- New systemd unit template at `deploy/openronin-director.service`.
- New docs: `docs/DIRECTOR.md`.
- 11 new unit tests covering migration, charter parsing/versioning/dedup, chat append + recent + since helpers, decision lifecycle, budget gate (paused / failure-streak / think / daily / weekly).

Safe to upgrade without enabling: existing functionality is unchanged. The director sub-route at `/admin/director` returns "no director-enabled repos" until you opt in per repo.


## [0.1.0] — Initial public release

First public release. The codebase has been used in production on a handful of personal repos for several weeks before this point; this release is the cleaned-up, sanitized, and re-licensed version of that work.

### Architecture

- **Supervisor / worker split.** A cheap LLM (Xiaomi MIMO by default) routes and classifies; an expensive coder (Claude Code) is the only engine allowed to mutate code, and only inside isolated worktrees.
- **Lane router (`pickLane`).** A single function in `src/scheduler/worker.ts` decides what happens next for any given task. No opaque agent loop deciding what's next.
- **VCS / Tracker abstractions.** `VcsProvider` and `TrackerProvider` interfaces keep the rest of the code vendor-neutral. Adding a new VCS or tracker is one new file.

### Lanes

- **triage** — classify new issues / PRs (MIMO).
- **analyze** — expand requirements or ask clarifying questions before any code is written (MIMO). Tracks awaiting-answer state via a label.
- **patch** — clone repo, run Claude Code in a worktree, commit, push, open a draft PR. Auto-commits leftover dirty changes if no protected paths are touched.
- **patch_multi** *(opt-in)* — coder + reviewer two-pass with critique iteration loop.
- **pr_dialog** — react to a comment on the bot's own PR: post a threaded reply, push a fix-up commit, resolve the thread.
- **conflict_resolve** *(opt-in)* — when a merge conflict appears during auto-merge, rebase + ask the agent to edit conflict markers + force-push-with-lease. Capped per PR to prevent loops.
- **auto_merge** *(opt-in)* — when all replies are addressed, mergeable, and CI is green: squash-merge and close.
- **deploy** *(opt-in)* — on push to a configured branch by the bot user, run shell commands either locally or via SSH. Including self-deploying openronin itself.

### Providers

- **VCS:** GitHub (full implementation including threaded review replies via REST + GraphQL `resolveReviewThread`, GraphQL `markReadyForReview`, combined CI status, force-with-lease push); GitLab (full).
- **Tracker:** GitHub Issues, Jira, Todoist, Telegram (long-poll bot).

### Engines

- **MIMO** (Xiaomi) — OpenAI-compatible HTTP, JSON-mode with loose-fallback parser, retry on 429/5xx, per-tier cost estimation (low ≤256K context vs high >256K context, including cache-read pricing).
- **Claude Code** — spawns the `claude` CLI with `--print --output-format json --model X`. Detects rate-limit errors and surfaces a structured `RateLimited` exception with reset time parsing.
- **Anthropic native API** — used for the multi-agent reviewer role.
- **Multi-agent** — coder + reviewer orchestration for the `patch_multi` lane.

### Scheduling

- **Per-repo workers.** A long task in repo A doesn't block repo B. Drains run in parallel across watched repos, each guarded by a per-repo busy flag.
- **Graceful shutdown.** SIGTERM awaits in-flight workers + tracked side-activities (e.g. ongoing deploys) for up to a configurable timeout before exiting.
- **Crash recovery.** On startup, tasks/runs/deploys left in `running` state are reset to `pending` (high priority) with a recovery audit trail. After 3 consecutive crash-recoveries on the same task, it auto-abandons to prevent loops.
- **Rate-limit cooldown.** When an engine reports a hard 429, the task is deferred until the engine-surfaced reset moment (or a configured cooldown, whichever is longer).
- **Reconcile + drain.** Background loops poll watched repos for new tasks (reconcile) and dispatch queued work to engines (drain). Both can be triggered manually from the admin UI.
- **Cadence buckets.** Per-task hot/default/cold cadence selection (`5m` / `1h` / `24h` by default) — active PRs poll fast, quiet repos slow.

### Storage

- **SQLite via better-sqlite3.** WAL mode, foreign keys on. Schema versioned through migrations.
- **State outside the code tree.** Database, work-trees, prompt logs, secrets, ssh keys all live under `$OPENRONIN_DATA_DIR`. The code tree is byte-for-byte clean of state.
- **Backups.** Hourly local snapshot via `scripts/sqlite-backup.mjs` + daily off-host rsync via `scripts/daily-rsync.sh`, both invokable from systemd timer units in `deploy/`.

### Admin UI

- **Server-rendered HTMX + Tailwind CDN.** Pragmatic, not pretty. No SPA build step.
- **Live workers panel** — busy / idle dot per repo, last-run timestamps.
- **Active PRs panel** — open PRs with iteration count, last activity.
- **Recent errors panel** — last 24h, prioritised.
- **Per-task drill-down** — full prompt, model output, diff, lane decisions, run history.
- **Cost dashboard** — per-day, per-lane, per-model, per-repo aggregations with charts.
- **Configurable timezone** (default Europe/Moscow) and refresh rate (off / 5s / 10s / 1m).
- **Pause switch** — drops a `.PAUSE` file; scheduler stops dispatching, in-flight work finishes normally.
- **Manual triggers** — kick pending, reconcile-now, drain-now, deploy-now, clear rate-limit, ensure-labels.
- **Audit log** — every admin action persisted to a separate `admin_audit` table.
- **Webhook info panel** — copy-paste payload URL / secret / event list for repos where the bot doesn't have admin to set the hook automatically.
- **Deploy config example panel** — annotated YAML for both local and SSH deploy modes.
- **Show SSH public key** — copy-paste the bot's public key for ssh-mode deploy targets.
- **Command palette (Cmd-K)** + keyboard shortcut overlay (`?`).
- **Dark mode**, mobile nav drawer.

### Security & robustness

- **Bot self-event filter.** Every bot post starts with the configurable `BOT_PREFIX` (default `🥷 openronin:`). Filter prevents the bot from reacting to its own posts.
- **Token redaction.** All logs scrub `https://x-access-token:TOKEN@` URLs and bare `gh[pousr]_*` strings before persisting.
- **Cost caps.** Hard kill-switches at per-task and per-day USD limits; no run starts past the cap.
- **Patch idempotency.** A second trigger of the same task is a no-op when an `open` / `created` PR branch already exists.
- **Force-push with explicit lease.** All force-pushes use `--force-with-lease=<branch>:<sha>` rather than the bare form, avoiding stale-info rejects after single-branch clones.
- **Iteration counter** for `pr_dialog` only bumps on successful pushes — failed iterations don't burn the budget.
- **Protected paths** in patch lane — workflows, lockfiles, etc. are auto-blocked from modification.
- **Diff size cap** — refuses to open a PR over a configurable diff-line threshold.

### CLI

- `init`, `config:show`
- `repo:add`, `repo:list`, `repo:sync`, `repo:connect-webhook`
- `github:whoami`
- `engine:test`
- `review:item`, `patch:item`, `pr-dialog:run`
- `pr:list`
- `scheduler:tick`, `scheduler:status`
- `runs:list`

### MCP server

A minimal stdio MCP server (`bin: openronin-mcp`) exposes a read/write subset of the REST API to any MCP-compatible client (Claude Desktop, IDE plugins, custom assistants). Authenticates via `OPENRONIN_API_TOKEN` bearer.

### Built with

TypeScript (Node 22+ / `tsc`), [Hono](https://hono.dev/) for HTTP, [better-sqlite3](https://github.com/WiseLibs/better-sqlite3), [@octokit/rest](https://github.com/octokit/rest.js) + GraphQL, [zod](https://zod.dev/), [oxlint](https://oxc.rs/) + [oxfmt](https://oxc.rs/) (no Prettier / ESLint).
