# Quickstart

This walks you through getting your first agent-merged PR in about 15 minutes. Skip ahead if a section doesn't apply.

## 1. Prerequisites

- **Node 22+** and **pnpm 10+** on the host
- **A GitHub account for the bot.** Strongly recommended to create a dedicated account (e.g. `myorg-bot`) rather than reusing your personal one. Add it as a collaborator with **Write** access to repos you want it to touch.
- **A Claude Code login.** Install the [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) and run `claude` once to log in. A Max subscription is recommended; pay-as-you-go works too.
- **A supervisor LLM.** The default is [Xiaomi MIMO](https://hyper.xiaomi.com/) — sign up, generate a token. Costs are usually a few cents per task.

## 2. Install

```bash
git clone https://github.com/openronin/openronin.git
cd openronin
pnpm install
pnpm build
```

## 3. Configure

```bash
cp .env.example .env
```

Edit `.env` and fill in at minimum:

```bash
GITHUB_TOKEN=ghp_...                    # PAT for the bot account
ANTHROPIC_API_KEY=sk-ant-...            # for the multi-agent reviewer (optional)
XIAOMI_MIMO_API_KEY=tp-...              # supervisor
ADMIN_UI_PASSWORD=pick-a-password       # for /admin/* basic auth
OPENRONIN_API_TOKEN=$(openssl rand -hex 32)
```

Generate the bot's noreply email or pick a custom one:

```bash
OPENRONIN_BOT_GIT_NAME=mybot
OPENRONIN_BOT_GIT_EMAIL=mybot@users.noreply.github.com
```

## 4. Start the daemon

```bash
pnpm start
```

Open `http://localhost:8090/admin` in a browser. Sign in with `admin` / your `ADMIN_UI_PASSWORD`.

For production: see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for systemd unit + nginx reverse-proxy + backups.

## 5. Connect a repo

In the admin UI, click **Add repo**. Enter `owner` and `name` (e.g. `acme/widgets`).

Two things happen automatically:

1. A SQLite row is created and the scheduler begins polling the repo on the configured cadence.
2. A YAML config file is generated at `$OPENRONIN_DATA_DIR/config/repos/github--acme--widgets.yaml`. Edit it to enable lanes, change models, set protected paths, etc. — see [docs/CONFIG.md](docs/CONFIG.md) for the full schema.

The minimum config to start:

```yaml
provider: github
owner: acme
name: widgets
watched: true
lanes: [triage, analyze, patch, pr_dialog]
patch_default_base: main
language_for_communication: English
```

## 6. Set up the labels

The agent uses four labels on issues/PRs to coordinate with you:

| Label | Meaning |
|---|---|
| `openronin:do-it` | You're asking the bot to actually implement this issue (only `triage`-only repos can omit). |
| `openronin:in-progress` | Bot has picked up the task. |
| `openronin:awaiting-answer` | Bot asked clarifying questions, waiting for your reply. |
| `openronin:awaiting-action` | Bot finished what it could; needs you to do something. |

The admin UI has a **Labels** panel that creates these for you in one click (requires `repo` PAT scope; if your bot only has Write, copy-paste the names manually).

## 7. Set up the webhook

Required for the bot to react to issue comments and PR feedback in real time (without it, you're stuck waiting for the polling cadence — up to an hour by default).

In the admin UI's repo page, click **Webhook info**. Copy the **Payload URL** and **Secret**, then paste them into:

GitHub repo → Settings → Webhooks → Add webhook
- **Payload URL:** the one shown
- **Content type:** `application/json`
- **Secret:** the one shown
- **Events:** Issues, Issue comments, Pull requests, Pull request reviews, Pull request review comments, Pushes (the admin UI shows the exact list)

If your bot has `admin:repo_hook` scope on its PAT, the **Auto-create webhook** button does this for you.

## 8. Try your first task

In your repo, open an issue. Make it specific:

> **Title:** Add a `--version` flag to the CLI
>
> **Body:** When the user runs `mycli --version`, print the package version and exit 0. Read it from package.json. No new dependencies. Add a test.

Apply the **`openronin:do-it`** label.

What happens next:

1. Within ~30 seconds, the **analyze lane** runs (MIMO reads the issue + thread context).
2. If the requirements are clear, it transitions to the **patch lane**: `openronin:in-progress` label appears, then the agent clones the repo, writes code in an isolated worktree, commits, pushes a branch, opens a draft PR.
3. You comment on the PR. The **pr_dialog lane** picks up the comment, replies in-thread, pushes a fix-up commit.
4. (Optional) Mark the PR ready for review and merge it yourself, OR enable `auto_merge` in the repo config and let the bot do it once CI is green.

If the analyze lane has questions, you'll see them on the issue with the `openronin:awaiting-answer` label. Reply to clear it.

## 9. Pause / resume

Drop a `.PAUSE` file in `$OPENRONIN_DATA_DIR` (or click the pause toggle in the admin header). The scheduler stops dispatching new work. In-flight tasks finish normally. Remove the file (or click again) to resume.

## 10. Where to go from here

- **[docs/CONFIG.md](docs/CONFIG.md)** — every YAML field explained
- **[docs/LANES.md](docs/LANES.md)** — what each lane does and when
- **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** — production setup
- **[docs/PROVIDERS.md](docs/PROVIDERS.md)** — wiring up GitLab, Jira, Todoist, Telegram
- **[docs/EXTENDING.md](docs/EXTENDING.md)** — adding your own lanes, providers, or engines

## Troubleshooting

**"The agent doesn't react to my comments."** Check the webhook delivery log on GitHub (Settings → Webhooks → Recent Deliveries). Most failures are signature mismatch (wrong secret) or the bot's filter dropping the message because it doesn't recognize you as a non-bot author.

**"It opened a PR with bad code."** Look at the per-task drill-down in the admin UI for that task. You'll see the prompt, the model output, and the diff. File an issue with that info.

**"It keeps re-asking the same questions."** Make sure the `openronin:awaiting-answer` label is actually being removed when you reply. The bot watches for non-bot comments after the question was asked; if your reply got filtered (e.g. it starts with the bot prefix by accident), it'll keep waiting.

**"My PAT got rate-limited."** Click **Clear rate-limit** in the admin UI. The bot will retry after the reset window the API surfaced.
