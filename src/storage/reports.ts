import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReviewDecision } from "../lanes/review.js";
import type { VcsItem } from "../providers/vcs.js";
import type { RepoConfig } from "../config/schema.js";

interface WriteReviewReportInput {
  dataDir: string;
  repo: RepoConfig;
  item: VcsItem;
  decision: ReviewDecision;
  engineId: string;
  model: string;
  usage: { tokensIn?: number; tokensOut?: number; costUsd?: number };
  durationMs: number;
}

export function reportPath(dataDir: string, repo: RepoConfig, item: VcsItem): string {
  const folder = item.state === "closed" ? "closed" : "items";
  const dir = resolve(dataDir, "reports", repo.provider, repo.owner, repo.name, folder);
  mkdirSync(dir, { recursive: true });
  return resolve(dir, `${item.number}.md`);
}

export function writeReviewReport(input: WriteReviewReportInput): string {
  const path = reportPath(input.dataDir, input.repo, input.item);
  const md = renderReport(input);
  writeFileSync(path, md);
  return path;
}

function renderReport(input: WriteReviewReportInput): string {
  const { repo, item, decision, engineId, model, usage, durationMs } = input;
  const fm: Record<string, string | number | undefined> = {
    provider: repo.provider,
    owner: repo.owner,
    repo: repo.name,
    number: item.number,
    kind: item.kind,
    state: item.state,
    decision: decision.decision,
    close_reason: decision.close_reason,
    confidence: decision.confidence,
    engine: engineId,
    model,
    tokens_in: usage.tokensIn,
    tokens_out: usage.tokensOut,
    cost_usd: usage.costUsd,
    duration_ms: durationMs,
    reviewed_at: new Date().toISOString(),
    item_url: item.url,
  };
  const fmYaml = Object.entries(fm)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? JSON.stringify(v) : v}`)
    .join("\n");

  const evidence = decision.evidence.length
    ? decision.evidence.map((e) => `- ${e}`).join("\n")
    : "_none_";

  return `---
${fmYaml}
---

# ${item.title}

[#${item.number} on ${repo.owner}/${repo.name}](${item.url}) by **${item.author}** (${item.authorAssociation})

## Decision

**${decision.decision}** — ${decision.close_reason} (${decision.confidence} confidence)

## Summary

${decision.summary}

## Evidence

${evidence}

## Suggested comment

${decision.comment ? decision.comment : "_none_"}
`;
}
