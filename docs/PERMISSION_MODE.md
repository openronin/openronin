# Claude Code permission-mode: acceptEdits vs bypassPermissions

Corrected notes for issues #93, #94, #95, #100.

## TL;DR

`acceptEdits` is **not** sufficient for any lane that needs to run bash. In
`--print` (non-interactive) mode the Claude Code CLI has no human to answer
the bash approval prompt, so it fails closed: **every** bash tool call is
denied — including read-only commands like `git status`, `git fetch`,
`php -v`, `gh --version`. Code-mutating lanes therefore run with
`bypassPermissions`.

## Mapping

`src/engines/claude-code.ts` `mapPermission()`:

| `tools` policy | `--permission-mode` |
|---|---|
| `read-only` | `default` |
| `read-write` | `bypassPermissions` |
| `git-write` | `bypassPermissions` |

`bypassPermissions` is safe here because:

- The worktree is an isolated, ephemeral, per-task clone (`workdirFor()`
  under `$OPENRONIN_DATA_DIR/worktrees/…`), not the operator's checkout.
- Lane guardrails run on the **committed** diff before push — protected
  paths (`.github/workflows/`, lockfiles, …) and `max_diff_lines` reject
  anything out of policy regardless of what the agent did in-worktree.
- We always invoke with `--print`, so there's no human session for
  `bypassPermissions` to skip approvals on that a human wouldn't already
  have been forced past anyway.

## History (why this file exists)

1. **#93** — original bug: `git-write` mapped to `acceptEdits`; agents
   couldn't `git commit` in `--print` mode; edits were silently lost. Fix
   was to map `git-write`/`read-write` to `bypassPermissions`. Merged.
2. **#94** — question: does the orchestrator handle git itself, so is the
   more permissive mode strictly necessary?
3. **#95** — analytical investigation of #94 concluded `acceptEdits` is
   sufficient because "`--print` mode has no interactive approval gate." The
   revert of #93 was applied downstream. The conclusion turned out to be
   **wrong** — it was reached by reading source, without a live invocation.
4. **#100** — the bug from #93 reproduced in production: 23/23 bash tool
   calls denied in a single `pr_dialog` run, including read-only ones. The
   revert of #93 was reverted; this file rewritten.

The empirical shape of the failure: `raw_response.permission_denials`
contains one entry per attempted bash call, e.g.

```
Bash  -> git commit -am "fix: …"
Bash  -> git add path/to/file
Bash  -> gh --version
Bash  -> php -v
Bash  -> cat some/file
```

## Who does git

- **`git push`** — orchestrator only, all lanes. Prompt forbids the agent
  from pushing.
- **`git commit`** — agent's job. In `patch`, `commitAll()` also runs on
  a dirty worktree as a safety net. In `pr_dialog`, there is no such
  fallback: if the agent doesn't commit the run is recorded as
  `needs_human` (see below).
- **`git rebase`** — orchestrator only, in `conflict_resolve`. The agent
  is told explicitly not to run any git command in that lane.

## Detecting sandbox misconfiguration

`extractDeniedBashCommands(raw)` in `src/engines/claude-code.ts` returns
the list of bash commands the CLI refused to run. `src/lanes/pr-dialog.ts`
inspects it on both the "worktree dirty" and "no commits" branches: if the
denial list contains `git add`/`git commit`/`git rebase`/`git push`, the
lane appends a distinctive `sandbox blocked N bash call(s) — likely
permission-mode misconfiguration` note to the run's `detail` and logs a
`console.warn` line. That way sandbox misconfiguration doesn't look
identical to a legitimate agent pushback, and the operator can spot the
loop before it burns budget.
