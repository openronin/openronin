import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MimoEngine } from "../engines/mimo.js";
import { AnthropicEngine } from "../engines/anthropic.js";
import type { Engine } from "../engines/types.js";
import { loadTemplate, renderTemplate } from "../prompts/registry.js";
import { triageFixtures, analyzeFixtures } from "./fixtures.js";
import type { TriageFixture, AnalyzeFixture } from "./fixtures.js";

// Per-token pricing (USD). null = unknown.
const MODEL_PRICING: Record<string, { input: number; output: number } | null> = {
  "mimo-v2.5": null,
  "claude-haiku-4-5-20251001": { input: 0.8 / 1_000_000, output: 4 / 1_000_000 },
  "claude-sonnet-4-6": { input: 3 / 1_000_000, output: 15 / 1_000_000 },
};

interface ModelConfig {
  engine: Engine;
  modelId: string;
  label: string;
}

interface BenchRow {
  taskId: string;
  lane: "triage" | "analyze";
  model: string;
  durationMs: number;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  expected: string;
  got: string | null;
  correct: boolean;
  error: string | null;
  rawDecision: unknown;
}

function calcCost(model: string, tokensIn?: number, tokensOut?: number): number | null {
  const pricing = MODEL_PRICING[model];
  if (!pricing || tokensIn == null || tokensOut == null) return null;
  return tokensIn * pricing.input + tokensOut * pricing.output;
}

function parseArgs(): {
  models: string[];
  lane: "triage" | "analyze" | "all";
  outputDir: string;
  timeoutMs: number;
} {
  const args = process.argv.slice(2);
  let models = ["mimo-v2.5", "claude-haiku-4-5-20251001"];
  let lane: "triage" | "analyze" | "all" = "all";
  let outputDir = "./bench-results";
  let timeoutMs = 30_000;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--models" && args[i + 1]) {
      models = (args[++i] ?? "").split(",").map((s) => s.trim());
    } else if (args[i] === "--lane" && args[i + 1]) {
      const v = args[++i] ?? "all";
      lane = v as "triage" | "analyze" | "all";
    } else if (args[i] === "--output-dir" && args[i + 1]) {
      outputDir = args[++i] ?? outputDir;
    } else if (args[i] === "--timeout-ms" && args[i + 1]) {
      timeoutMs = parseInt(args[++i] ?? "30000", 10);
    }
  }
  return { models, lane, outputDir, timeoutMs };
}

function buildModelConfig(modelId: string): ModelConfig {
  if (modelId === "mimo-v2.5") {
    return {
      engine: new MimoEngine({ defaultModel: "mimo-v2.5" }),
      modelId,
      label: "mimo-v2.5",
    };
  }
  if (modelId.startsWith("claude-")) {
    return {
      engine: new AnthropicEngine({ defaultModel: modelId }),
      modelId,
      label: modelId,
    };
  }
  throw new Error(
    `Unknown model: ${modelId}. Supported: mimo-v2.5, claude-haiku-4-5-20251001, claude-sonnet-4-6`,
  );
}

async function runTriageTask(
  fix: TriageFixture,
  mc: ModelConfig,
  timeoutMs: number,
): Promise<BenchRow> {
  const template = loadTemplate("review-item");
  const prompt = renderTemplate(template, {
    kind: fix.item.kind,
    repo_full_name: "test/repo",
    number: String(fix.item.number),
    title: fix.item.title,
    url: fix.item.url,
    author: fix.item.author,
    author_association: fix.item.authorAssociation,
    labels: fix.item.labels.join(", ") || "(none)",
    created_at: fix.item.createdAt,
    updated_at: fix.item.updatedAt,
    body: fix.item.body,
    protected_labels: "openronin:do-it",
    language_for_communication: "English",
  });

  const started = Date.now();
  try {
    const result = await mc.engine.run({
      systemPrompt: "You are openronin, a maintenance assistant.",
      userPrompt: prompt,
      timeoutMs,
      expectJson: true,
      model: mc.modelId,
    });
    const durationMs = Date.now() - started;
    const decision = result.json as
      | { decision?: string; close_reason?: string; confidence?: string }
      | undefined;
    const got = decision?.decision ?? null;
    const correct = got === fix.expected.decision;
    const tokensIn = result.usage.tokensIn ?? null;
    const tokensOut = result.usage.tokensOut ?? null;
    return {
      taskId: fix.id,
      lane: "triage",
      model: mc.modelId,
      durationMs,
      tokensIn,
      tokensOut,
      costUsd: calcCost(mc.modelId, tokensIn ?? undefined, tokensOut ?? undefined),
      expected: fix.expected.decision,
      got,
      correct,
      error: null,
      rawDecision: decision,
    };
  } catch (err) {
    return {
      taskId: fix.id,
      lane: "triage",
      model: mc.modelId,
      durationMs: Date.now() - started,
      tokensIn: null,
      tokensOut: null,
      costUsd: null,
      expected: fix.expected.decision,
      got: null,
      correct: false,
      error: String(err),
      rawDecision: null,
    };
  }
}

async function runAnalyzeTask(
  fix: AnalyzeFixture,
  mc: ModelConfig,
  timeoutMs: number,
): Promise<BenchRow> {
  const template = loadTemplate("analyze-issue");
  const prompt = renderTemplate(template, {
    repo_full_name: "test/repo",
    number: String(fix.item.number),
    title: fix.item.title,
    url: `https://github.com/test/repo/issues/${fix.item.number}`,
    author: fix.item.author,
    author_association: fix.item.authorAssociation,
    labels: fix.item.labels.join(", ") || "(none)",
    body: fix.item.body,
    existing_comments: fix.item.existingComments || "(none)",
    language_for_communication: "English",
    language_for_code_identifiers: "English",
  });

  const started = Date.now();
  try {
    const result = await mc.engine.run({
      systemPrompt: "You are openronin, acting as a product analyst.",
      userPrompt: prompt,
      timeoutMs,
      expectJson: true,
      model: mc.modelId,
    });
    const durationMs = Date.now() - started;
    const decision = result.json as { state?: string; questions?: string[] } | undefined;
    const got = decision?.state ?? null;
    const correct = got === fix.expected.state;
    const tokensIn = result.usage.tokensIn ?? null;
    const tokensOut = result.usage.tokensOut ?? null;
    return {
      taskId: fix.id,
      lane: "analyze",
      model: mc.modelId,
      durationMs,
      tokensIn,
      tokensOut,
      costUsd: calcCost(mc.modelId, tokensIn ?? undefined, tokensOut ?? undefined),
      expected: fix.expected.state,
      got,
      correct,
      error: null,
      rawDecision: decision,
    };
  } catch (err) {
    return {
      taskId: fix.id,
      lane: "analyze",
      model: mc.modelId,
      durationMs: Date.now() - started,
      tokensIn: null,
      tokensOut: null,
      costUsd: null,
      expected: fix.expected.state,
      got: null,
      correct: false,
      error: String(err),
      rawDecision: null,
    };
  }
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(Math.floor((p / 100) * sorted.length), sorted.length - 1);
  return sorted[idx] ?? 0;
}

interface LaneStats {
  model: string;
  correct: number;
  total: number;
  accuracy: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  totalCostUsd: number | null;
  costPerTaskUsd: number | null;
  errors: number;
}

function computeStats(rows: BenchRow[], modelId: string, lane: "triage" | "analyze"): LaneStats {
  const subset = rows.filter((r) => r.model === modelId && r.lane === lane);
  const correct = subset.filter((r) => r.correct).length;
  const total = subset.length;
  const latencies = subset.map((r) => r.durationMs).sort((a, b) => a - b);
  const costs = subset.map((r) => r.costUsd).filter((c): c is number => c !== null);
  const totalCostUsd = costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null;
  return {
    model: modelId,
    correct,
    total,
    accuracy: total > 0 ? correct / total : 0,
    avgLatencyMs: avg(latencies),
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
    totalCostUsd,
    costPerTaskUsd: totalCostUsd !== null && total > 0 ? totalCostUsd / total : null,
    errors: subset.filter((r) => r.error !== null).length,
  };
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function fmtMs(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtCost(usd: number | null): string {
  if (usd === null) return "N/A";
  return `$${usd.toFixed(5)}`;
}

function buildSummary(rows: BenchRow[], models: string[], runAt: string): string {
  const triageModels = models.map((m) => computeStats(rows, m, "triage"));
  const analyzeModels = models.map((m) => computeStats(rows, m, "analyze"));

  const header = `# Supervisor Bench Results — ${runAt}

## Configuration

- Tasks: ${triageFixtures.length} triage + ${analyzeFixtures.length} analyze = ${triageFixtures.length + analyzeFixtures.length} total
- Models: ${models.join(", ")}
- Dataset: openronin fixture set v1 (${triageFixtures.length} triage: ${triageFixtures.filter((f) => f.expected.decision === "keep_open").length} keep_open / ${triageFixtures.filter((f) => f.expected.decision === "close").length} close; ${analyzeFixtures.length} analyze: ${analyzeFixtures.filter((f) => f.expected.state === "ready").length} ready / ${analyzeFixtures.filter((f) => f.expected.state === "needs_clarification").length} needs_clarification)

`;

  const triageTable = buildTable("## Triage Accuracy", triageModels, "Triage (keep_open / close)");
  const analyzeTable = buildTable(
    "## Analyze Accuracy",
    analyzeModels,
    "Analyze (ready / needs_clarification)",
  );

  const conclusion = buildConclusion(triageModels, analyzeModels);

  return header + triageTable + "\n" + analyzeTable + "\n" + conclusion;
}

function buildTable(heading: string, stats: LaneStats[], _label: string): string {
  const header = `${heading}

| Model | Correct | Total | Accuracy | Avg Latency | p50 | p95 | Total Cost | Cost/Task | Errors |
|-------|---------|-------|----------|-------------|-----|-----|------------|-----------|--------|
`;
  const rows = stats
    .map(
      (s) =>
        `| ${s.model} | ${s.correct} | ${s.total} | ${fmtPct(s.accuracy)} | ${fmtMs(s.avgLatencyMs)} | ${fmtMs(s.p50LatencyMs)} | ${fmtMs(s.p95LatencyMs)} | ${fmtCost(s.totalCostUsd)} | ${fmtCost(s.costPerTaskUsd)} | ${s.errors} |`,
    )
    .join("\n");
  return header + rows + "\n";
}

function buildConclusion(triage: LaneStats[], analyze: LaneStats[]): string {
  const combined = [...triage, ...analyze];
  if (combined.length < 2) return "## Conclusion\n\nInsufficient data for comparison.\n";

  // Find best accuracy model
  const triageByAcc = [...triage].sort((a, b) => b.accuracy - a.accuracy);
  const analyzeByAcc = [...analyze].sort((a, b) => b.accuracy - a.accuracy);
  const bestTriage = triageByAcc[0];
  const bestAnalyze = analyzeByAcc[0];

  // Cost comparison
  const haiku = combined.find((s) => s.model.includes("haiku"));
  const mimo = combined.find((s) => s.model.includes("mimo"));
  const sonnet = combined.find((s) => s.model.includes("sonnet"));

  let costNote = "";
  if (haiku?.totalCostUsd != null && sonnet?.totalCostUsd != null && sonnet.totalCostUsd > 0) {
    const ratio = sonnet.totalCostUsd / haiku.totalCostUsd;
    costNote = `\nCost ratio Haiku vs Sonnet: **${ratio.toFixed(1)}x cheaper** per task for Haiku.`;
  }

  return `## Conclusion

Best triage accuracy: **${bestTriage?.model ?? "N/A"}** at ${fmtPct(bestTriage?.accuracy ?? 0)} (${bestTriage?.correct ?? 0}/${bestTriage?.total ?? 0}).
Best analyze accuracy: **${bestAnalyze?.model ?? "N/A"}** at ${fmtPct(bestAnalyze?.accuracy ?? 0)} (${bestAnalyze?.correct ?? 0}/${bestAnalyze?.total ?? 0}).${costNote}

### Recommendation

${buildRecommendation(triage, analyze, haiku, mimo)}
`;
}

function buildRecommendation(
  triage: LaneStats[],
  analyze: LaneStats[],
  haiku: LaneStats | undefined,
  mimo: LaneStats | undefined,
): string {
  const mimoTriageAcc = triage.find((s) => s.model.includes("mimo"))?.accuracy ?? null;
  const haikuTriageAcc = triage.find((s) => s.model.includes("haiku"))?.accuracy ?? null;
  const mimoAnalyzeAcc = analyze.find((s) => s.model.includes("mimo"))?.accuracy ?? null;
  const haikuAnalyzeAcc = analyze.find((s) => s.model.includes("haiku"))?.accuracy ?? null;

  if (mimoTriageAcc === null || haikuTriageAcc === null) {
    return "Run with both `mimo-v2.5` and `claude-haiku-4-5-20251001` for a full comparison.";
  }

  const triageDelta = Math.abs(haikuTriageAcc - mimoTriageAcc);
  const analyzeDelta =
    mimoAnalyzeAcc !== null && haikuAnalyzeAcc !== null
      ? Math.abs(haikuAnalyzeAcc - mimoAnalyzeAcc)
      : null;

  const withinThreshold = triageDelta <= 0.05 && (analyzeDelta === null || analyzeDelta <= 0.05);
  const haikuHasCost = haiku?.totalCostUsd != null;
  const mimoHasCost = mimo?.totalCostUsd != null;

  if (withinThreshold && haikuHasCost && !mimoHasCost) {
    return (
      `Haiku is within ±5% accuracy of MIMO on both lanes while providing transparent per-task cost tracking. ` +
      `**Switching to claude-haiku-4-5-20251001 is recommended** if cost visibility is a priority.`
    );
  }
  if (withinThreshold && haikuHasCost && mimoHasCost) {
    const haikuTotalCost =
      (haiku?.totalCostUsd ?? 0) +
      (analyze.find((s) => s.model.includes("haiku"))?.totalCostUsd ?? 0);
    const mimoTotalCost =
      (mimo?.totalCostUsd ?? 0) +
      (analyze.find((s) => s.model.includes("mimo"))?.totalCostUsd ?? 0);
    if (haikuTotalCost < mimoTotalCost * 0.7) {
      return (
        `Haiku achieves comparable accuracy (within ±5%) at lower cost. ` +
        `**Switching to claude-haiku-4-5-20251001 is recommended.**`
      );
    }
  }
  if (!withinThreshold && haikuTriageAcc > mimoTriageAcc) {
    return `Haiku outperforms MIMO by more than 5%. **Consider switching to claude-haiku-4-5-20251001.**`;
  }
  if (!withinThreshold && mimoTriageAcc > haikuTriageAcc) {
    return `MIMO outperforms Haiku by more than 5%. **Keep mimo-v2.5 as the default supervisor engine.**`;
  }
  return `Results are within ±5% accuracy. The choice between models depends on cost constraints and latency requirements.`;
}

async function main(): Promise<void> {
  const { models, lane, outputDir, timeoutMs } = parseArgs();
  const runAt = new Date().toISOString();
  const ts = runAt.replace(/[:.]/g, "-").slice(0, 19);

  mkdirSync(outputDir, { recursive: true });
  const jsonlPath = resolve(outputDir, `results-${ts}.jsonl`);
  const summaryPath = resolve(outputDir, `summary.md`);

  const modelConfigs: ModelConfig[] = models.map(buildModelConfig);

  const triageTasks = lane === "analyze" ? [] : triageFixtures;
  const analyzeTasks = lane === "triage" ? [] : analyzeFixtures;
  const totalTasks = (triageTasks.length + analyzeTasks.length) * models.length;

  console.log(`\nopenronin supervisor bench — ${runAt}`);
  console.log(`Models: ${models.join(", ")}`);
  console.log(`Lane: ${lane} | Tasks: ${totalTasks} | Timeout: ${timeoutMs}ms`);
  console.log(`Output: ${outputDir}\n`);

  const allRows: BenchRow[] = [];
  let done = 0;

  for (const mc of modelConfigs) {
    console.log(`\n=== ${mc.label} ===`);

    for (const fix of triageTasks) {
      process.stdout.write(`  [${++done}/${totalTasks}] triage ${fix.id} ... `);
      const row = await runTriageTask(fix, mc, timeoutMs);
      allRows.push(row);
      appendFileSync(jsonlPath, JSON.stringify(row) + "\n");
      if (row.error) {
        console.log(`ERROR: ${row.error.slice(0, 80)}`);
      } else {
        console.log(`${row.correct ? "✓" : "✗"} (${row.got ?? "null"}) ${fmtMs(row.durationMs)}`);
      }
    }

    for (const fix of analyzeTasks) {
      process.stdout.write(`  [${++done}/${totalTasks}] analyze ${fix.id} ... `);
      const row = await runAnalyzeTask(fix, mc, timeoutMs);
      allRows.push(row);
      appendFileSync(jsonlPath, JSON.stringify(row) + "\n");
      if (row.error) {
        console.log(`ERROR: ${row.error.slice(0, 80)}`);
      } else {
        console.log(`${row.correct ? "✓" : "✗"} (${row.got ?? "null"}) ${fmtMs(row.durationMs)}`);
      }
    }
  }

  const summary = buildSummary(allRows, models, runAt);
  writeFileSync(summaryPath, summary, "utf8");

  console.log(`\n--- Summary ---`);
  console.log(summary);
  console.log(`\nJSONL: ${jsonlPath}`);
  console.log(`Summary: ${summaryPath}`);
}

// Resolve __dirname equivalent for ESM
const _here = dirname(fileURLToPath(import.meta.url));
void _here;

main().catch((err) => {
  console.error("bench failed:", err);
  process.exit(1);
});
