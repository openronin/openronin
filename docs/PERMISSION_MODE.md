# Claude Code permission-mode: acceptEdits vs bypassPermissions

Investigation for issue #94.

## TL;DR

**The orchestrator owns all `git push` operations.** `git commit` is nominally the agent's job (the prompt says so), but the patch lane has an explicit `commitAll` fallback that commits any edits the agent left behind. As a result, the architecture is resilient whether or not `acceptEdits` allows bash in `--print` mode. No permission-mode change is required for the current functionality.

---

## How claude_code is spawned

`src/engines/claude-code.ts:40-48` — every run of the `claude_code` engine passes:

```
claude --print --model <model> --output-format json --permission-mode <mode>
```

The `<mode>` comes from `mapPermission` (line 162-170):

| `tools` policy | `--permission-mode` |
|---|---|
| `read-only` | `default` |
| `read-write` | `acceptEdits` |
| `git-write` | `acceptEdits` |

**All code-mutating lanes use `git-write` → `acceptEdits`:**
- patch lane: `tools: "git-write"` (`src/lanes/patch.ts:218`)
- pr_dialog lane: `tools: "git-write"` (`src/lanes/pr-dialog.ts:222`)
- conflict_resolve lane: `tools: "git-write"` (`src/lanes/conflict-resolve.ts:195`)

---

## What `acceptEdits` means

From the Claude Code documentation:

| Capability | `default` | `acceptEdits` | `bypassPermissions` |
|---|---|---|---|
| Read files | auto-approved | auto-approved | auto-approved |
| Edit files | requires approval | **auto-approved** | auto-approved |
| Bash commands | requires approval | requires approval | auto-approved |

In interactive mode, `acceptEdits` still prompts the user before running bash commands.

### Behaviour in `--print` (non-interactive) mode

This is the critical nuance. When there is no interactive terminal, "requires approval" cannot pause for a human. Observed behaviour (confirmed by this investigation running as the agent):

- File edits: ✅ work without prompting (as expected)
- Bash commands: ✅ **also work** — in `--print` mode the approval gate is bypassed because there is no interactive session. The permission mode's primary effect in headless runs is that file edits are pre-approved; bash is not gated differently than it would be under `bypassPermissions`.

This means the patch-task prompt's instruction "run tests / lint before committing" is technically reachable. The agent CAN invoke `pnpm run check` and `git commit` inside a `--print` run.

---

## Who does git — agent or orchestrator?

### `git push` — always the orchestrator

No lane prompt asks the agent to push. All three lanes instruct explicitly:

- patch-task template (line 20): *"Implement the change and commit. **Do not push** and do not open a PR — that is handled after you exit."*
- pr-dialog template: *"do not push."*
- conflict-resolve template: *"Do NOT commit, do NOT run `git rebase --continue`, do NOT run any git command."*

The orchestrator performs the push after validating the agent's output:
- `src/lanes/patch.ts:363` — `pushBranchWithToken(...)`
- `src/lanes/pr-dialog.ts:336` — same

### `git commit` — agent's job, orchestrator has a fallback

The system prompt injected by `patch.ts:209` tells the agent: *"Make minimal, correct changes and commit when done."* The agent is expected to commit.

However, `patch.ts:251-269` covers the case where the agent edits files but does not commit them:

```typescript
// Worktree dirty — agent forgot to commit some edits.
await commitAll(workdir, "[openronin] include leftover edits from previous step");
```

This fallback runs if `diffStats.hasChanges` is true after the agent exits. It is intentional insurance, not the primary path.

### `git rebase` operations — orchestrator only

In `conflict_resolve`, the agent is explicitly told to resolve markers in files only. The orchestrator drives `git rebase --continue` and force-pushes (`src/lanes/conflict-resolve.ts:239-264`).

---

## Is `acceptEdits` sufficient?

**Yes, for the current architecture.** Here is why:

1. **Push is always the orchestrator's job.** No matter what permission mode is used, the agent cannot push — the prompt forbids it and the orchestrator does it unconditionally after the agent exits.

2. **Commit succeeds in `--print` mode.** In a headless run, `acceptEdits` does not block bash; the agent can and should `git add` + `git commit` as instructed.

3. **Fallback covers agent omissions.** If the agent forgets to commit (e.g. due to context length or a guardrail), `commitAll` catches it. If the agent commits protected-path files, the lane's guardrail check rejects the run before push.

4. **No `bypassPermissions` risk exists in interactive mode.** Because openronin always invokes with `--print`, there is no human session for `bypassPermissions` to skip approvals on.

### When would `bypassPermissions` be preferable?

Only if a future use case requires the agent to perform operations that `acceptEdits` genuinely blocks in interactive mode, and the agent is sometimes invoked interactively (e.g. via `claude code` in a terminal). For the headless `--print` path that openronin uses, there is no functional difference.

---

## Conclusion

| Question | Answer |
|---|---|
| Who does `git push`? | Orchestrator, always |
| Who does `git commit`? | Agent (primary path); orchestrator `commitAll` (fallback) |
| Who does `git add` in conflict resolution? | Orchestrator |
| Does `acceptEdits` block bash in `--print` mode? | No — bash works in headless runs |
| Is `acceptEdits` sufficient? | Yes |
| Is a change to `bypassPermissions` needed? | No |

The `read-write` and `git-write` policies both map to `acceptEdits` intentionally — `git-write` is a semantic label meaning "the agent is expected to touch files and commit", not a signal that additional bash permissions are needed beyond what `acceptEdits` already provides in `--print` mode.
