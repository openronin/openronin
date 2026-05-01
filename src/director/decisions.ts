// Decision data layer.
//
// Every decision the Director takes — even no-ops — is persisted before any
// side-effect. This gives a complete audit trail (visible in /admin/director)
// and lets us recover gracefully if the service crashes mid-execution.

import type { Db } from "../storage/db.js";
import type { Decision, DecisionOutcome, DecisionType, NewDecision } from "./types.js";

type DecisionRow = {
  id: number;
  repo_id: number;
  ts: string;
  decision_type: string;
  rationale: string;
  charter_version: number | null;
  state_snapshot: string | null;
  payload: string | null;
  outcome: string;
  outcome_ts: string | null;
  outcome_details: string | null;
  cost_usd: number;
};

function rowToDecision(row: DecisionRow): Decision {
  return {
    id: row.id,
    repoId: row.repo_id,
    ts: row.ts,
    decisionType: row.decision_type as DecisionType,
    rationale: row.rationale,
    charterVersion: row.charter_version,
    stateSnapshot: row.state_snapshot ? JSON.parse(row.state_snapshot) : null,
    payload: row.payload ? JSON.parse(row.payload) : null,
    outcome: row.outcome as DecisionOutcome,
    outcomeTs: row.outcome_ts,
    outcomeDetails: row.outcome_details,
    costUsd: row.cost_usd,
  };
}

export function recordDecision(db: Db, d: NewDecision): Decision {
  const row = db
    .prepare(
      `INSERT INTO director_decisions
         (repo_id, decision_type, rationale, charter_version,
          state_snapshot, payload, outcome, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .get(
      d.repoId,
      d.decisionType,
      d.rationale,
      d.charterVersion ?? null,
      d.stateSnapshot ? JSON.stringify(d.stateSnapshot) : null,
      d.payload ? JSON.stringify(d.payload) : null,
      d.outcome ?? "pending",
      d.costUsd ?? 0,
    ) as DecisionRow;
  return rowToDecision(row);
}

export function setDecisionOutcome(
  db: Db,
  decisionId: number,
  outcome: DecisionOutcome,
  details?: string,
): void {
  db.prepare(
    `UPDATE director_decisions
     SET outcome = ?, outcome_ts = datetime('now'), outcome_details = ?
     WHERE id = ?`,
  ).run(outcome, details ?? null, decisionId);
}

export function recentDecisions(db: Db, repoId: number, limit = 50): Decision[] {
  const rows = db
    .prepare(
      `SELECT * FROM director_decisions
       WHERE repo_id = ?
       ORDER BY id DESC LIMIT ?`,
    )
    .all(repoId, limit) as DecisionRow[];
  return rows.map(rowToDecision);
}

export function pendingDecisions(db: Db, repoId: number): Decision[] {
  const rows = db
    .prepare(
      `SELECT * FROM director_decisions
       WHERE repo_id = ? AND outcome = 'pending'
       ORDER BY id ASC`,
    )
    .all(repoId) as DecisionRow[];
  return rows.map(rowToDecision);
}
