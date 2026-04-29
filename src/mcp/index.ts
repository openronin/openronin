#!/usr/bin/env node
/**
 * openronin-mcp — stdio MCP server exposing the openronin REST API to any
 * MCP-compatible client (Claude Desktop, custom assistants, IDE plugins, etc).
 *
 * Protocol: JSON-RPC 2.0 over stdio, one JSON object per line.
 * No external SDK dependency — minimal implementation suitable for embedding.
 *
 * Env:
 *   OPENRONIN_BASE_URL   default http://localhost:8090
 *   OPENRONIN_API_TOKEN  required
 */

import { createInterface } from "node:readline";

const BASE_URL = (process.env.OPENRONIN_BASE_URL ?? "http://localhost:8090").replace(/\/$/, "");
const API_TOKEN = process.env.OPENRONIN_API_TOKEN ?? "";

if (!API_TOKEN) {
  process.stderr.write("[openronin-mcp] OPENRONIN_API_TOKEN is required\n");
  process.exit(1);
}

// ── JSON-RPC helpers ────────────────────────────────────────────────────────

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id: JsonRpcId, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id: JsonRpcId, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

// ── REST API client ─────────────────────────────────────────────────────────

async function apiGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
  });
  return res.json();
}

async function apiPost(path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

function isApiError(data: unknown): data is { error: { code: string; message: string } } {
  return (
    typeof data === "object" &&
    data !== null &&
    "error" in data &&
    typeof (data as { error: unknown }).error === "object"
  );
}

function extractError(data: unknown): string {
  if (isApiError(data)) {
    const e = data.error;
    return `Ошибка ${e.code}: ${e.message}`;
  }
  return `Неизвестная ошибка: ${JSON.stringify(data)}`;
}

function textContent(text: string): { content: Array<{ type: string; text: string }> } {
  return { content: [{ type: "text", text }] };
}

// ── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "openronin_status",
    description:
      "Получить текущий статус openronin: очередь задач, стоимость за 24ч, активна ли пауза, последние ошибки.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "openronin_list_tasks",
    description: "Получить список задач openronin с фильтрацией по статусу и репозиторию.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          description: "Фильтр по статусу: pending, running, done, error",
          enum: ["pending", "running", "done", "error"],
        },
        repo: { type: "string", description: "Репозиторий в формате owner/name" },
        limit: { type: "number", description: "Максимальное количество задач (по умолчанию 20)" },
      },
      required: [],
    },
  },
  {
    name: "openronin_view_task",
    description: "Просмотреть детали задачи и последние запуски по ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "ID задачи" },
      },
      required: ["id"],
    },
  },
  {
    name: "openronin_enqueue",
    description: "Поставить задачу в очередь с высоким приоритетом (перезапустить).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "ID задачи" },
      },
      required: ["id"],
    },
  },
  {
    name: "openronin_cancel",
    description: "Отменить задачу (перевести в статус done с пометкой 'cancelled by api').",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "ID задачи" },
      },
      required: ["id"],
    },
  },
  {
    name: "openronin_list_prs",
    description: "Получить список активных PR, созданных openronin, с их текущим состоянием.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "openronin_pause",
    description:
      "ВНИМАНИЕ: приостанавливает все автоматические операции openronin. Уточни у пользователя причину перед вызовом.",
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Причина паузы (необязательно)" },
      },
      required: [],
    },
  },
  {
    name: "openronin_resume",
    description: "Возобновить работу openronin после паузы.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "openronin_cost_today",
    description: "Получить разбивку расходов за последние 24 часа по lane, engine и репозиторию.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "openronin_create_issue",
    description:
      "ВНИМАНИЕ: создаёт issue в GitHub репозитории через openronin. Уточни repo и title у пользователя перед вызовом.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Репозиторий в формате owner/name" },
        title: { type: "string", description: "Заголовок issue" },
        body: { type: "string", description: "Тело issue (необязательно)" },
        start_now: {
          type: "boolean",
          description: "Добавить label openronin:do-it чтобы сразу начать работу",
        },
      },
      required: ["repo", "title"],
    },
  },
];

// ── Tool handlers ─────────────────────────────────────────────────────────────

async function handleTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  switch (name) {
    case "openronin_status": {
      const data = await apiGet("/api/status");
      if (isApiError(data))
        return { content: [{ type: "text", text: extractError(data) }], isError: true };
      const s = data as {
        queued: number;
        running: number;
        done_24h: number;
        today_cost_usd: number;
        paused: boolean;
        recent_errors: Array<{ id: number; repo: string; external_id: string; last_error: string }>;
      };
      const lines: string[] = [
        `Статус openronin`,
        `  Очередь:    ${s.queued} ожидает, ${s.running} выполняется`,
        `  За 24ч:     завершено ${s.done_24h}`,
        `  Стоимость:  $${s.today_cost_usd.toFixed(4)}`,
        `  Пауза:      ${s.paused ? "ДА" : "нет"}`,
      ];
      if (s.recent_errors.length > 0) {
        lines.push("\nПоследние ошибки:");
        for (const e of s.recent_errors) {
          lines.push(`  #${e.id} (${e.repo}#${e.external_id}): ${e.last_error}`);
        }
      }
      return textContent(lines.join("\n"));
    }

    case "openronin_list_tasks": {
      const params = new URLSearchParams();
      if (args.status) params.set("status", String(args.status));
      if (args.repo) params.set("repo", String(args.repo));
      params.set("limit", String(args.limit ?? 20));
      const data = await apiGet(`/api/tasks?${params}`);
      if (isApiError(data))
        return { content: [{ type: "text", text: extractError(data) }], isError: true };
      const d = data as {
        tasks: Array<{
          id: number;
          repo: string;
          external_id: string;
          kind: string;
          status: string;
          priority: string;
          last_run_at: string | null;
          last_error: string | null;
        }>;
      };
      if (d.tasks.length === 0) return textContent("Задач не найдено.");
      const rows = [
        "| ID | Репозиторий | Issue | Тип | Статус | Приоритет | Последний запуск |",
        "|---|---|---|---|---|---|---|",
      ];
      for (const t of d.tasks) {
        const ran = t.last_run_at ? t.last_run_at.slice(0, 16).replace("T", " ") : "—";
        rows.push(
          `| ${t.id} | ${t.repo} | #${t.external_id} | ${t.kind} | ${t.status} | ${t.priority ?? "normal"} | ${ran} |`,
        );
      }
      return textContent(rows.join("\n"));
    }

    case "openronin_view_task": {
      const id = Number(args.id);
      const data = await apiGet(`/api/tasks/${id}`);
      if (isApiError(data))
        return { content: [{ type: "text", text: extractError(data) }], isError: true };
      const d = data as {
        task: {
          id: number;
          repo: string;
          external_id: string;
          kind: string;
          status: string;
          priority: string;
          last_run_at: string | null;
          last_error: string | null;
          next_due_at: string | null;
        };
        runs: Array<{
          id: number;
          lane: string;
          engine: string;
          started_at: string;
          finished_at: string | null;
          status: string;
          cost_usd: number | null;
          error: string | null;
        }>;
      };
      const t = d.task;
      const lines = [
        `Задача #${t.id} — ${t.repo}#${t.external_id} (${t.kind})`,
        `  Статус:     ${t.status} | Приоритет: ${t.priority ?? "normal"}`,
        `  Посл. запуск: ${t.last_run_at ?? "—"}`,
        `  Посл. ошибка: ${t.last_error ?? "—"}`,
        `  Следующий запуск: ${t.next_due_at ?? "—"}`,
      ];
      if (d.runs.length > 0) {
        lines.push("\nПоследние запуски:");
        for (const r of d.runs) {
          const cost = r.cost_usd != null ? `$${r.cost_usd.toFixed(4)}` : "—";
          const fin = r.finished_at ? r.finished_at.slice(0, 16).replace("T", " ") : "выполняется";
          lines.push(
            `  [${r.id}] ${r.lane}/${r.engine} | ${r.started_at.slice(0, 16).replace("T", " ")} → ${fin} | ${r.status} | ${cost}`,
          );
          if (r.error) lines.push(`        Ошибка: ${r.error}`);
        }
      }
      return textContent(lines.join("\n"));
    }

    case "openronin_enqueue": {
      const id = Number(args.id);
      const data = await apiPost(`/api/tasks/${id}/enqueue`);
      if (isApiError(data))
        return { content: [{ type: "text", text: extractError(data) }], isError: true };
      return textContent(`Задача #${id} поставлена в очередь с высоким приоритетом.`);
    }

    case "openronin_cancel": {
      const id = Number(args.id);
      const data = await apiPost(`/api/tasks/${id}/cancel`);
      if (isApiError(data))
        return { content: [{ type: "text", text: extractError(data) }], isError: true };
      return textContent(`Задача #${id} отменена.`);
    }

    case "openronin_list_prs": {
      const data = await apiGet("/api/prs");
      if (isApiError(data))
        return { content: [{ type: "text", text: extractError(data) }], isError: true };
      const d = data as {
        prs: Array<{
          id: number;
          repo: string;
          issue_id: string;
          branch: string;
          pr_number: number | null;
          pr_url: string | null;
          status: string;
          iterations: number;
          updated_at: string | null;
        }>;
      };
      if (d.prs.length === 0) return textContent("Активных PR нет.");
      const lines = ["Активные PR openronin:\n"];
      for (const pr of d.prs) {
        const prRef = pr.pr_number ? `PR #${pr.pr_number}` : "PR не создан";
        const url = pr.pr_url ? ` — ${pr.pr_url}` : "";
        const upd = pr.updated_at ? pr.updated_at.slice(0, 16).replace("T", " ") : "—";
        lines.push(`- ${pr.repo}#${pr.issue_id} → ${prRef}${url}`);
        lines.push(`  Статус: ${pr.status} | Итерации: ${pr.iterations} | Обновлено: ${upd}`);
      }
      return textContent(lines.join("\n"));
    }

    case "openronin_pause": {
      const reason = args.reason ? String(args.reason) : "";
      const data = await apiPost("/api/pause", reason ? { reason } : undefined);
      if (isApiError(data))
        return { content: [{ type: "text", text: extractError(data) }], isError: true };
      return textContent(
        `Планировщик openronin приостановлен.${reason ? ` Причина: ${reason}` : ""}`,
      );
    }

    case "openronin_resume": {
      const data = await apiPost("/api/resume");
      if (isApiError(data))
        return { content: [{ type: "text", text: extractError(data) }], isError: true };
      return textContent("Планировщик openronin возобновлён.");
    }

    case "openronin_cost_today": {
      const data = await apiGet("/api/cost?since=24h");
      if (isApiError(data))
        return { content: [{ type: "text", text: extractError(data) }], isError: true };
      const d = data as {
        since: string;
        total_cost_usd: number;
        total_runs: number;
        by_lane: Array<{ key: string; cost: number; runs: number }>;
        by_engine: Array<{ key: string; cost: number; runs: number }>;
        by_repo: Array<{ key: string; cost: number; runs: number }>;
      };
      const lines = [
        `Расходы openronin за последние 24ч`,
        `  Итого: $${d.total_cost_usd.toFixed(4)} за ${d.total_runs} запусков`,
        "",
      ];
      if (d.by_lane.length > 0) {
        lines.push("По lane:");
        for (const r of d.by_lane)
          lines.push(`  ${r.key}: $${r.cost.toFixed(4)} (${r.runs} запусков)`);
      }
      if (d.by_engine.length > 0) {
        lines.push("\nПо engine:");
        for (const r of d.by_engine)
          lines.push(`  ${r.key}: $${r.cost.toFixed(4)} (${r.runs} запусков)`);
      }
      if (d.by_repo.length > 0) {
        lines.push("\nПо репозиторию:");
        for (const r of d.by_repo)
          lines.push(`  ${r.key}: $${r.cost.toFixed(4)} (${r.runs} запусков)`);
      }
      return textContent(lines.join("\n"));
    }

    case "openronin_create_issue": {
      const body = {
        repo: String(args.repo ?? ""),
        title: String(args.title ?? ""),
        body: args.body ? String(args.body) : undefined,
        label_openronin: Boolean(args.start_now),
      };
      const data = await apiPost("/api/issues", body);
      if (isApiError(data))
        return { content: [{ type: "text", text: extractError(data) }], isError: true };
      const d = data as { issue_url: string; issue_number: number };
      const label = body.label_openronin ? " (openronin:do-it добавлен)" : "";
      return textContent(`Issue #${d.issue_number} создан${label}: ${d.issue_url}`);
    }

    default:
      return {
        content: [{ type: "text", text: `Неизвестный инструмент: ${name}` }],
        isError: true,
      };
  }
}

// ── Main MCP loop ─────────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg: JsonRpcRequest;
  try {
    msg = JSON.parse(trimmed) as JsonRpcRequest;
  } catch {
    process.stderr.write(`[openronin-mcp] Failed to parse: ${trimmed.slice(0, 120)}\n`);
    return;
  }

  const { id, method, params } = msg;
  const isNotification = id === undefined;

  if (method === "initialize") {
    reply(id ?? null, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "openronin-mcp", version: "0.1.0" },
    });
  } else if (method === "notifications/initialized") {
    // no response for notifications
  } else if (method === "tools/list") {
    reply(id ?? null, { tools: TOOLS });
  } else if (method === "tools/call") {
    const toolName = String((params?.name as string | undefined) ?? "");
    const toolArgs = (params?.arguments as Record<string, unknown> | undefined) ?? {};
    handleTool(toolName, toolArgs).then(
      (result) => reply(id ?? null, result),
      (err) => {
        process.stderr.write(`[openronin-mcp] Tool error (${toolName}): ${String(err)}\n`);
        reply(id ?? null, {
          content: [{ type: "text", text: `Ошибка выполнения инструмента: ${String(err)}` }],
          isError: true,
        });
      },
    );
  } else if (!isNotification) {
    replyError(id ?? null, -32601, `Method not found: ${method}`);
  }
});

rl.on("close", () => {
  process.exit(0);
});
