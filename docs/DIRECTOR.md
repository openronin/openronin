# Director — autonomous PM layer

> **Status:** foundation only. The service runs, ticks, captures the charter, and writes a no-op message to its chat thread. Real LLM-driven planning lands in PR #22; two-way chat with execution gates in PR #23; Telegram bridge in PR #24; adaptive budget in PR #25.

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

In phase 1 the chat is **read-only in the admin UI** at `/admin/director/<slug>`. Two-way (HTMX message form, approval buttons) lands in PR #23. Telegram bridge lands in PR #24.

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

Currently via direct DB write (admin UI controls land in PR #23):

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

## Roadmap

- **PR #21 — foundation** (this PR). Schema, scaffolding, no-op tick.
- **PR #22 — dry_run tick.** Real LLM call producing structured decisions; written to chat, never executed.
- **PR #23 — execution gates + chat UI.** Mode toggle drives whether decisions execute. HTMX approve/reject buttons in admin UI.
- **PR #24 — Telegram bridge.** Mirror chat to Telegram, accept directives/answers from the phone.
- **PR #25 — adaptive budget + retrospective.** Budget caps adjust based on outcome quality; 7-day quarantine before counting a merge as "good".
