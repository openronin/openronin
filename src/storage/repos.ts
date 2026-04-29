import type { Db } from "./db.js";
import type { RepoConfig } from "../config/schema.js";
import { repoKey } from "../config/schema.js";

export interface RepoRow {
  id: number;
  provider: string;
  owner: string;
  name: string;
  watched: number;
  config_json: string;
  created_at: string;
}

// Sync the YAML-defined repos into the SQLite cache. Repos in DB but not in YAML
// are marked unwatched (watched=0) so they keep history but don't get scanned.
export function syncReposFromConfig(db: Db, repos: RepoConfig[]): void {
  const upsert = db.prepare<[string, string, string, number, string]>(`
    INSERT INTO repos (provider, owner, name, watched, config_json)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(provider, owner, name) DO UPDATE SET
      watched = excluded.watched,
      config_json = excluded.config_json
  `);
  const seen = new Set<string>();
  const tx = db.transaction((items: RepoConfig[]) => {
    for (const repo of items) {
      seen.add(repoKey(repo));
      upsert.run(repo.provider, repo.owner, repo.name, repo.watched ? 1 : 0, JSON.stringify(repo));
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

export function listRepos(db: Db, opts: { watchedOnly?: boolean } = {}): RepoRow[] {
  const sql = opts.watchedOnly
    ? "SELECT * FROM repos WHERE watched = 1 ORDER BY provider, owner, name"
    : "SELECT * FROM repos ORDER BY provider, owner, name";
  return db.prepare(sql).all() as RepoRow[];
}
