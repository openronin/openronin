# Director — autonomous PM layer

> **Status:** complete. Schema v13. Five-PR rollout landed: foundation (#21), LLM-driven dry_run tick with auto-engine selection (#24, #25), execution backend (#28), two-way admin chat with HTMX approve/reject + Telegram bridge (#29, #31), adaptive budget retrospective (#32). The director is currently running in `propose` mode on `openronin/openronin` and idle on other watched repos (no charter).

The Director is a separate systemd service (`openronin-director.service`) that runs alongside the main openronin daemon. It shares the same code, database, and `OPENRONIN_DATA_DIR` but plays a different role: where the main daemon **reacts** to events (issue created, PR comment, push), the Director **proactively** decides what the project should work on next.

This is the third layer in the architecture:

```
Director  ── source of intent (what should the project work on?)
   ↓
Supervisor ── routes lanes (which lane runs next?)
   ↓
Worker    ── writes code (the actual change)
```

The Director never edits source files directly. Code mutations stay with the Claude Code worker — the Director only emits **decisions** (create issue, comment on PR, approve merge, …) which are then carried out via the existing `VcsProvider` and lane infrastructure.

## Why a separate service

- **Independent lifecycle.** Stop / restart / pause the Director without touching the main daemon. Different resource limits, different restart policy.
- **Clear blast radius.** A bug in Director planning can't crash the scheduler that's mid-flight on a PR.
- **Single source of intent per repo.** One Director per repo, one chat thread, one charter. No coordination problem.
- **Same DB, same code.** Not a microservice — just a different entry point on the same bundle.

## Modes

The Director runs in one of five modes. We ramp up confidence by stepping through them; each mode is more autonomous than the last:

| Mode        | Creates artifacts | Acts on chat | Merges | Use when |
|-------------|-------------------|--------------|--------|----------|
| `disabled`  | —                 | —            | —      | switched off |
| `dry_run`   | logs only         | logs only    | —      | calibrating the charter — read what the Director *would* do for a few days before letting it act |
| `propose`   | only after explicit chat-approval | drafts replies, doesn't post | — | tighter feedback loop, you ack each proposal |
| `semi_auto` | yes               | yes          | queued for approval | most operations autonomous; you still approve merges |
| `full_auto` | yes               | yes          | yes    | fully autonomous; escalates only on failures |

**Foundation phase (this PR) only `dry_run` is meaningful** — the LLM tick that produces real proposals lands in PR #22.

## Charter

The charter is the Director's "constitution" for a repo: vision, priorities, out-of-bounds zones, definition of done. It lives in the per-repo YAML config under `director.charter:` and is **versioned** in `director_charter_versions` — every decision pins exactly which version of the charter produced it, so the audit trail stays meaningful even when the charter evolves.

Minimal charter:

```yaml
director:
  enabled: true
  mode: dry_run
  cadence_hours: 6
  charter:
    vision: |
      Reliable, observable AI dev agent. Reliability and observability
      come before features.
    priorities:
      - id: reliability
        weight: 0.5
        rubric: "graceful failure, crash recovery, no lost work"
      - id: observability
        weight: 0.5
        rubric: "user can debug runs without SSH"
    out_of_bounds:
      - "do not change DB schema without a versioned migration"
      - "do not add npm dependencies without explicit approval"
    out_of_bounds_paths:
      - "src/storage/db.ts"
      - "package.json"
    definition_of_done:
      - "pnpm run check is green"
```

**Without `enabled: true` and a non-empty `charter`, the Director silently skips that repo.** This is the safe default.

## Adaptive budget

Two cost streams, capped independently:

- **project budget** — the cumulative cost of work the Director-spawned issues end up consuming via the worker. Daily + weekly caps. In phase 1 these are static (set from `initial_*_usd`); in PR #25 they climb on good outcomes and shrink on bad ones.
- **think budget** — what the Director itself spends on its planning LLM calls. Hard daily cap (`think_daily_usd`, default $1.00).

Plus a **failure-streak gate**: N consecutive failures (rejected proposal, red CI, lane error) auto-pause the Director and post an `error` message in the chat asking for a human directive. Default: 3.

## Authority

Per-decision-type permissions. The composition `mode × authority × budget × out-of-bounds` decides whether a particular decision is executed automatically, queued for approval, or refused outright.

```yaml
director:
  authority:
    can_create_issues: true
    can_label: true
    can_close_issues: false   # safer default — humans close issues
    can_comment: true
    can_approve_pr: true
    can_merge: false          # default OFF, require explicit opt-in
    can_modify_charter: false # human-only zone
```

## Chat thread

Each director-enabled repo has one chat thread, stored in `director_messages`. It's the live communication channel between the Director and the human:

| Sender    | Type                                  | Purpose |
|-----------|---------------------------------------|---------|
| Director  | `tick_log`                            | "tick fired (no-op)" — boring, but proves the loop is alive |
| Director  | `status`                              | "I started working on issue #X, here's why" |
| Director  | `proposal`                            | "I want to do X — approve / reject" (with HTMX buttons in PR #23) |
| Director  | `question`                            | "ambiguity in priorities X vs Y, please decide" |
| Director  | `report`                              | "did X, outcome was Y" |
| User      | `directive`                           | "focus on tests this week" |
| User      | `answer`                              | reply to a `question` |
| User      | `veto`                                | cancel a pending decision |
| System    | `error`                               | "tick threw, paused" |

The chat is two-way at `/admin/director/<slug>` (HTMX form for posting, inline `[✓ Approve]` / `[✗ Reject]` buttons on pending proposals) and via Telegram (`@<your-bot>` polling, see "Telegram bridge" below).

## Decisions audit trail

Every decision the Director takes — even no-ops — is persisted into `director_decisions` **before** any side-effect runs:

```
ts             | type           | outcome  | charter | rationale
2026-05-01 03  | no_op          | dry_run  | v1      | Foundation tick: scheduler...
2026-05-01 09  | create_issue   | pending  | v1      | observability priority is at 0.30...
2026-05-01 10  | create_issue   | executed | v1      | (from above; user approved)
```

So if the service crashes mid-execution, the next tick can pick up exactly where it left off without double-acting. And if the user wants to know "why did the Director close issue #34?" — the rationale is right there in the table, pinned to the charter version that produced it.

## Operations

### Enable on a new repo

1. Add a `director:` block to the per-repo YAML in `$OPENRONIN_DATA_DIR/config/repos/<slug>.yaml`. Set `enabled: true`, write a charter.
2. Config is hot-reloaded — no restart needed. Director picks up the new repo on its next loop tick (≤ 60s).

### Disable temporarily

- **One repo:** `director.enabled: false` in the per-repo YAML, or `director.mode: disabled`.
- **All repos / kill switch:** `OPENRONIN_DIRECTOR_DISABLED=1` in env. Service stays up, logs `disabled`, idles. Restart needed to reload env.
- **Permanent:** `systemctl stop openronin-director.service` (followed by `disable` if you want it not to come back).

### Manual pause for one repo

From Telegram: `/pause <slug>` (and `/resume <slug>`).
From admin UI: not yet a button — pause via direct DB write or Telegram.

```bash
sqlite3 $OPENRONIN_DATA_DIR/db/openronin.db \
  "UPDATE director_budget_state SET paused = 1, pause_reason = 'manual' WHERE repo_id = ?"
```

The Director will write `tick skipped: paused: manual` to the chat on its next tick instead of acting.

### Watching the Director

```bash
# logs
journalctl -u openronin-director -f

# what it's saying
sqlite3 $OPENRONIN_DATA_DIR/db/openronin.db \
  "SELECT ts, role, type, substr(body, 1, 80) FROM director_messages
   ORDER BY id DESC LIMIT 20;"

# decisions
sqlite3 $OPENRONIN_DATA_DIR/db/openronin.db \
  "SELECT ts, decision_type, outcome, substr(rationale, 1, 60)
   FROM director_decisions ORDER BY id DESC LIMIT 20;"

# budget
sqlite3 $OPENRONIN_DATA_DIR/db/openronin.db \
  "SELECT * FROM director_budget_state;"
```

Or the admin UI: `https://your-host/admin/director`.

### systemd unit

```
deploy/openronin-director.service
```

Production install:

```bash
sudo cp deploy/openronin-director.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now openronin-director.service
```

Director-specific secrets (e.g. `OPENRONIN_DIRECTOR_TELEGRAM_TOKEN`) go in `$OPENRONIN_DATA_DIR/director.env` — kept separate from the main `secrets.env` so they can be rotated independently. Mode `0600` so only the service user can read.

### Self-deploy

If the director is running on the same host that the deploy lane targets (the eat-own-dogfood pattern), add the director-service restart to the per-repo `deploy.commands` so a merge to `main` updates both services in one go. Sudoers needs to allow the new command:

```
# /etc/sudoers.d/openronin-deploy
claude ALL=(root) NOPASSWD: /bin/systemctl --no-block restart openronin, /bin/systemctl --no-block restart openronin-director
```

```yaml
# per-repo YAML
deploy:
  mode: local
  commands:
    - cd /data/dev/openronin && git checkout main && git pull --ff-only
    - cd /data/dev/openronin && pnpm install --frozen-lockfile
    - cd /data/dev/openronin && pnpm build
    - sudo /bin/systemctl --no-block restart openronin
    - sudo /bin/systemctl --no-block restart openronin-director
```

Without the second restart, the director service runs the OLD `dist/` until the next manual restart — main openronin picks up new code via its own `KillMode=process`, but the director is a separate systemd unit with the same trick so it must be told to recycle.

## Telegram bridge

Configure two env vars in `$OPENRONIN_DATA_DIR/director.env`:

```
OPENRONIN_DIRECTOR_TELEGRAM_TOKEN=<from @BotFather>
OPENRONIN_DIRECTOR_TELEGRAM_USER_IDS=12345,67890
```

The bridge refuses to start if the token is set but the whitelist is empty (otherwise it would accept commands from anyone).

Once running, the bridge does two things:

1. **Outbound mirror.** Every new `director_messages` row with `role='director'` or `'system'` is forwarded to each whitelisted Telegram chat. Pending proposals append a `/approve <id> · /reject <id>` reminder.
2. **Inbound commands.** Slash commands (whitelist enforced):
   - `/repos`, `/status`, `/budget`, `/pending`, `/help`
   - `/approve <id>` / `/reject <id> [reason]` — same code path as the admin UI buttons
   - `/pause <slug>` / `/resume <slug>`
   - **plain text** → recorded as a `directive`-typed user message (prefix with `repo:<slug> -- ` to target a specific repo)

## Adaptive budget

The daily/weekly caps in `director_budget_state` aren't static. Once per UTC day, on the first tick of the day, a retrospective looks at the last 14 days of decision outcomes and adjusts:

- **success_rate ≥ 0.80** over ≥5 decisions → climb 10% (capped at `max_daily_usd` / `max_weekly_usd`)
- **success_rate ≤ 0.40** → shrink 20% (floored at `initial_daily_usd` / `initial_weekly_usd`)
- otherwise hold steady

`success_rate = executed / (executed + failed + rejected)`. `skipped` is excluded — it's an operator policy choice, not an outcome. Each adjustment is logged to `director_budget_history` with the rationale.

This isn't a "good outcome retrospective" in the strong sense (would need to poll VCS for reverts and CI failures over a 7-day quarantine after each `executed` merge — out of scope). The current model uses immediate decision outcomes as a proxy and is honest about its limits.

## Roadmap

The five-PR rollout is complete:

- **#21** — foundation (schema, scaffolding, no-op tick)
- **#24, #25** — LLM-driven dry_run tick + auto-engine selection (Anthropic / MIMO)
- **#28** — execution backend (mode × authority × decision-type matrix)
- **#29** — admin UI two-way chat (HTMX approve / reject / message form)
- **#31** — Telegram bridge
- **#32** — adaptive budget retrospective

What's reasonable to add next, separately:

- **Outcome retrospective.** Poll VCS post-merge for reverts / CI failures over a 7-day window; weight that into the adaptive budget instead of (or alongside) the immediate decision outcome.
- **Quality gates.** Per-PR metrics (lint score, coverage delta, bundle size) feeding into approve/merge decisions.
- **Plugin lanes.** External lane providers via MCP / HTTP so users can add custom decision types without forking.
- **Multi-tenant.** Several director instances on one host (different bot identities, different repos).
