import { createHmac, timingSafeEqual } from "node:crypto";
import type { TrackerProvider, IncomingTask } from "./tracker.js";

export interface TodoistProviderOptions {
  token?: string;
  projectId: string;
  labelFilter?: string;
}

interface TodoistTask {
  id: string;
  content: string;
  description: string;
  project_id: string;
  labels: string[];
  url: string;
  created_at: string;
  is_completed: boolean;
  priority: number;
  due?: { date: string; datetime?: string } | null;
}

interface TodoistComment {
  task_id: string;
  content: string;
}

function mapTask(task: TodoistTask): IncomingTask {
  return {
    externalId: task.id,
    source: "todoist",
    title: task.content,
    body: task.description ?? "",
    url: task.url,
    createdAt: task.created_at,
    metadata: {
      projectId: task.project_id,
      labels: task.labels,
      priority: task.priority,
      isCompleted: task.is_completed,
    },
  };
}

const API_BASE = "https://api.todoist.com/rest/v2";

export class TodoistTrackerProvider implements TrackerProvider {
  readonly id = "todoist";
  private readonly token: string;
  private readonly projectId: string;
  private readonly labelFilter: string | undefined;

  constructor(options: TodoistProviderOptions) {
    this.token = options.token ?? process.env.TODOIST_TOKEN ?? "";
    if (!this.token)
      throw new Error("TodoistTrackerProvider requires TODOIST_TOKEN env or options.token");
    this.projectId = options.projectId;
    this.labelFilter = options.labelFilter;
  }

  private get authHeader(): string {
    return `Bearer ${this.token}`;
  }

  private async fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${API_BASE}${path}`;
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
        ...(init?.headers as Record<string, string>),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Todoist API ${res.status} ${path}: ${text.slice(0, 200)}`);
    }
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  async *listIncomingTasks(filter?: Record<string, string>): AsyncIterable<IncomingTask> {
    const params = new URLSearchParams({ project_id: this.projectId });
    const tasks = await this.fetchJson<TodoistTask[]>(`/tasks?${params}`);
    for (const task of tasks) {
      if (task.is_completed) continue;
      const labelToMatch = filter?.label ?? this.labelFilter;
      if (labelToMatch && !task.labels.includes(labelToMatch)) continue;
      yield mapTask(task);
    }
  }

  async getTask(externalId: string): Promise<IncomingTask> {
    const task = await this.fetchJson<TodoistTask>(`/tasks/${externalId}`);
    return mapTask(task);
  }

  async postUpdate(externalId: string, body: string): Promise<void> {
    const comment: TodoistComment = { task_id: externalId, content: body };
    await this.fetchJson("/comments", {
      method: "POST",
      body: JSON.stringify(comment),
    });
  }

  async updateStatus(externalId: string, status: string): Promise<void> {
    const action = status === "done" || status === "closed" ? "close" : "reopen";
    await this.fetchJson(`/tasks/${externalId}/${action}`, { method: "POST" });
  }

  verifyWebhookSignature(headers: Record<string, string>, body: string, secret: string): boolean {
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
    const sigHeader = lower["x-todoist-hmac-sha256"];
    if (!sigHeader) return false;
    const hmac = createHmac("sha256", secret).update(body).digest("base64");
    const sigBuf = Buffer.from(sigHeader, "base64");
    const hmacBuf = Buffer.from(hmac, "base64");
    if (sigBuf.length !== hmacBuf.length) return false;
    try {
      return timingSafeEqual(sigBuf, hmacBuf);
    } catch {
      return false;
    }
  }
}
