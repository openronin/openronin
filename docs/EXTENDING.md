# Extending openronin

How to add custom lanes, providers, engines, and prompt overrides.

## Adding a custom lane

A lane is a function that takes a task + context and produces an outcome. The bones:

```ts
// src/lanes/my-lane.ts
import type { LaneContext, LaneResult } from "./types.js";

export async function runMyLane(ctx: LaneContext): Promise<LaneResult> {
  // ... do work, possibly call vcs / tracker / engine
  return { kind: "ok", message: "did the thing" };
}
```

Then wire it into `pickLane` in [`src/scheduler/worker.ts`](../src/scheduler/worker.ts):

```ts
if (task.kind === "my_kind" && config.lanes.includes("my_lane")) {
  return { lane: "my_lane", run: runMyLane };
}
```

Add `"my_lane"` to the `RepoLaneSchema` enum in [`src/config/schema.ts`](../src/config/schema.ts). Reload — repos can now opt in via `lanes: [my_lane]`.

If the lane uses an engine, define an entry in `engines.defaults`:

```yaml
engines:
  defaults:
    my_lane: { provider: claude_code, model: sonnet }
```

If the lane writes a custom prompt, drop a template in `prompts/templates/my-lane.md` and load it via the prompts registry:

```ts
const tpl = await loadTemplate("my-lane", { repoConfig });
```

The registry handles per-repo overrides automatically — users can put a custom version at `$OPENRONIN_DATA_DIR/prompts/my-lane.md`.

## Adding a VCS provider

Implement the `VcsProvider` interface from [`src/providers/vcs.ts`](../src/providers/vcs.ts). Reference implementations: [`github.ts`](../src/providers/github.ts) (full feature set), [`gitlab.ts`](../src/providers/gitlab.ts).

The interface is large — about 30 methods. Don't be intimidated; only the methods relevant to lanes you actually run need real implementations. Throw `NotImplementedError` for the rest, fix as needed.

Critical methods (you'll hit these no matter what):

```ts
listIssues(opts): Promise<VcsIssue[]>
getIssue(number): Promise<VcsIssue>
postComment(itemNumber, body): Promise<void>
addLabel / removeLabel / listLabels
postReaction
```

For PR-handling lanes (patch, pr_dialog, conflict_resolve):

```ts
openPullRequest(opts): Promise<{ number, url }>
listAllPrFeedback(prNumber): Promise<{ comments, reviewComments, reviews }>
postReplyToReviewComment(prNumber, threadId, body)
resolveReviewThread(threadId)
mergePullRequest(prNumber, strategy)
markReadyForReview(prNumber)
getCombinedStatus(ref): Promise<"green" | "pending" | "failure" | "no_checks">
```

Add the provider to the factory in [`src/providers/index.ts`](../src/providers/index.ts) and update the `provider` enum in `RepoConfigSchema`.

Pitfalls from the existing implementations:

- **Don't trust GitHub's `mergeable` field on first read.** It's computed asynchronously; `null` means "still computing", not "no". Re-fetch after a short delay.
- **`force-with-lease` needs an explicit `<branch>:<sha>` lease** — the bare form fails with `(stale info)` after a single-branch clone. The git helpers in `src/lib/git.ts` handle this; use them.
- **404 on `/pulls/N/reviews` for issues** — issues aren't PRs. Wrap in try/catch with `isNotFound()`.
- **GitHub list APIs lag** by up to a minute for fresh issues. Don't rely on them for sub-minute responsiveness; use webhooks.

## Adding a tracker provider

Smaller interface than VCS. See [`src/providers/tracker.ts`](../src/providers/tracker.ts). Reference: [`jira.ts`](../src/providers/jira.ts), [`todoist.ts`](../src/providers/todoist.ts), [`telegram.ts`](../src/providers/telegram.ts).

A tracker provider is responsible for:

1. **Listing eligible tasks.** Whatever filtering applies (label, project, status).
2. **Fetching task details.** Title, body, assignee, etc.
3. **Posting acknowledgements** (so the user sees that the bot picked up the task).
4. **Marking done** (closing / completing the task on the tracker side).

Trackers can be paired with any VCS provider. The connection is per-repo: in the YAML config, you set `provider: github` (the VCS) and optionally `jira_tracker: { ... }` to pull tasks from Jira instead of GitHub Issues.

## Adding an engine

The `Engine` interface is minimal — see [`src/engines/types.ts`](../src/engines/types.ts):

```ts
interface Engine {
  readonly id: string;
  readonly defaultModel: string;
  run(opts: EngineRunOptions): Promise<EngineResult>;
}
```

Reference implementations:
- [`mimo.ts`](../src/engines/mimo.ts) — OpenAI-compatible HTTP client. Good template for any other OpenAI-API-shaped provider.
- [`claude-code.ts`](../src/engines/claude-code.ts) — spawns the `claude` CLI. Good template for any local-binary engine.
- [`anthropic.ts`](../src/engines/anthropic.ts) — native Anthropic API.
- [`multi-agent.ts`](../src/engines/multi-agent.ts) — orchestrates multiple sub-engines.

Things to handle:

- **Token usage** — populate `usage.tokensIn / tokensOut / costUsd` so the cost dashboard works.
- **Rate limits** — throw `RateLimited` (from `engines/types.ts`) with `resetAt` if the provider tells you when it'll be unblocked. The scheduler catches this and defers retry until then.
- **JSON mode** — if the lane sets `expectJson`, you need to either configure the provider's JSON mode or post-process the output to parse JSON from a fenced code block.

Register the engine in [`src/engines/index.ts`](../src/engines/index.ts) and add the provider name to the engine reference enum in [`src/config/schema.ts`](../src/config/schema.ts).

## Custom prompts

Each lane has a default prompt template under `prompts/templates/`. Users can override per-repo by dropping a file at:

```
$OPENRONIN_DATA_DIR/prompts/<lane>.md
```

Or by setting an explicit override in the per-repo YAML:

```yaml
prompt_overrides:
  patch: my-custom-patch-prompt.md      # path relative to the prompts dir
```

The registry in [`src/prompts/registry.ts`](../src/prompts/registry.ts) handles the lookup chain (per-repo override → user override directory → default template).

Templates are Mustache-ish: `{{variable}}` substitutions, no logic. The variables available depend on the lane — see the lane source for what gets passed in.

## Custom CLI subcommands

CLI subcommands live in [`src/cli/index.ts`](../src/cli/index.ts) as a single dispatch switch. Add a case, implement the function, done. Run via `node dist/index.js <subcommand>`.

If your subcommand is generally useful, send a PR.

## Hot-reload behaviour for extensions

Most extensions need a daemon restart. Hot-reload is supported for:

- YAML config changes (per-repo and global)
- Custom prompt template changes (re-read on each invocation)

NOT supported (require restart):

- Code changes (any `.ts` file)
- New lanes wired into `pickLane`
- New providers added to the factory
- New engines registered

## Testing your extension

Unit tests live in `test/` and use `node --test`. No jest, no vitest.

```ts
// test/my-feature.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { runMyLane } from "../dist/lanes/my-lane.js";

test("my-lane handles the happy path", async () => {
  const result = await runMyLane({ /* mocked context */ });
  assert.equal(result.kind, "ok");
});
```

Run with `pnpm test:unit` (build + run all `test/*.test.mjs`).

For lanes that touch live APIs, gate behind `process.env.OPENRONIN_TEST_LIVE` so they don't run in CI:

```ts
test("integration: hits real GitHub", { skip: !process.env.OPENRONIN_TEST_LIVE }, async () => {
  // ...
});
```

## Submitting your extension upstream

If you've built something generally useful, please open a PR. See [CONTRIBUTING.md](../CONTRIBUTING.md) for the process. Particularly welcome:

- New VCS providers (Gitea, Bitbucket, sourcehut)
- New tracker providers (Linear, Asana, Notion)
- New engine providers (xAI / Grok, OpenAI, local Ollama)
- Lane improvements with clear rationale
