import { createHmac, timingSafeEqual } from "node:crypto";
import type { TrackerProvider, IncomingTask } from "./tracker.js";

export interface JiraProviderOptions {
  baseUrl: string;
  token?: string;
  projectKey: string;
  labelFilter?: string;
}

interface JiraIssue {
  id: string;
  key: string;
  self: string;
  fields: {
    summary: string;
    description: string | null;
    created: string;
    labels: string[];
    status: { name: string };
    issuetype: { name: string };
  };
}

interface JiraSearchResponse {
  total: number;
  startAt: number;
  maxResults: number;
  issues: JiraIssue[];
}

function issueUrl(baseUrl: string, key: string): string {
  return `${baseUrl.replace(/\/$/, "")}/browse/${key}`;
}

function mapIssue(baseUrl: string, issue: JiraIssue): IncomingTask {
  return {
    externalId: issue.key,
    source: "jira",
    title: issue.fields.summary,
    body: issue.fields.description ?? "",
    url: issueUrl(baseUrl, issue.key),
    createdAt: issue.fields.created,
    metadata: {
      issueId: issue.id,
      issueType: issue.fields.issuetype.name,
      status: issue.fields.status.name,
      labels: issue.fields.labels,
    },
  };
}

export class JiraTrackerProvider implements TrackerProvider {
  readonly id = "jira";
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly projectKey: string;
  private readonly labelFilter: string | undefined;

  constructor(options: JiraProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token ?? process.env.JIRA_TOKEN ?? "";
    if (!this.token)
      throw new Error("JiraTrackerProvider requires JIRA_TOKEN env or options.token");
    this.projectKey = options.projectKey;
    this.labelFilter = options.labelFilter;
  }

  private get authHeader(): string {
    return `Bearer ${this.token}`;
  }

  private async fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}/rest/api/2${path}`;
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init?.headers as Record<string, string>),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Jira API ${res.status} ${path}: ${text.slice(0, 200)}`);
    }
    return res.json() as Promise<T>;
  }

  async *listIncomingTasks(filter?: Record<string, string>): AsyncIterable<IncomingTask> {
    const jqlParts = [`project = "${this.projectKey}"`, `statusCategory != Done`];
    if (this.labelFilter) jqlParts.push(`labels = "${this.labelFilter}"`);
    if (filter?.label) jqlParts.push(`labels = "${filter.label}"`);
    if (filter?.status) jqlParts.push(`status = "${filter.status}"`);
    const jql = jqlParts.join(" AND ");
    const fields = "summary,description,created,labels,status,issuetype";

    let startAt = 0;
    const maxResults = 50;
    while (true) {
      const data = await this.fetchJson<JiraSearchResponse>(
        `/search?jql=${encodeURIComponent(jql)}&startAt=${startAt}&maxResults=${maxResults}&fields=${fields}`,
      );
      for (const issue of data.issues) {
        yield mapIssue(this.baseUrl, issue);
      }
      startAt += data.issues.length;
      if (startAt >= data.total || data.issues.length === 0) break;
    }
  }

  async getTask(externalId: string): Promise<IncomingTask> {
    const fields = "summary,description,created,labels,status,issuetype";
    const issue = await this.fetchJson<JiraIssue>(`/issue/${externalId}?fields=${fields}`);
    return mapIssue(this.baseUrl, issue);
  }

  async postUpdate(externalId: string, body: string): Promise<void> {
    await this.fetchJson(`/issue/${externalId}/comment`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  }

  async updateStatus(externalId: string, status: string): Promise<void> {
    const { transitions } = await this.fetchJson<{
      transitions: Array<{ id: string; name: string }>;
    }>(`/issue/${externalId}/transitions`);
    const transition = transitions.find((t) => t.name.toLowerCase() === status.toLowerCase());
    if (!transition) throw new Error(`No Jira transition named '${status}' for ${externalId}`);
    await this.fetchJson(`/issue/${externalId}/transitions`, {
      method: "POST",
      body: JSON.stringify({ transition: { id: transition.id } }),
    });
  }

  verifyWebhookSignature(headers: Record<string, string>, body: string, secret: string): boolean {
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
    const sigHeader = lower["x-hub-signature-256"];
    if (!sigHeader?.startsWith("sha256=")) return false;
    const expected = sigHeader.slice("sha256=".length);
    const hmac = createHmac("sha256", secret).update(body).digest("hex");
    if (expected.length !== hmac.length) return false;
    try {
      return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(hmac, "hex"));
    } catch {
      return false;
    }
  }
}
