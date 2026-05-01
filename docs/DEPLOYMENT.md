# Production deployment

This is a guide for running openronin as a long-lived service on a Linux box. If you just want to try it locally, see [QUICKSTART.md](../QUICKSTART.md).

## Architecture overview

A typical production setup:

```
   Internet
       │
       ▼
   ┌──────────┐     :80/:443
   │  nginx   │  ◀── TLS terminates here
   └────┬─────┘
        │ proxy_pass to :8090
        ▼
   ┌──────────────┐
   │  openronin   │  ◀── systemd unit, runs as 'openronin' user
   │  (Node 22+)  │
   └──────┬───────┘
          │
          ▼
   /var/lib/openronin/      ← state ($OPENRONIN_DATA_DIR)
       ├── db/openronin.db
       ├── config/
       │   ├── openronin.yaml
       │   └── repos/*.yaml
       ├── work/            ← isolated git worktrees per task
       ├── reports/         ← per-task markdown reports
       ├── prompt-logs/     ← agent prompts + responses
       ├── secrets/         ← ssh keys for deploy lane (mode 600)
       ├── secrets.env      ← env vars (mode 600)
       └── backup/          ← hourly snapshots
```

## Prerequisites

- Linux host (tested on Ubuntu 22.04+, Debian 12+; should work on anything with systemd)
- Node 22+ (recommend [nvm](https://github.com/nvm-sh/nvm) or distro packages)
- pnpm 10+
- nginx (or another reverse proxy) for TLS
- A dedicated user account (`openronin` is conventional)

## 1. System user

```bash
sudo adduser --system --group --home /opt/openronin --shell /bin/bash openronin
sudo mkdir -p /var/lib/openronin
sudo chown -R openronin:openronin /var/lib/openronin
sudo chmod 700 /var/lib/openronin
```

## 2. Code and dependencies

```bash
sudo -iu openronin
cd /opt/openronin
git clone https://github.com/openronin/openronin.git .
pnpm install
pnpm build
exit
```

## 3. Secrets

Create `/var/lib/openronin/secrets.env` (mode 600, owned by `openronin`):

```bash
sudo -u openronin tee /var/lib/openronin/secrets.env > /dev/null <<'EOF'
OPENRONIN_DATA_DIR=/var/lib/openronin
OPENRONIN_PORT=8090
OPENRONIN_BASE_URL=https://openronin.example.com
ADMIN_UI_PASSWORD=change-this-now
OPENRONIN_API_TOKEN=change-this-too
GITHUB_TOKEN=ghp_...
ANTHROPIC_API_KEY=sk-ant-...
XIAOMI_MIMO_API_KEY=tp-...
WEBHOOK_SECRET=change-this-as-well
EOF
sudo chmod 600 /var/lib/openronin/secrets.env
```

Generate the random tokens:

```bash
openssl rand -hex 32   # for ADMIN_UI_PASSWORD, OPENRONIN_API_TOKEN, WEBHOOK_SECRET
```

## 4. Claude Code login

The worker shells out to the `claude` CLI. It needs to be installed and logged in **as the openronin user**:

```bash
# Install per Anthropic's instructions: https://docs.claude.com/en/docs/claude-code
sudo -iu openronin
claude  # one-time interactive login
exit
```

Credentials end up in `~openronin/.claude/.credentials.json`.

## 5. systemd unit

Create `/etc/systemd/system/openronin.service`:

```ini
[Unit]
Description=openronin — autonomous AI developer agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=openronin
Group=openronin
WorkingDirectory=/opt/openronin
EnvironmentFile=/var/lib/openronin/secrets.env
ExecStart=/usr/bin/node /opt/openronin/dist/index.js
Restart=on-failure
RestartSec=5

# CRITICAL for self-deploy: without KillMode=process the cgroup-kill on
# stop will SIGTERM the spawnSync child running 'systemctl restart openronin'
# and the deploy will appear to "succeed but didn't restart".
KillMode=process
TimeoutStopSec=120s

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/var/lib/openronin
PrivateTmp=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
PrivateDevices=true

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now openronin.service
sudo systemctl status openronin
sudo journalctl -u openronin -f
```

## 6. nginx reverse proxy

`/etc/nginx/sites-available/openronin`:

```nginx
server {
    listen 80;
    server_name openronin.example.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name openronin.example.com;

    ssl_certificate /etc/letsencrypt/live/openronin.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/openronin.example.com/privkey.pem;

    # Sane TLS defaults — adjust to your security policy
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    # Webhooks can be large
    client_max_body_size 10m;

    location / {
        proxy_pass http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 90s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/openronin /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

## 7. TLS via Let's Encrypt

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d openronin.example.com
```

## 8. Backups (recommended)

Two systemd timer units ship in [`deploy/`](../deploy/):

- `openronin-backup-hourly.{service,timer}` — hourly local SQLite snapshot to `$OPENRONIN_DATA_DIR/backup/`. Keeps last 24.
- `openronin-backup-daily.{service,timer}` — daily off-host rsync (requires `OPENRONIN_BACKUP_RSYNC_DEST` env var pointing at a remote like `backup@host:/path`).

Install:

```bash
sudo cp /opt/openronin/deploy/openronin-backup-hourly.{service,timer} /etc/systemd/system/
sudo cp /opt/openronin/deploy/openronin-backup-daily.{service,timer} /etc/systemd/system/

# Edit the .service files to match your install path if it differs from /opt/openronin
sudo systemctl daemon-reload
sudo systemctl enable --now openronin-backup-hourly.timer
sudo systemctl enable --now openronin-backup-daily.timer
```

Recover from a backup:

```bash
sudo systemctl stop openronin
sudo -u openronin cp /var/lib/openronin/backup/db-<timestamp>.db \
                    /var/lib/openronin/db/openronin.db
sudo systemctl start openronin
```

## 9. Self-deploy (optional)

To let openronin update its own deployment when you push to `main`:

### sudo rules

`/etc/sudoers.d/openronin-deploy`:

```
openronin ALL=(root) NOPASSWD: /bin/systemctl --no-block restart openronin, /bin/systemctl restart openronin, /bin/systemctl status openronin
```

```bash
sudo chmod 440 /etc/sudoers.d/openronin-deploy
sudo visudo -c   # validate
```

### Per-repo config

In your `$OPENRONIN_DATA_DIR/config/repos/github--<owner>--<repo>.yaml` for the openronin repo itself:

```yaml
deploy:
  mode: local
  trigger_branch: main
  bot_login: openronin-bot       # whatever your bot's GitHub username is
  require_bot_push: true
  commands:
    - cd /opt/openronin && git checkout main && git pull --ff-only
    - cd /opt/openronin && pnpm install --frozen-lockfile
    - cd /opt/openronin && pnpm build
    - sudo /bin/systemctl --no-block restart openronin
```

The `--no-block` is critical: it returns immediately so the current node process can finish responding to the webhook before systemd kills it.

## 10. Hardening checklist

- [ ] `secrets.env` is mode 600
- [ ] `/var/lib/openronin/` is mode 700
- [ ] systemd unit has `NoNewPrivileges`, `ProtectSystem`, etc.
- [ ] nginx terminates TLS; openronin only listens on 127.0.0.1
- [ ] `ADMIN_UI_PASSWORD` and `OPENRONIN_API_TOKEN` are 32+ random bytes
- [ ] `WEBHOOK_SECRET` is set and non-empty
- [ ] GitHub PAT scopes are minimal (`repo` is enough; `admin:repo_hook` only if you want auto-webhook setup)
- [ ] sudoers rules for self-deploy are scoped to the specific systemctl commands
- [ ] Backup destination is on a separate host
- [ ] `cost_caps.per_day_usd` is set to a value you'd be okay losing
- [ ] Webhook deliveries are monitored (GitHub repo settings show recent delivery success/failure)
- [ ] log rotation is configured for `journalctl` (it is by default; just verify you have disk space)

## Common operational tasks

**Restart the service:**
```bash
sudo systemctl restart openronin
```

⚠️  Don't do this while a long task is mid-flight unless you have to. `TimeoutStopSec=120s` gives in-flight tasks 2 minutes to finish gracefully, but very long Claude Code runs may exceed that. The crash-recovery logic on next start will resume the task; after 3 such recoveries on the same task, it auto-abandons.

**Tail logs:**
```bash
sudo journalctl -u openronin -f
sudo journalctl -u openronin --since '5 min ago' --no-pager | tail -50
```

**Quick DB poke:**
```bash
sudo -u openronin sqlite3 /var/lib/openronin/db/openronin.db "select id, status, last_error from tasks where status != 'done' limit 20"
```

**Drop the pause flag** (stops new dispatches; in-flight tasks finish):
```bash
sudo -u openronin touch /var/lib/openronin/.PAUSE
```

Remove to resume:
```bash
sudo -u openronin rm /var/lib/openronin/.PAUSE
```

(Or use the pause toggle in the admin UI header.)
