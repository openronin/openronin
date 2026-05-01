# Changelog

All notable changes to **openronin** are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/), and the project loosely follows [SemVer](https://semver.org/) — though as a self-hosted tool with a config schema rather than a public API, "breaking" mostly means schema migrations.

## [Unreleased]

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
