# Director — autonomous PM layer

> **Status:** in production. Schema v17. The five-PR foundation rollout was followed by a UX-focused audit (PRs #56–#66) that added persona/voice, reactive ticks, edit-before-approve, decision dedup, daily digest, stale watchdog, trust-ramp suggestions, an engine split for cheap chat replies, standing operator notes, slash commands in the admin chat, and operational polish (pending-proposal expiry, transient-error retry, charter diff in chat, syntax-highlighted code in markdown). The director is running in `propose` mode on `openronin/openronin` and idle on other watched repos (no charter).

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

## Persona / voice

The default Director introduces itself as "Director" with a neutral product-manager voice. Add a `persona` block to the charter to give it a name, role, voice, and style — this is woven into the system prompt so the LLM actually inhabits the voice instead of producing the same templated "I propose…" boilerplate every tick:

```yaml
director:
  charter:
    persona:
      name: "Лёша"
      role: "PM / product owner"
      voice: "конкретный, без воды; признаёт неопределённость"
      style: "короткие сообщения, asks rather than guesses"
      avatar: "🧑‍💼"
```

The chat-bubble label in `/admin/director` becomes `🧑‍💼 Лёша`; signed messages drop the generic `👔 director:` prefix. The persona is captured per charter version, so changes are part of the audit trail.

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

### Language

The director's chat output, `ask_user` questions, proposal bodies, and the bodies of any issue/PR comment it produces are written in `director.language` (default `English`). Free-form string fed verbatim into the prompt — `"Russian"`, `"日本語"`, `"code-mixed Russian/English (technical terms in English)"` all work.

This is **independent** of the existing repo-level `language_for_communication` / `language_for_commits` / `language_for_code_identifiers` — those govern the code-writing agents. A project can communicate via the director in Russian while keeping commit messages and code identifiers in English.

```yaml
director:
  language: "Russian"
```

JSON keys, decision-type identifiers (`create_issue`, `no_op`, …), label names, and other machine-readable tokens always stay in English regardless of this setting.

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

## Reactivity

The Director loop wakes every **10 seconds** (was 60s). Two triggers fire a tick:

1. **Cadence** — `cadence_hours` elapsed since `last_tick_at`. Routine planning round, uses the heavy engine.
2. **`user_message`** — a chat directive without a director reply yet. Ticks within ~10–30s instead of waiting up to 6h. Uses the cheap engine (see "Engine split").

Concurrent ticks on the same repo are serialised by `director_active_ticks` — a row exists while a tick is in flight (TTL 300s). The admin chat status panel polls this row to render `🟡 \<persona\> is thinking…` (every 2s while busy, 10s when idle). The same row works as an advisory lock: if a webhook-triggered tick lands during a scheduled tick, the second one skips silently.

A `[▶ Tick now]` button in the admin UI (and `/tick` in the Telegram bridge) clears `last_tick_at`, forcing a tick on the next loop iteration.

## Edit before approve

For each pending `proposal`-type decision, the chat bubble grows three buttons: `✓ Approve as-is`, `✏ Edit & approve`, `✗ Reject`. Edit opens a type-aware form pre-populated from the LLM's payload — title/body/labels/priority for `create_issue`, body for comments, add/remove for labels, etc. Submit → executor merges your edits onto the stored payload before running, and the merged payload is persisted back so the audit trail records what was actually executed (not the original proposal).

Identifying fields like `issue_number` are deliberately not editable; only the type-relevant content fields pass through.

## Decision dedup

The LLM was prone to re-proposing the same `create_issue` tick after tick when its state-snapshot lagged just-proposed-but-unmerged work. Each new decision now hashes a normalised canonical form of `(decision_type, payload)` — folded case, whitespace, common prefixes, set-order for label arrays. Before insert we check for a pending or executed match in the last 7 days; a hit becomes `outcome=skipped` with a `duplicate of decision #N` reason. The original is preserved (audit trail intact); the executor never sees the duplicate.

`ask_user` and `no_op` are exempt — they're cheap and idempotent already.

## Stale watchdog

Each state snapshot includes an `attentionItems[]` list — things the LLM should look at *before* charter-driven planning:

- **`stale_pr`** — open PRs untouched for >24h
- **`stale_awaiting_answer`** — issues stuck in `openronin:awaiting-answer` >48h
- **`recent_deploy_failed`** — failed deploys in last 48h
- **`failure_streak_high`** — director's own consecutive-failure counter ≥2
- **`high_pending_proposals`** — ≥5 proposals waiting for human approval (signal to stop piling on)

Each list capped at 3–5 items so a project on fire doesn't balloon the prompt. Surfaced under an "Attention first" prompt section that explicitly tells the LLM to address these before opening new work.

## Trust ramp

Mode escalation usually loses to operator inertia: `dry_run` → `propose` → `semi_auto` → `full_auto` requires someone to remember to flip the YAML. Once a week per repo (cooldown), the loop posts a chat suggestion when the data justifies it:

- **promote** when ≥30 terminal decisions over 14d at ≥90% executed
- **demote** when ≥10 terminal decisions over 14d at ≤40% executed

The mode itself is never mutated programmatically — the message tells the operator exactly which YAML line to flip. Hot-reload picks it up.

## Engine split (chat-vs-plan)

Reactive ticks (chat directives, `reason='user_message'`) prefer MIMO; scheduled cadence ticks prefer Anthropic Sonnet. Same `selectThinkEngine` function with a `preferCheap` flag. Result: a chat reply costs ~$0.001 instead of ~$0.05 and lands faster. Override via `OPENRONIN_DIRECTOR_THINK_ENGINE=anthropic` (forces heavy regardless) or `OPENRONIN_DIRECTOR_CHAT_MODEL` (pin a specific MIMO variant for chat replies, e.g. `mimo-v2.5-flash`).

## Standing operator notes

Long-term "this is how I want you to behave" memory that survives the 25-message recent-chat window. Stored in `director_notes` (`id / repo_id / kind / body / source_message_id`). Two paths feed it:

1. The director can emit a `remember_preference` decision when it hears the operator state a durable preference. No approval needed — it's an internal memory write.
2. Operator can add or delete notes directly via the **Standing notes** card on `/admin/director/<slug>`.

State snapshot grows a `standingNotes[]` field (capped at 20). The director-tick prompt renders them in a dedicated "Standing notes from the operator" section.

## Daily morning digest

Once a day per repo, around `digest.hour` in `digest.timezone`, the loop runs a cheap MIMO call with a separate prompt template (`prompts/templates/director-digest.md`) and posts ONE `status` chat message. No decisions, no executor invocation — just a "good morning" rundown of overnight changes.

```yaml
director:
  digest:
    enabled: true
    hour: 9
    timezone: Europe/Moscow
```

Once-per-local-day idempotency is enforced via `last_digest_date` on `director_budget_state`. The digest never burns the proposal budget; it's tracked under the think budget like any other planning call. Trigger a manual digest with the `/digest` slash command or the Telegram bridge.

## Slash commands in admin chat

The composer accepts both kinds of input. A leading `/cmd` is interpreted as a command; everything else falls through to the regular `directive` path. Commands echo the operator's input as a user-directive (audit) and post the response as a system `tick_log`.

| Command            | Effect |
|--------------------|--------|
| `/tick`            | Clears `last_tick_at` so the next loop iteration fires (≤10s). |
| `/digest`          | Runs the morning digest right now, regardless of schedule. |
| `/pause [reason]`  | Sets `paused=1` on the budget state. |
| `/resume`          | Clears the paused flag. |
| `/status`          | Shows mode, paused?, last tick, failure streak, today's think spend. |
| `/budget`          | Shows daily/weekly cap + spend. |
| `/help`            | Lists the commands. |

The Telegram bridge has the same set plus `/repos`, `/pending`, `/approve <id>`, `/reject <id>`.

## Operational polish

- **Pending expiry.** Pending decisions untouched for 7d auto-flip to `outcome=expired` with a chat note. The proposal queue can't silently grow forever.
- **Transient retry.** VCS calls in the executor wrap in `withTransientRetry`. 5xx / `ECONNRESET` / timeout / "secondary rate limit" get up to 3 attempts at 1s/5s/20s backoff. Terminal errors (404, 422) bubble out unchanged.
- **Charter diff in chat.** When the YAML is updated and a new charter version is captured, the loop posts a brief diff summary (added/removed priorities, weight changes, persona renames) to the chat. v1 is silent; v(N+1) where N≥1 produces the note.
- **Syntax highlight.** `highlight.js` in the admin layout colours code-fences in chat markdown.
- **Atomic migrations.** All schema migrations run inside a single `BEGIN IMMEDIATE` transaction so two services racing on startup serialise cleanly. Earlier in development this was the source of nasty "table already exists" / "duplicate column" crashes on deploy.

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

From the admin chat composer: `/pause [reason]` and `/resume`.
From Telegram: `/pause <slug>` and `/resume <slug>`.
From SQL (last resort):

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

## Rollout history

Foundation (the original 5-PR shape):

- **#21** — schema, scaffolding, no-op tick
- **#24, #25** — LLM-driven dry_run tick + auto-engine selection (Anthropic / MIMO)
- **#28** — execution backend (mode × authority × decision-type matrix)
- **#29** — admin UI two-way chat (HTMX approve / reject / message form)
- **#31** — Telegram bridge
- **#32** — adaptive budget retrospective

UX audit follow-up (Wave 1+2+3, all merged):

- **Wave 1 — make the PM feel alive**: persona/voice (#56), reactive tick + per-repo lock (#57), edit-before-approve (#58), decision dedup (#59), daily morning digest (#60).
- **Wave 2 — proactive PM**: stale watchdog (#61), trust-ramp suggestion (#62), engine split (#63), standing notes (#64), slash commands (#65).
- **Wave 3 — operational polish**: pending expiry, transient retry, charter diff, syntax highlight (#66).
- **Production stability**: atomic migrations (#67), fast shutdown (#68, #70), digest model fix (#69).

What's reasonable to add next:

- **SSE realtime push.** Replace the 2s/10s status panel polling with EventSource so the chat refreshes the moment a tick completes. The current polling works but burns context every cycle.
- **Bulk approve.** Checkboxes on proposal bubbles + a sticky "approve N selected" bar for repetitive batches.
- **Per-decision trace UI.** Click a decision row in `/admin/director` → full prompt + response + cost + latency. Currently you have to query SQLite.
- **Outcome retrospective.** Poll VCS post-merge for reverts / CI failures over a 7-day window; feed that into the adaptive budget instead of (or alongside) the immediate decision outcome.
- **Cross-process event triggers.** When the main openronin service detects a `pr_event` or `deploy_failed`, write a signal row that the director loop reacts to in <60s. Currently the director sees these only on the next scheduled tick.
- **Quality gates.** Per-PR metrics (lint score, coverage delta, bundle size) feeding into approve/merge decisions.
- **Plugin lanes.** External lane providers via MCP / HTTP so users can add custom decision types without forking.
- **Multi-tenant.** Several director instances on one host (different bot identities, different repos).
