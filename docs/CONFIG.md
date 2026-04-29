# Configuration reference

openronin reads configuration from three sources, in order of precedence:

1. **Environment variables.** Always win. See [`.env.example`](../.env.example) for the full list.
2. **Per-repo YAML.** Located at `$OPENRONIN_DATA_DIR/config/repos/<provider>--<owner>--<name>.yaml`. One file per watched repo. Created automatically when you add a repo via the admin UI; safe to edit by hand.
3. **Global YAML.** Located at `$OPENRONIN_DATA_DIR/config/openronin.yaml`. Optional — everything has a sensible default. Template at [`config/openronin.example.yaml`](../config/openronin.example.yaml).

Both YAML files are watched via `fs.watch` and **hot-reloaded**. You don't need to restart the daemon when you edit them.

---

## Environment variables

See [`.env.example`](../.env.example) for the canonical list with comments. Brief recap:

| Variable | Purpose | Default |
|---|---|---|
| `OPENRONIN_DATA_DIR` | Where state lives | `./.dev-data` |
| `OPENRONIN_PORT` | HTTP port | `8090` |
| `OPENRONIN_BASE_URL` | Public URL for webhook construction | `http://localhost:8090` |
| `OPENRONIN_ADMIN_USER` | Admin UI basic-auth username | `admin` |
| `ADMIN_UI_PASSWORD` | Admin UI basic-auth password | (none — admin UI disabled if unset) |
| `OPENRONIN_API_TOKEN` | Bearer token for `/api/*` | (none — API disabled if unset) |
| `OPENRONIN_BOT_PREFIX` | String every bot post starts with | `🥷 openronin:` |
| `OPENRONIN_BOT_GIT_NAME` | git author name for bot commits | `openronin[bot]` |
| `OPENRONIN_BOT_GIT_EMAIL` | git author email | `openronin-bot@users.noreply.github.com` |
| `OPENRONIN_CLAUDE_BIN` | path to `claude` CLI | `claude` (uses `$PATH`) |
| `GITHUB_TOKEN` | Bot's PAT for GitHub | (required for GitHub repos) |
| `GITLAB_TOKEN`, `GITLAB_HOST` | GitLab auth | (required for GitLab repos) |
| `XIAOMI_MIMO_API_KEY`, `XIAOMI_MIMO_BASE_URL` | Supervisor LLM | (required if using `mimo` engine) |
| `ANTHROPIC_API_KEY` | Multi-agent reviewer | (required for `patch_multi`) |
| `JIRA_TOKEN`, `TODOIST_TOKEN`, `TELEGRAM_BOT_TOKEN` | Tracker auth | (per integration) |
| `WEBHOOK_SECRET` | HMAC verification for incoming webhooks | (required in production) |

---

## Global YAML schema

Defined as Zod schemas in [`src/config/schema.ts`](../src/config/schema.ts). The example with inline comments lives at [`config/openronin.example.yaml`](../config/openronin.example.yaml).

```yaml
server:
  port: 8090                   # int, default 8090
  base_url: http://localhost:8090
  admin_user: admin

engines:
  defaults:
    triage:      { provider: mimo, model: mimo-v2.5-pro }
    analyze:     { provider: mimo, model: mimo-v2.5-pro }
    deep_review: { provider: claude_code, model: sonnet }
    patch:       { provider: claude_code, model: sonnet }
    pr_dialog:   { provider: claude_code, model: sonnet }
    patch_multi: { provider: multi_agent }

cadence:
  hot: 5m                      # poll cadence for active items (e.g. open PRs)
  default: 1h                  # default repo poll cadence
  cold: 24h                    # archived / quiet repos

cost_caps:
  per_task_usd: 5.0
  per_day_usd: 50.0

rate_limit_cooldown: 30m       # after engine 429, pause this long minimum

scheduler:
  reconcile_interval: 15m      # full re-poll of every watched repo
  drain_interval: 30s          # how often workers pull from queue
  drain_batch_size: 5          # max tasks per drain tick

telegram:
  allowed_user_ids: []         # empty = anyone (NOT recommended publicly)
  poll_timeout_seconds: 30
```

### Duration strings

`cadence.*`, `rate_limit_cooldown`, `scheduler.*_interval` accept duration strings of the form `<number><unit>`:

- `s` — seconds
- `m` — minutes
- `h` — hours
- `d` — days

Examples: `5m`, `1h`, `24h`, `7d`. Case-insensitive.

---

## Per-repo YAML schema

```yaml
provider: github               # github | gitlab | gitea (gitea not yet implemented)
owner: acme                    # required
name: widgets                  # required
watched: true                  # default true; set false to pause scheduler for this repo

# Which lanes are active for this repo. Each lane only runs if listed here.
lanes: [triage, analyze, patch, pr_dialog]

# Override polling cadence for just this repo (otherwise inherits global)
cadence:
  hot: 2m
  default: 30m

# Per-job-type engine overrides. Omitted = use global default.
engine_overrides:
  triage: { provider: mimo, model: mimo-v2.5-pro }
  patch: { provider: claude_code, model: sonnet }

# Per-job-type prompt overrides. Path is relative to $OPENRONIN_DATA_DIR/prompts/
prompt_overrides:
  patch: custom-patch-prompt.md

# Bot label conventions
patch_trigger_label: openronin:do-it
in_progress_label: openronin:in-progress
awaiting_answer_label: openronin:awaiting-answer
awaiting_action_label: openronin:awaiting-action

# Behaviour knobs
acknowledge_with_reaction: true    # post 👀 / 👍 reactions
acknowledge_with_comment: true     # post "I'm taking this one" / "done" comments

# Issue triage filters
protected_labels: []           # issues with these labels are skipped (e.g. "blocked", "needs-design")
skip_authors: []               # comments from these authors don't trigger pr_dialog
allowed_close_reasons: []      # if non-empty, triage may only close with these reasons

# Patch lane (L3)
patch_default_base: main
protected_paths:               # files the agent must not modify
  - .github/workflows/
  - package-lock.json
  - pnpm-lock.yaml
  - Cargo.lock
  - go.sum
max_diff_lines: 500            # PR is rejected if diff exceeds this
draft_pr: true                 # open PR as draft

# patch_multi (L6, opt-in)
patch_multi_max_critique_iterations: 2

# pr_dialog (L4)
pr_dialog_max_iterations: 10
pr_dialog_skip_authors: [openronin[bot], dependabot[bot]]

# Auto-merge (L4.5, opt-in)
auto_merge:
  enabled: false
  strategy: squash             # merge | squash | rebase
  require_checks_pass: true
  unblock_draft: true          # automatically mark ready-for-review before merge
  resolve_conflicts: true      # try agent-driven rebase on mergeable=false
  resolve_conflicts_max_attempts: 3

# Deploy (CD lane, opt-in)
deploy:
  mode: disabled               # disabled | local | ssh
  trigger_branch: main
  bot_login: openronin-bot     # which GitHub user's pushes trigger
  require_bot_push: true
  commands: []
  ssh:                         # only used when mode == ssh
    user: deploy               # LINUX user on target
    host: example.com
    port: 22
    key_path: /var/lib/openronin/secrets/ssh/id_ed25519
    strict_host_key_checking: true

# Optional Jira tracker (per-repo)
# Auth comes from JIRA_TOKEN env var.
# jira_tracker:
#   base_url: https://acme.atlassian.net
#   project_key: PROJ
#   label_filter: ai-eligible
#   webhook_secret: ...

# Optional Todoist tracker (per-repo)
# Auth from TODOIST_TOKEN env var.
# todoist_tracker:
#   project_id: "1234567890"
#   label_filter: code

# Language rules — surfaced to the agent in every prompt
language_for_communication: English
language_for_commits: English
language_for_code_identifiers: English
```

---

## Hot reload behaviour

When a YAML file changes:

1. The change is detected via `fs.watch` (debounced 300ms).
2. The file is re-parsed and re-validated against the Zod schema.
3. If validation passes, the in-memory config is swapped atomically.
4. If validation fails, the previous valid config is kept and an error is logged. The daemon does not crash.
5. Active workers finish their current task with the **old** config; new tasks pick up the new config.

This means most config changes are safe to make on a running production instance. The exceptions:

- Changes to `server.port` require a restart.
- Changes to `OPENRONIN_DATA_DIR` (env var) require a restart.
- Adding a new repo via direct YAML write requires creating the SQLite row too — easier to do via the admin UI's "Add repo" button.

---

## See also

- **[LANES.md](LANES.md)** — what each lane actually does
- **[PROVIDERS.md](PROVIDERS.md)** — wiring up GitLab, Jira, Todoist, Telegram
- **[DEPLOYMENT.md](DEPLOYMENT.md)** — production setup
- **[`src/config/schema.ts`](../src/config/schema.ts)** — the source of truth
