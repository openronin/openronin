// Standing operator notes — long-term "this is how I want you to behave".
//
// The recentChat window in state.ts caps at 25 messages so the prompt
// stays cheap. That's enough for "what did the operator ask about
// today" but not for "the operator hates issues with scope >200 LOC"
// said three weeks ago. Standing notes survive that window — they're
// stored separately and rendered into a dedicated prompt section.
//
// Two ways notes get added:
//  1. The director itself emits a `remember_preference` decision when it
//     hears the operator state a stable preference. The executor inserts.
//  2. The operator adds them directly via /admin/director (UI lands in
//     a follow-up PR; for now this module gives the data layer).

import type { Db } from "../storage/db.js";

export type DirectorNote = {
  id: number;
  repoId: number;
  ts: string;
  kind: string; // "preference" | "fact" | "constraint" | freeform
  body: string;
  sourceMessageId: number | null;
};

type Row = {
  id: number;
  repo_id: number;
  ts: string;
  kind: string;
  body: string;
  source_message_id: number | null;
};

function rowToNote(row: Row): DirectorNote {
  return {
    id: row.id,
    repoId: row.repo_id,
    ts: row.ts,
    kind: row.kind,
    body: row.body,
    sourceMessageId: row.source_message_id,
  };
}

export type NewDirectorNote = {
  repoId: number;
  kind: string;
  body: string;
  sourceMessageId?: number | null;
};

export function recordNote(db: Db, n: NewDirectorNote): DirectorNote {
  const row = db
    .prepare(
      `INSERT INTO director_notes (repo_id, kind, body, source_message_id)
       VALUES (?, ?, ?, ?)
       RETURNING *`,
    )
    .get(n.repoId, n.kind, n.body.trim(), n.sourceMessageId ?? null) as Row;
  return rowToNote(row);
}

export function listNotes(db: Db, repoId: number, limit = 50): DirectorNote[] {
  const rows = db
    .prepare(
      `SELECT * FROM director_notes WHERE repo_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(repoId, limit) as Row[];
  return rows.map(rowToNote);
}

export function deleteNote(db: Db, repoId: number, noteId: number): boolean {
  const res = db
    .prepare(`DELETE FROM director_notes WHERE id = ? AND repo_id = ?`)
    .run(noteId, repoId);
  return res.changes > 0;
}

// Render notes for the prompt. Capped at 20 most recent so the section
// doesn't dominate the context. Format is plain "- kind: body" lines —
// the LLM can read these without ceremony.
export function renderNotesForPrompt(notes: DirectorNote[]): string {
  if (notes.length === 0) return "(no standing notes — operator hasn't told you anything to remember yet)";
  return notes
    .slice(0, 20)
    .map((n) => `- ${n.kind}: ${n.body}`)
    .join("\n");
}
