# Contributing to openronin

Thanks for considering a contribution. This is a small project with one author so far — your input genuinely matters.

## The fastest contribution

**File an issue.** Even if you can't fix it yourself, a clear bug report or use-case description is hugely valuable. The bot itself can sometimes pick up well-scoped issues if you label them `openronin:do-it` — feel free to try.

## Before you write code

For anything beyond a small bug fix or doc change, please open an issue first to discuss. This avoids the bad outcome where you spend a weekend on a feature that doesn't fit the project's direction.

Especially worth discussing first:
- New lanes
- Changes to the lane router or scheduler
- New providers (VCS or tracker)
- Changes to the config schema (these are migration-sensitive)
- Anything that touches the security boundary (token handling, webhook signature verification, agent prompt injection surfaces)

## Development setup

```bash
git clone https://github.com/openronin/openronin.git
cd openronin
pnpm install
cp .env.example .env
# Edit .env — at minimum you need GITHUB_TOKEN and one supervisor LLM key
# to actually exercise lanes. For pure unit tests you can skip them.
pnpm build
pnpm test:unit
```

For integration tests (which exercise live API calls):

```bash
pnpm test:integration
```

## Before you push

```bash
pnpm run check
```

Runs build + lint + unit tests + format check, in that order. CI runs the same — if it passes locally, it passes on CI.

If `format:check` fails:

```bash
pnpm run format
```

`oxfmt` rewrites the files in place; commit the result.

## Code style

- **TypeScript strict.** No `any` unless there's a specific reason.
- **No `console.log` in committed code.** Use the structured logger or remove the line.
- **Prefer functions over classes** unless state is genuinely needed.
- **Module size.** When a file approaches ~500 lines, split it. The admin UI (`src/server/admin.ts`) is currently the worst offender and an open refactor target.
- **No new ORM / framework / runtime dependencies** without discussing first. The dep list is intentionally short.
- **Comments explain why, not what.** The diff already shows what.

## Lint and format

- **Lint:** `oxlint` — fast, opinionated. Configured via the project's `oxlint.json` if present.
- **Format:** `oxfmt`. **Do not reintroduce Prettier or ESLint.**
- **Tests:** built-in `node --test`. **Do not introduce vitest, jest, etc.**

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(lane): add patch-multi reviewer iteration cap
fix(scheduler): release per-repo busy flag on engine timeout
docs(quickstart): clarify webhook setup for non-admin bots
chore(deps): bump @octokit/rest to 21.x
```

Type prefixes used in this repo: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `style`, `perf`.

## Pull request checklist

- [ ] `pnpm run check` passes locally
- [ ] Tests added / updated for the behaviour you changed
- [ ] Schema migration added if you touched the SQLite schema
- [ ] Config schema (Zod) updated if you added a YAML field
- [ ] Documentation updated if you changed behaviour the user sees
- [ ] CHANGELOG.md `[Unreleased]` section updated

## What about using the bot to write the bot?

The author has been doing exactly that — most lanes after the bootstrap landed via the bot's own `patch` lane. If you want to try it on your own clone, that's fine. Some advice:

- Land the change as a normal PR with you as the reviewer; don't `auto_merge` agent-authored changes to the main project without review.
- Be especially suspicious of changes the agent makes to: the lane router, the prompt templates, the engine cost calculations, any security boundary.

## Reporting security issues

Please **do not** open a public issue for security vulnerabilities. See [SECURITY.md](SECURITY.md) for the disclosure path.

## Code of conduct

Be decent. The project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
