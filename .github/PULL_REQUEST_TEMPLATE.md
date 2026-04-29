<!-- Thanks for contributing! A few quick checks before you click submit: -->

## What this changes

<!-- One or two sentences. Why, not just what. -->

## How to test

<!-- The reviewer's path through this PR. Include commands, sample input, expected output. -->

## Checklist

- [ ] `pnpm run check` passes locally (build + lint + tests + format)
- [ ] Tests added or updated for the behaviour I changed
- [ ] If I touched the SQLite schema, I added a numbered migration in `src/storage/db.ts`
- [ ] If I added a YAML config field, I updated the Zod schema and `config/openronin.example.yaml`
- [ ] If I changed user-visible behaviour, I updated the relevant `docs/*.md`
- [ ] I updated the `[Unreleased]` section in `CHANGELOG.md`

## Related issues

<!-- Closes #N -->
