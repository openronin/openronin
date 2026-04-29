<div align="center">

# 🥷 openronin

**A self-hosted AI developer that turns issues into merged pull requests.**

[Quickstart](#quickstart) · [How it works](#how-it-works) · [Configuration](docs/CONFIG.md) · [Lanes](docs/LANES.md) · [FAQ](#faq)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-22%2B-green.svg)](https://nodejs.org/)
[![Status](https://img.shields.io/badge/Status-alpha-orange.svg)]()

</div>

---

## What it does

You file an issue. You add the `openronin:do-it` label. Sometime later you get a draft PR. If you leave a comment, the agent answers it and pushes a fix-up. When the conversation settles and CI is green, it merges the PR and (optionally) deploys.

There's no console you log into to "drive" it. There's no chat you keep open. It's a daemon that watches your repos and works.

```
                  ┌──── you write an issue ────┐
                  ▼                             │
   ┌──────────────────────────────────┐         │
   │     openronin (your server)      │         │
   │                                  │         │
   │   ┌─────────┐    ┌────────────┐  │         │
   │   │   📋    │    │     🥷     │  │         │
   │   │  MIMO   │───▶│ Claude Code│  │         │
   │   │supervisor│    │   worker   │  │         │
   │   └─────────┘    └─────┬──────┘  │         │
   │                        │         │         │
   └────────────────────────┼─────────┘         │
                            ▼                   │
                  ┌──── opens a PR ────────┐    │
                  │ answers your comments  │────┘
                  │ merges when green      │
                  └────────────────────────┘
```

The split — cheap supervisor, capable worker — keeps cost low while quality stays high. The supervisor classifies, plans, and routes. Only the worker mutates code, and only inside an isolated work-tree.

## Why another one of these

There's a healthy lineup: Aider, Sweep, Cursor, Devin, OpenHands, SWE-agent, Cline. Most are either **interactive** (you sit there and prompt) or **closed SaaS** (someone else's GPU, your code).

`openronin` is what you'd build if you wanted a **persistent, self-hosted, headless** version: a process you start and forget, that picks tasks off your tracker the way a junior dev would pick tickets off a sprint board. You own the server, the database, the prompts, and the model choices.

Specifically:

- **No vendor lock-in.** GitHub today, GitLab and Gitea pluggable. Jira / Todoist / Telegram trackers via the same interface.
- **Two-engine economics.** Cheap LLM does triage and analysis (often >80% of turns by count, ~10% by cost). Expensive coder fires only when it's time to actually write code.
- **PR conversation, not just opening.** It posts threaded review replies, resolves threads, iterates on feedback, handles rebase conflicts.
- **Auto-merge + auto-deploy** are opt-in features, not the whole product.
- **Production-tested at small scale.** The author has been dog-fooding it on this very repo: most of the lanes were merged by the agent itself.

## What you need

- A server (any Linux box, Node 22+, 1 GB RAM is plenty)
- A GitHub account for the bot to push from (separate from your main account is recommended; a Personal Access Token is enough — no GitHub App required)
- A Claude Code login (Max subscription works; the worker shells out to the `claude` CLI)
- An LLM key for the supervisor — defaults to [Xiaomi MIMO](https://hyper.xiaomi.com/) (OpenAI-compatible, very cheap), but anything OpenAI-API-shaped works with minor config

## Quickstart

```bash
git clone https://github.com/openronin/openronin.git
cd openronin
pnpm install
cp .env.example .env
# edit .env — fill in GITHUB_TOKEN, XIAOMI_MIMO_API_KEY, ANTHROPIC_API_KEY
pnpm build
pnpm start
```

Open `http://localhost:8090/admin`, add a repo, and the agent starts watching it.

For a step-by-step including webhook setup, label creation, and "first PR in 5 minutes", see **[QUICKSTART.md](QUICKSTART.md)**.

## How it works

Tasks travel through **lanes**. Each lane has a trigger, an engine, and an output:

| Lane | When it runs | Engine | What it produces |
|---|---|---|---|
| **triage** | new issue or PR | MIMO | classification + labels |
| **analyze** | issue gets `openronin:do-it` | MIMO | clarifying questions OR expanded requirements |
| **patch** | analyze said `ready` | Claude Code | a draft PR |
| **patch_multi** *(opt-in)* | same trigger | Coder + Reviewer | PR with critique loop |
| **pr_dialog** | new comment on agent's PR | Claude Code | threaded reply + fix-up commit |
| **conflict_resolve** *(opt-in)* | mergeable=false | Claude Code | rebased + edited + force-pushed |
| **auto_merge** *(opt-in)* | all replies addressed, CI green | — | squash-merge + close |
| **deploy** *(opt-in)* | push to trigger branch | shell | run configured commands |

The router is a single function (`pickLane` in `src/scheduler/worker.ts`) — there's no opaque agent loop deciding what's next.

For the full lane reference: **[docs/LANES.md](docs/LANES.md)**.

## Highlights

- **Per-repo isolated workers.** A long task in repo A doesn't block repo B. Graceful shutdown waits for in-flight work.
- **Crash recovery.** If the daemon dies mid-task, on restart it resumes (and abandons after 3 recoveries to prevent infinite loops).
- **Cost guardrails.** Hard kill-switches at per-task and per-day USD limits.
- **Rate-limit aware.** Parses Claude Code 429s, sleeps until the reset moment.
- **Pause switch.** Drop a `.PAUSE` file and the scheduler stops dispatching new work. Live tasks finish.
- **Audit log.** Every admin action is logged to a separate table.
- **Backups built in.** Hourly snapshots + daily off-host rsync via systemd timers.
- **Self-deploys itself.** The agent can ship its own changes, including restarting its own systemd unit. (Yes, it bootstraps.)
- **MCP server included.** Expose a read/write subset of the API to any MCP-compatible client (Claude Desktop, IDE plugins, custom assistants).

## Status

**Alpha.** The author has been running it in production on a handful of personal repos. It works. It also has rough edges:

- Documentation is being written in parallel with this release. Some `docs/*.md` placeholders may be terse.
- The admin UI is pragmatic, not pretty. HTMX + Tailwind CDN, server-rendered.
- Tested mainly on GitHub. GitLab provider is implemented but less battle-tested.
- The `init` CLI wizard exists for the basics; some setup steps still need a manual edit.

If something breaks for you, **file an issue** — preferably with the `openronin:do-it` label so the bot can fix itself.

## Project structure

```
src/
├── index.ts          CLI vs server entry point
├── server/           Hono HTTP — admin UI, webhooks, JSON API
├── supervisor/       MIMO router + cost tracking
├── engines/          MIMO, Claude Code, Anthropic, multi-agent
├── providers/        VCS (github, gitlab) + Tracker (jira, todoist, telegram)
├── lanes/            triage, analyze, patch, pr-dialog, conflict-resolve, deploy, …
├── scheduler/        per-repo workers, queue, reconcile, drain
├── storage/          SQLite (better-sqlite3)
├── prompts/          Prompt templates with per-repo override
├── config/           Zod schema + YAML loader with hot-reload
├── lib/              git helpers, time parsing, pause flag
├── mcp/              stdio MCP server
└── cli/              CLI subcommands
```

## Roadmap

- [ ] L6 multi-agent expansion: dedicated reviewer, planner, fixer roles
- [ ] GitHub App migration (replace PAT with GitHub App for higher-throughput repos)
- [ ] First-class Gitea support
- [ ] Web dashboard polish (replacing or layering over the current admin UI)
- [ ] Plugin system for custom lanes

Have something to add? Open an issue or a PR. Or, if you're feeling reckless, label your issue `openronin:do-it` and let the bot have a crack.

## FAQ

**Is this a GitHub App?** No, it's a self-hosted daemon you run on your own server. It uses a Personal Access Token to push as the bot user. A GitHub App version is on the roadmap.

**Does it call OpenAI?** No, not by default. Supervisor uses Xiaomi MIMO (OpenAI-compatible API), worker uses Claude Code. You can swap either.

**Can I review before it merges?** Yes — auto-merge is opt-in per repo. With it off, the agent opens the PR, iterates on your comments, and waits for *you* to merge.

**Does it work for non-trivial features?** It's reliable for clear, well-scoped tasks (bug fixes, small additions, refactors). Vague or research-heavy tasks it'll either ask for clarification or punt to a `needs_human` state.

**What happens if it screws up?** Branch protection still applies. CI still runs. Auto-merge requires checks to pass. Worst case: a draft PR sits open with broken code that never gets merged. You see it, you close it, you file a better issue.

**Is the bot itself written by AI?** Substantially, yes. Most lanes after the bootstrap were merged via the bot's own pipeline.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The fastest contribution path: file an issue describing what's wrong or missing. If you want to write code yourself, run the lint/test/format check before pushing:

```bash
pnpm run check
```

## License

[MIT](LICENSE)
