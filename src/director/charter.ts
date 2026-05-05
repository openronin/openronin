// Charter loader.
//
// The charter is the Director's "constitution" for a given repo: vision,
// priorities, out-of-bounds zones, definition-of-done. It lives in the
// per-repo YAML config (under `director.charter`) and is versioned in
// `director_charter_versions` so every decision can pin exactly which
// version of the charter produced it.

import { createHash } from "node:crypto";
import YAML from "yaml";
import type { Db } from "../storage/db.js";
import { CharterSchema, type Charter } from "./types.js";
import { appendMessage } from "./chat.js";

export type CharterVersion = {
  repoId: number;
  version: number;
  charter: Charter;
  charterYaml: string;
  effectiveFrom: string;
};

export function charterHash(charter: Charter): string {
  return createHash("sha256").update(JSON.stringify(charter)).digest("hex").slice(0, 16);
}

export function parseCharter(input: unknown): Charter | null {
  if (input === null || input === undefined) return null;
  const parsed = CharterSchema.safeParse(input);
  if (!parsed.success) return null;
  return parsed.data;
}

// Snapshot the current charter into the versioned table if it's changed
// since last seen. Returns the version number to stamp on decisions.
//
// On version transitions (i.e. v(N) → v(N+1) where N >= 1) we also post a
// brief chat note summarising what changed — vision-level diffs are
// important for the operator to confirm without trawling the YAML diff.
export function captureCharterVersion(db: Db, repoId: number, charter: Charter): number {
  const yaml = YAML.stringify({ charter });
  const latest = db
    .prepare(
      `SELECT version, charter_yaml FROM director_charter_versions
       WHERE repo_id = ?
       ORDER BY version DESC LIMIT 1`,
    )
    .get(repoId) as { version: number; charter_yaml: string } | undefined;
  if (latest && latest.charter_yaml === yaml) return latest.version;
  const nextVersion = (latest?.version ?? 0) + 1;
  db.prepare(
    `INSERT INTO director_charter_versions (repo_id, version, charter_yaml)
     VALUES (?, ?, ?)`,
  ).run(repoId, nextVersion, yaml);

  // First version: silent (we just captured it for the first time).
  // Subsequent versions: surface a diff summary in chat so the operator
  // — and the next planning tick — both know what changed.
  if (latest) {
    try {
      const oldCharter = (YAML.parse(latest.charter_yaml) as { charter?: Charter })?.charter;
      const summary = oldCharter ? summariseCharterDiff(oldCharter, charter) : "(charter updated)";
      appendMessage(db, {
        repoId,
        role: "system",
        type: "tick_log",
        body: `📜 Charter v${latest.version} → v${nextVersion}\n\n${summary}`,
        metadata: {
          kind: "charter_diff",
          oldVersion: latest.version,
          newVersion: nextVersion,
        },
      });
    } catch {
      // Diff is best-effort — never let a render failure break the
      // version capture itself.
    }
  }

  return nextVersion;
}

function summariseCharterDiff(prev: Charter, next: Charter): string {
  const lines: string[] = [];
  if (prev.vision !== next.vision) {
    lines.push(`- Vision changed.`);
  }
  const prevPriIds = new Set(prev.priorities.map((p) => p.id));
  const nextPriIds = new Set(next.priorities.map((p) => p.id));
  const added = [...nextPriIds].filter((id) => !prevPriIds.has(id));
  const removed = [...prevPriIds].filter((id) => !nextPriIds.has(id));
  if (added.length > 0) lines.push(`- Priorities added: ${added.join(", ")}`);
  if (removed.length > 0) lines.push(`- Priorities removed: ${removed.join(", ")}`);
  // Weight changes for shared priorities.
  const weightChanges: string[] = [];
  for (const p of next.priorities) {
    const old = prev.priorities.find((x) => x.id === p.id);
    if (old && Math.abs(old.weight - p.weight) > 0.001) {
      weightChanges.push(`${p.id}: ${old.weight.toFixed(2)} → ${p.weight.toFixed(2)}`);
    }
  }
  if (weightChanges.length > 0) lines.push(`- Weight changes: ${weightChanges.join("; ")}`);
  if ((prev.persona?.name ?? "") !== (next.persona?.name ?? "")) {
    lines.push(`- Persona name: ${prev.persona?.name ?? "—"} → ${next.persona?.name ?? "—"}`);
  }
  return lines.length > 0 ? lines.join("\n") : "(no surface-level changes — body only)";
}

export function getCharterVersion(db: Db, repoId: number, version: number): CharterVersion | null {
  const row = db
    .prepare(
      `SELECT repo_id, version, charter_yaml, effective_from
       FROM director_charter_versions
       WHERE repo_id = ? AND version = ?`,
    )
    .get(repoId, version) as
    | { repo_id: number; version: number; charter_yaml: string; effective_from: string }
    | undefined;
  if (!row) return null;
  const parsed = YAML.parse(row.charter_yaml) as { charter: unknown };
  const charter = parseCharter(parsed.charter);
  if (!charter) return null;
  return {
    repoId: row.repo_id,
    version: row.version,
    charter,
    charterYaml: row.charter_yaml,
    effectiveFrom: row.effective_from,
  };
}

export function latestCharterVersion(db: Db, repoId: number): CharterVersion | null {
  const row = db
    .prepare(
      `SELECT repo_id, version, charter_yaml, effective_from
       FROM director_charter_versions
       WHERE repo_id = ?
       ORDER BY version DESC LIMIT 1`,
    )
    .get(repoId) as
    | { repo_id: number; version: number; charter_yaml: string; effective_from: string }
    | undefined;
  if (!row) return null;
  const parsed = YAML.parse(row.charter_yaml) as { charter: unknown };
  const charter = parseCharter(parsed.charter);
  if (!charter) return null;
  return {
    repoId: row.repo_id,
    version: row.version,
    charter,
    charterYaml: row.charter_yaml,
    effectiveFrom: row.effective_from,
  };
}
