# Security policy

## Reporting a vulnerability

**Please do not file public issues for security vulnerabilities.**

Instead, report privately via [GitHub's Security Advisory feature](https://github.com/openronin/openronin/security/advisories/new).

If that's not available to you, open a regular issue saying *"I'd like to report a security issue privately, please get in touch"* without including details, and the maintainer will reach out via a private channel.

## What's in scope

This is a self-hosted agent that holds privileged credentials (PATs, ssh keys, LLM API keys) and can push code to repos. The interesting attack surfaces:

- **Webhook handlers** (`src/server/webhooks.ts`). Signature verification, payload parsing, denial of service via huge payloads.
- **Agent prompt injection.** A malicious issue body / PR comment could try to manipulate the agent into doing something unintended (exfiltrating secrets, modifying out-of-scope files, posting on behalf of the user). Mitigations include `protected_paths`, diff-line caps, and the worker running in a worktree without ambient credentials beyond the GitHub token.
- **Token handling.** The redaction in `scrubSecrets()` is a defence in depth; the primary protection is that tokens never appear in committed code or persisted prompts.
- **Admin API.** Authenticated by basic-auth (`/admin/*`) or bearer token (`/api/*`). A weak `ADMIN_UI_PASSWORD` is your problem, but bypasses of the auth itself are in scope.
- **Deploy lane (`src/lanes/deploy.ts`).** Executes shell commands on the host (or via SSH on a remote target) when triggered by a webhook. The trigger requires the pusher to match `bot_login` by default, but creative spoofing paths are in scope.
- **SQL injection.** All DB access goes through prepared statements, but report any place that interpolates user-supplied data into SQL.
- **Path traversal** in any of the file-writing code paths (work-tree management, prompt logs, reports).

## What's not in scope

- Findings from vulnerability scanners with no demonstrated impact
- Issues that require an attacker to already have admin access to the openronin instance
- DoS via spending cost budget — the cost caps are the mitigation; tune them
- Brute force against `ADMIN_UI_PASSWORD` if you set it to something weak
- Anything in the bot's code reviews / suggestions that's wrong but not exploitable

## Disclosure timeline

The author aims to acknowledge reports within 7 days, ship a fix or mitigation within 30 days for high-severity issues, and credit reporters in the release notes (unless you'd prefer to stay anonymous).

## Hardening checklist for operators

If you're running openronin in production:

- [ ] `OPENRONIN_DATA_DIR` is on a partition with restrictive permissions (mode 700, owned by the service user)
- [ ] `secrets.env` is mode 600
- [ ] The bot's GitHub PAT has the minimum scopes needed (`repo` is usually enough; `admin:repo_hook` only if you want auto-webhook-setup)
- [ ] The systemd service runs as a non-root user with no shell login
- [ ] `sudo` rules for self-deploy (if used) are scoped to the specific systemctl commands needed
- [ ] The admin UI is behind nginx (or similar) with TLS terminated at the proxy
- [ ] Webhooks use a strong `WEBHOOK_SECRET` and HMAC verification is enabled
- [ ] Backup destination (`OPENRONIN_BACKUP_RSYNC_DEST`) is on a separate host
- [ ] `cost_caps.per_day_usd` is set to a value you'd be okay losing if the agent went rogue
