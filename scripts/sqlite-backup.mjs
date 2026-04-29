#!/usr/bin/env node
/**
 * Hourly SQLite online backup using better-sqlite3 db.backup() API.
 * Retains backups for 24 hours, then removes them.
 *
 * Usage: node scripts/sqlite-backup.mjs
 * Env:   OPENRONIN_DATA_DIR  (default: /var/lib/openronin)
 */

import { createRequire } from "node:module";
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const dataDir = process.env.OPENRONIN_DATA_DIR ?? "/var/lib/openronin";
const dbPath = resolve(dataDir, "db", "openronin.db");
const backupDir = resolve(dataDir, "backup");

mkdirSync(backupDir, { recursive: true });

const timestamp = new Date()
  .toISOString()
  .replace(/T/, "_")
  .replace(/:/g, "-")
  .slice(0, 19);
const destPath = join(backupDir, `db-${timestamp}.db`);

const db = new Database(dbPath, { readonly: true });
await db.backup(destPath);
db.close();

console.log(`[backup] SQLite snapshot written: ${destPath}`);

// Retention: remove hourly backups older than 24 hours
const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;
let removed = 0;
for (const file of readdirSync(backupDir)) {
  if (!/^db-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.db$/.test(file)) continue;
  const fp = join(backupDir, file);
  if (statSync(fp).mtimeMs < cutoffMs) {
    unlinkSync(fp);
    removed++;
  }
}
if (removed > 0) {
  console.log(`[backup] pruned ${removed} expired hourly backup(s)`);
}
