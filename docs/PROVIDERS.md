# Providers

openronin treats VCS hosts and task trackers as plug-in providers. The same lane code works regardless of whether the underlying repo lives on GitHub or GitLab, and regardless of whether tasks come from GitHub Issues, Jira, Todoist, or Telegram.

This page describes the providers that ship today and how to wire each one up.

---

## VCS providers

A `VcsProvider` (interface in [`src/providers/vcs.ts`](../src/providers/vcs.ts)) handles: listing issues/PRs, posting comments, adding/removing labels, posting reactions, opening PRs, posting threaded review replies, resolving threads, fetching CI status, merging PRs, and force-pushing branches.

### GitHub *(full implementation)*

The reference implementation. All lanes work with full fidelity.

**What you need:**

1. **A bot GitHub account.** Recommended (rather than reusing your personal account).
2. **A Personal Access Token** for that account, with scopes:
   - `repo` — required for any repo work
   - `workflow` — only if your repos have GitHub Actions and you want the agent to be able to edit workflow files (which is dangerous; consider keeping workflows in `protected_paths`)
   - `admin:repo_hook` — only if you want openronin to auto-create webhooks via API. Without it, you set webhooks manually (the admin UI provides copy-paste info).
3. **Collaborator access** (Write or higher) on each repo you want the bot to touch.

**Configuration:** set `GITHUB_TOKEN` env var. That's it for global setup. Per repo: provider field is `github` (the default), owner/name as usual.

**Webhook setup:** see [QUICKSTART.md §7](../QUICKSTART.md#7-set-up-the-webhook).

### GitLab *(full implementation, less battle-tested)*

Implemented but the author runs all live workloads on GitHub. If you find issues, please file them.

**What you need:**

1. **A GitLab account** for the bot (cloud or self-hosted).
2. **A personal access token** with scopes: `api`, `read_repository`, `write_repository`. For self-hosted, the token is per-instance.
3. **Maintainer access** (or higher) on the projects you want to watch.

**Configuration:**
```bash
GITLAB_TOKEN=glpat-...
GITLAB_HOST=https://gitlab.example.com   # default https://gitlab.com
```

Per-repo YAML:
```yaml
provider: gitlab
owner: my-group/my-subgroup     # path to the project (no trailing project name)
name: my-project
```

**Webhook setup:** GitLab's webhook UI is at *Project → Settings → Webhooks*. Use the same payload URL pattern as GitHub but with `/webhooks/gitlab/<repo-id>`. The admin UI's webhook info panel generates the right URL.

### Gitea *(not implemented)*

The interface is ready; just no implementation yet. Contributions welcome.

---

## Task trackers

A `TrackerProvider` (interface in [`src/providers/tracker.ts`](../src/providers/tracker.ts)) handles: listing tasks, fetching task details, posting acknowledgements, marking tasks done. Trackers are **separate** from VCS providers — you can have tasks come from Jira but PRs go to GitHub, for example.

### GitHub Issues *(default)*

Tasks are GitHub issues on the same repo as the PR target. No extra setup beyond the GitHub provider.

### Jira *(optional)*

Useful if your team manages tasks in Jira and the PRs go to GitHub.

**What you need:**

1. **A Jira API token** for the bot user — from https://id.atlassian.com/manage-profile/security/api-tokens (cloud) or your admin (self-hosted).
2. **The base URL** of your Jira instance (e.g. `https://acme.atlassian.net`).
3. **A project key** (the all-caps prefix in issue keys, e.g. `PROJ` for PROJ-123).
4. *(Optional)* **A label** to mark which Jira tickets the bot should pick up — e.g. `ai-eligible`. Without one, the bot picks up everything in the project.
5. *(Optional)* **A webhook secret** for incoming Jira webhooks.

**Configuration:**

Global env:
```bash
JIRA_TOKEN=...
```

Per-repo YAML:
```yaml
jira_tracker:
  base_url: https://acme.atlassian.net
  project_key: PROJ
  label_filter: ai-eligible            # optional
  webhook_secret: random-string        # optional
```

The bot now polls Jira for issues matching the filter (and listens for webhooks if you've set one up). When it picks up a Jira ticket, it creates a synthetic task in openronin's DB linked to the Jira issue key, and works against the configured GitHub repo for the actual PR.

**Jira webhook setup:** *Jira admin → System → Webhooks → Create webhook*. URL: `https://your-openronin/webhooks/jira/<repo-id>`. Events: issue created, updated, commented.

### Todoist *(optional)*

Lightweight task source for personal use.

**What you need:**

1. **A Todoist API token** — from https://todoist.com/app/settings/integrations/developer.
2. **A project ID** — find it in the URL when you view the project (`https://todoist.com/app/project/1234567890` → ID is `1234567890`).
3. *(Optional)* **A label** to filter (e.g. `code`).

**Configuration:**

Global env:
```bash
TODOIST_TOKEN=...
```

Per-repo YAML:
```yaml
todoist_tracker:
  project_id: "1234567890"
  label_filter: code           # optional
  webhook_secret: random       # optional
```

Todoist tasks become openronin tasks; when the agent posts an acknowledgement, it appears as a comment on the Todoist task.

### Telegram *(optional)*

The Telegram bot is for **task ingestion only** (you DM the bot a task description, it creates a task) — not for general bot↔Telegram chat. The actual code work and PR review still happen on GitHub.

**What you need:**

1. **A Telegram bot** — create one via [@BotFather](https://t.me/BotFather), get the token.
2. **The Telegram user IDs** allowed to send tasks. Get yours by messaging [@userinfobot](https://t.me/userinfobot).

**Configuration:**

Global env:
```bash
TELEGRAM_BOT_TOKEN=12345:abcdef...
```

Global YAML:
```yaml
telegram:
  allowed_user_ids: [123456789]      # YOUR Telegram user ID, NOT a chat ID
  poll_timeout_seconds: 30
```

How it works: openronin long-polls the Telegram Bot API. When you DM the bot, it parses the message (using the task-parser in [`src/lib/task-parser.ts`](../src/lib/task-parser.ts) to extract repo + title + body) and creates a task in the configured repo.

Message format the parser understands:
```
acme/widgets: add --version flag to CLI

Body of the task. Multi-line is fine.

Constraints:
- no new deps
- add a test
```

The first line is `<owner>/<repo>: <title>`. The rest is the body. The repo must already be watched in the admin UI.

---

## Provider abstraction in code

If you're hacking on lanes, you'll see this pattern everywhere:

```ts
import type { VcsProvider } from "../providers/vcs.js";
import type { TrackerProvider } from "../providers/tracker.js";

export async function runMyLane(opts: {
  vcs: VcsProvider;
  tracker: TrackerProvider;
  // ...
}) {
  const issue = await opts.vcs.getIssue(...);
  await opts.vcs.postComment(...);
  await opts.tracker.acknowledge(...);
}
```

Lanes never import `@octokit/*` directly. The `VcsProvider` interface is the contract.

For adding new providers, see [EXTENDING.md](EXTENDING.md).
