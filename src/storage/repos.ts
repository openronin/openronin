import type { Db } from "./db.js";
import type { RepoConfig } from "../config/schema.js";
import { repoKey } from "../config/schema.js";

export interface RepoRow {
  id: number;
  provider: string;
  owner: string;
  name: string;
  watched: number;
  hidden: number;
  config_json: string;
  created_at: string;
}

// Sync the YAML-defined repos into the SQLite cache. Repos in DB but not in YAML
// are marked unwatched (watched=0) so they keep history but don't get scanned.
// `hidden` mirrors the same-named YAML field; a hidden repo is invisible in
// the main UI and inert everywhere (scheduler/webhooks/Director all skip it).
export function syncReposFromConfig(db: Db, repos: RepoConfig[]): void {
  const upsert = db.prepare<[string, string, string, number, number, string]>(`
    INSERT INTO repos (provider, owner, name, watched, hidden, config_json)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, owner, name) DO UPDATE SET
      watched = excluded.watched,
      hidden = excluded.hidden,
      config_json = excluded.config_json
  `);
  const seen = new Set<string>();
  const tx = db.transaction((items: RepoConfig[]) => {
    for (const repo of items) {
      seen.add(repoKey(repo));
      upsert.run(
        repo.provider,
        repo.owner,
        repo.name,
        repo.watched ? 1 : 0,
        repo.hidden ? 1 : 0,
        JSON.stringify(repo),
      );
    }
    const all = db
      .prepare("SELECT provider, owner, name FROM repos WHERE watched = 1")
      .all() as Array<Pick<RepoRow, "provider" | "owner" | "name">>;
    const unwatch = db.prepare(
      "UPDATE repos SET watched = 0 WHERE provider = ? AND owner = ? AND name = ?",
    );
    for (const row of all) {
      if (!seen.has(`${row.provider}--${row.owner}--${row.name}`)) {
        unwatch.run(row.provider, row.owner, row.name);
      }
    }
  });
  tx(repos);
}

// listRepos default excludes hidden repos so the main UI never has to
// filter them out by hand. Use `hiddenOnly` to fetch only hidden ones
// (Settings → Hidden page), or `includeHidden` to fetch both.
export function listRepos(
  db: Db,
  opts: { watchedOnly?: boolean; hiddenOnly?: boolean; includeHidden?: boolean } = {},
): RepoRow[] {
  const where: string[] = [];
  if (opts.watchedOnly) where.push("watched = 1");
  if (opts.hiddenOnly) where.push("hidden = 1");
  else if (!opts.includeHidden) where.push("hidden = 0");
  const clause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
  return db
    .prepare(`SELECT * FROM repos${clause} ORDER BY provider, owner, name`)
    .all() as RepoRow[];
}
