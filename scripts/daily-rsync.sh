#!/usr/bin/env bash
# Daily rsync backup of $OPENRONIN_DATA_DIR to a remote destination.
# Excludes work-trees/ and secrets.env.
# Retains 30 daily snapshots; older ones are pruned automatically.
#
# Required env:
#   OPENRONIN_BACKUP_RSYNC_DEST  — rsync-compatible destination, e.g.
#                               backup@remote:/mnt/backups/openronin
#                               s3://my-bucket/openronin  (via rclone mount)
# Optional env:
#   OPENRONIN_DATA_DIR           — defaults to /var/lib/openronin

set -euo pipefail

OPENRONIN_DATA_DIR="${OPENRONIN_DATA_DIR:-/var/lib/openronin}"
OPENRONIN_BACKUP_RSYNC_DEST="${OPENRONIN_BACKUP_RSYNC_DEST:-}"

if [[ -z "$OPENRONIN_BACKUP_RSYNC_DEST" ]]; then
  echo "[backup-daily] OPENRONIN_BACKUP_RSYNC_DEST is not configured — skipping" >&2
  exit 0
fi

DATE="$(date +%Y-%m-%d)"
DEST="${OPENRONIN_BACKUP_RSYNC_DEST}/daily/${DATE}"

echo "[backup-daily] syncing ${OPENRONIN_DATA_DIR}/ → ${DEST}"

rsync -az --delete \
  --exclude="work-trees/" \
  --exclude="secrets.env" \
  "${OPENRONIN_DATA_DIR}/" "${DEST}/"

echo "[backup-daily] done"

# Retention: prune daily dirs older than 30 days on the same destination host.
# Only works when DEST is a local or SSH path; skip silently for S3-style.
DEST_HOST=""
DEST_PATH=""
if [[ "$OPENRONIN_BACKUP_RSYNC_DEST" == *:* ]]; then
  DEST_HOST="${OPENRONIN_BACKUP_RSYNC_DEST%%:*}:"
  DEST_PATH="${OPENRONIN_BACKUP_RSYNC_DEST#*:}"
else
  DEST_PATH="$OPENRONIN_BACKUP_RSYNC_DEST"
fi

PRUNE_CMD="find \"${DEST_PATH}/daily\" -maxdepth 1 -type d -mtime +30 -exec rm -rf {} + 2>/dev/null || true"

if [[ -n "$DEST_HOST" ]]; then
  # Remote host — run cleanup via SSH (host extracted without trailing colon)
  SSH_HOST="${DEST_HOST%:}"
  ssh "$SSH_HOST" "$PRUNE_CMD" || true
else
  eval "$PRUNE_CMD"
fi

echo "[backup-daily] retention cleanup done"
