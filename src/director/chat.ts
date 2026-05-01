// Chat data layer — the Director's conversation thread per repo.
//
// Messages are append-only. The Director reads recent N messages each tick
// to incorporate user directives/answers; writes status, proposals, and
// reports back. The admin UI (/admin/director/<repo>) and the Telegram
// bridge are both pure consumers of this table.

import type { Db } from "../storage/db.js";
import type {
  DirectorMessage,
  MessageRole,
  MessageType,
  NewDirectorMessage,
} from "./types.js";

type MessageRow = {
  id: number;
  repo_id: number;
  ts: string;
  role: string;
  type: string;
  body: string;
  metadata: string | null;
  parent_id: number | null;
  decision_id: number | null;
};

function rowToMessage(row: MessageRow): DirectorMessage {
  return {
    id: row.id,
    repoId: row.repo_id,
    ts: row.ts,
    role: row.role as MessageRole,
    type: row.type as MessageType,
    body: row.body,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
    parentId: row.parent_id,
    decisionId: row.decision_id,
  };
}

export function appendMessage(db: Db, msg: NewDirectorMessage): DirectorMessage {
  const stmt = db.prepare(
    `INSERT INTO director_messages
       (repo_id, role, type, body, metadata, parent_id, decision_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     RETURNING id, repo_id, ts, role, type, body, metadata, parent_id, decision_id`,
  );
  const row = stmt.get(
    msg.repoId,
    msg.role,
    msg.type,
    msg.body,
    msg.metadata ? JSON.stringify(msg.metadata) : null,
    msg.parentId ?? null,
    msg.decisionId ?? null,
  ) as MessageRow;
  return rowToMessage(row);
}

export function recentMessages(db: Db, repoId: number, limit = 50): DirectorMessage[] {
  const rows = db
    .prepare(
      `SELECT id, repo_id, ts, role, type, body, metadata, parent_id, decision_id
       FROM director_messages
       WHERE repo_id = ?
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(repoId, limit) as MessageRow[];
  return rows.map(rowToMessage).reverse();
}

export function messagesSince(
  db: Db,
  repoId: number,
  sinceMessageId: number,
): DirectorMessage[] {
  const rows = db
    .prepare(
      `SELECT id, repo_id, ts, role, type, body, metadata, parent_id, decision_id
       FROM director_messages
       WHERE repo_id = ? AND id > ?
       ORDER BY id ASC`,
    )
    .all(repoId, sinceMessageId) as MessageRow[];
  return rows.map(rowToMessage);
}

export function unansweredUserDirectives(db: Db, repoId: number): DirectorMessage[] {
  // User messages that haven't yet been acknowledged by a director report.
  // A simple heuristic: user message with no later director message of any kind.
  const rows = db
    .prepare(
      `SELECT id, repo_id, ts, role, type, body, metadata, parent_id, decision_id
       FROM director_messages
       WHERE repo_id = ?
         AND role = 'user'
         AND id > COALESCE(
           (SELECT MAX(id) FROM director_messages
              WHERE repo_id = ? AND role = 'director'),
           0)
       ORDER BY id ASC`,
    )
    .all(repoId, repoId) as MessageRow[];
  return rows.map(rowToMessage);
}

export function messageCount(db: Db, repoId: number): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM director_messages WHERE repo_id = ?")
    .get(repoId) as { n: number };
  return row.n;
}
