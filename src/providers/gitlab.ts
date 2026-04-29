import { timingSafeEqual } from "node:crypto";
import type { CommentRef, ReviewComment, VcsItem, VcsProvider, VcsRepoRef } from "./vcs.js";

interface GitLabProviderOptions {
  token?: string;
  /** Base URL of the GitLab instance, e.g. https://gitlab.com or https://git.example.com */
  baseUrl?: string;
}

// ---- GitLab REST API shapes ----

interface GitLabIssue {
  iid: number;
  title: string;
  description: string | null;
  author: { username: string };
  state: "opened" | "closed";
  labels: string[];
  created_at: string;
  updated_at: string;
  web_url: string;
}

interface GitLabMR {
  iid: number;
  id: number;
  title: string;
  description: string | null;
  author: { username: string };
  state: "opened" | "closed" | "merged" | "locked";
  labels: string[];
  created_at: string;
  updated_at: string;
  web_url: string;
  sha: string;
  target_branch: string;
  draft?: boolean;
  work_in_progress?: boolean;
  merge_status?: string;
}

interface GitLabNote {
  id: number;
  body: string;
  author: { username: string };
  created_at: string;
  system: boolean;
  web_url?: string;
  position?: {
    new_path?: string;
    new_line?: number;
  };
}

interface GitLabDiscussion {
  id: string;
  individual_note: boolean;
  resolved?: boolean;
  notes: GitLabNote[];
}

interface GitLabPipeline {
  id: number;
  status: string;
}

export class GitlabVcsProvider implements VcsProvider {
  readonly id = "gitlab";
  private readonly token: string;
  private readonly apiBase: string;
  private readonly gqlBase: string;

  /** note_id → discussion_id (populated by listAllPrFeedback) */
  private readonly _noteToDisc = new Map<number, string>();
  /** note_id → { type, iid } (populated by listAllPrFeedback, for emoji reactions) */
  private readonly _noteCtx = new Map<number, { type: "merge_requests" | "issues"; iid: number }>();
  /** repo:number → kind (populated by getItem / listOpenItems) */
  private readonly _kindCache = new Map<string, "issue" | "pull_request">();

  constructor(options: GitLabProviderOptions = {}) {
    const token = options.token ?? process.env.GITLAB_TOKEN;
    if (!token) throw new Error("GitlabVcsProvider requires GITLAB_TOKEN env or options.token");
    const host = (options.baseUrl ?? process.env.GITLAB_HOST ?? "https://gitlab.com").replace(
      /\/$/,
      "",
    );
    this.token = token;
    this.apiBase = `${host}/api/v4`;
    this.gqlBase = `${host}/api/graphql`;
  }

  // ---- internal helpers ----

  private projectId(repo: VcsRepoRef): string {
    return encodeURIComponent(`${repo.owner}/${repo.name}`);
  }

  private kindKey(repo: VcsRepoRef, number: number): string {
    return `${repo.owner}/${repo.name}:${number}`;
  }

  private async apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(`${this.apiBase}${path}`, {
      ...init,
      headers: {
        "PRIVATE-TOKEN": this.token,
        "Content-Type": "application/json",
        ...(init.headers as Record<string, string>),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw Object.assign(
        new Error(`GitLab API ${res.status} ${init.method ?? "GET"} ${path}: ${text}`),
        { status: res.status },
      );
    }
    return res;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.apiFetch(path);
    return res.json() as Promise<T>;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.apiFetch(path, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  private async put<T>(path: string, body: unknown): Promise<T> {
    const res = await this.apiFetch(path, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  private async paginate<T>(path: string): Promise<T[]> {
    const results: T[] = [];
    let page = 1;
    const sep = path.includes("?") ? "&" : "?";
    while (true) {
      const res = await fetch(`${this.apiBase}${path}${sep}per_page=100&page=${page}`, {
        headers: { "PRIVATE-TOKEN": this.token },
      });
      if (!res.ok) break;
      const data = (await res.json()) as T[];
      if (!Array.isArray(data) || data.length === 0) break;
      results.push(...data);
      const next = res.headers.get("x-next-page");
      if (!next) break;
      const nextPage = Number(next);
      if (!Number.isFinite(nextPage)) break;
      page = nextPage;
    }
    return results;
  }

  // ---- VcsProvider interface ----

  async *listOpenItems(repo: VcsRepoRef): AsyncIterable<VcsItem> {
    const pid = this.projectId(repo);
    const issues = await this.paginate<GitLabIssue>(`/projects/${pid}/issues?state=opened`);
    for (const issue of issues) {
      this._kindCache.set(this.kindKey(repo, issue.iid), "issue");
      yield mapGitLabIssue(issue);
    }
    const mrs = await this.paginate<GitLabMR>(`/projects/${pid}/merge_requests?state=opened`);
    for (const mr of mrs) {
      this._kindCache.set(this.kindKey(repo, mr.iid), "pull_request");
      yield mapGitLabMR(mr);
    }
  }

  async getItem(repo: VcsRepoRef, number: number): Promise<VcsItem> {
    const pid = this.projectId(repo);
    // try issue first (iid is shared namespace with MR in GitLab), then MR
    try {
      const issue = await this.get<GitLabIssue>(`/projects/${pid}/issues/${number}`);
      this._kindCache.set(this.kindKey(repo, number), "issue");
      return mapGitLabIssue(issue);
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
    const mr = await this.get<GitLabMR>(`/projects/${pid}/merge_requests/${number}`);
    this._kindCache.set(this.kindKey(repo, number), "pull_request");
    return mapGitLabMR(mr);
  }

  async postComment(repo: VcsRepoRef, number: number, body: string): Promise<CommentRef> {
    const pid = this.projectId(repo);
    const kind = this._kindCache.get(this.kindKey(repo, number));
    const resource =
      kind === "pull_request" ? "merge_requests" : kind === "issue" ? "issues" : null;

    if (resource) {
      const note = await this.post<GitLabNote>(`/projects/${pid}/${resource}/${number}/notes`, {
        body,
      });
      return { id: String(note.id), url: note.web_url ?? "" };
    }

    // kind unknown — try issue first, then MR
    try {
      const note = await this.post<GitLabNote>(`/projects/${pid}/issues/${number}/notes`, { body });
      return { id: String(note.id), url: note.web_url ?? "" };
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
    const note = await this.post<GitLabNote>(`/projects/${pid}/merge_requests/${number}/notes`, {
      body,
    });
    return { id: String(note.id), url: note.web_url ?? "" };
  }

  async updateComment(repo: VcsRepoRef, ref: CommentRef, body: string): Promise<void> {
    const pid = this.projectId(repo);
    // Infer type from ref.url: .../issues/:iid#note_:id or .../merge_requests/:iid#note_:id
    const mrMatch = ref.url.match(/\/merge_requests\/(\d+)#/);
    const issueMatch = ref.url.match(/\/issues\/(\d+)#/);
    if (mrMatch) {
      await this.put(`/projects/${pid}/merge_requests/${mrMatch[1]}/notes/${ref.id}`, { body });
    } else if (issueMatch) {
      await this.put(`/projects/${pid}/issues/${issueMatch[1]}/notes/${ref.id}`, { body });
    }
    // If URL context is missing, skip — updateComment is rarely called and non-critical
  }

  async closeItem(repo: VcsRepoRef, number: number): Promise<void> {
    const pid = this.projectId(repo);
    const kind = this._kindCache.get(this.kindKey(repo, number));
    if (!kind || kind === "issue") {
      try {
        await this.put(`/projects/${pid}/issues/${number}`, { state_event: "close" });
        return;
      } catch (e) {
        if (!isNotFound(e) || kind === "issue") throw e;
      }
    }
    await this.put(`/projects/${pid}/merge_requests/${number}`, { state_event: "close" });
  }

  async listAllPrFeedback(repo: VcsRepoRef, prNumber: number): Promise<ReviewComment[]> {
    const pid = this.projectId(repo);
    const out: ReviewComment[] = [];

    // GitLab discussions contain all notes (regular comments + diff comments + system notes)
    const discussions = await this.paginate<GitLabDiscussion>(
      `/projects/${pid}/merge_requests/${prNumber}/discussions`,
    );

    for (const disc of discussions) {
      for (const note of disc.notes) {
        if (note.system) continue;
        // Cache note metadata for later emoji/reply operations
        this._noteToDisc.set(note.id, disc.id);
        this._noteCtx.set(note.id, { type: "merge_requests", iid: prNumber });

        // Diff-level comments have a position; stand-alone MR comments don't.
        const source: ReviewComment["source"] = note.position
          ? "review_comment"
          : disc.individual_note
            ? "issue_comment"
            : "review";

        out.push({
          id: String(note.id),
          author: note.author.username,
          body: note.body,
          createdAt: note.created_at,
          ...(note.position?.new_path && { path: note.position.new_path }),
          ...(note.position?.new_line != null && { line: note.position.new_line }),
          source,
        });
      }
    }

    out.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    return out;
  }

  verifyWebhookSignature(headers: Record<string, string>, _body: string, secret: string): boolean {
    // GitLab sends a plain shared secret in X-Gitlab-Token, not HMAC.
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
    const token = lower["x-gitlab-token"];
    if (!token) return false;
    try {
      const a = Buffer.from(token, "utf8");
      const b = Buffer.from(secret, "utf8");
      if (a.length !== b.length) return false;
      return timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  // ---- Extended methods for pr_dialog / auto-merge parity ----

  async addReactionToIssue(repo: VcsRepoRef, number: number, content: string): Promise<void> {
    const pid = this.projectId(repo);
    await this.post(`/projects/${pid}/issues/${number}/award_emoji`, {
      name: mapEmoji(content),
    }).catch(() => {});
  }

  async addReactionToComment(repo: VcsRepoRef, noteId: number, content: string): Promise<void> {
    const ctx = this._noteCtx.get(noteId);
    if (!ctx) return; // context not known — skip
    const pid = this.projectId(repo);
    await this.post(`/projects/${pid}/${ctx.type}/${ctx.iid}/notes/${noteId}/award_emoji`, {
      name: mapEmoji(content),
    }).catch(() => {});
  }

  async addReactionToReviewComment(
    repo: VcsRepoRef,
    noteId: number,
    content: string,
  ): Promise<void> {
    return this.addReactionToComment(repo, noteId, content);
  }

  async addLabel(repo: VcsRepoRef, number: number, label: string): Promise<void> {
    const pid = this.projectId(repo);
    const kind = this._kindCache.get(this.kindKey(repo, number));
    const resource = kind === "pull_request" ? "merge_requests" : "issues";
    await this.put(`/projects/${pid}/${resource}/${number}`, { add_labels: label }).catch(() => {});
  }

  async removeLabel(repo: VcsRepoRef, number: number, label: string): Promise<void> {
    const pid = this.projectId(repo);
    const kind = this._kindCache.get(this.kindKey(repo, number));
    const resource = kind === "pull_request" ? "merge_requests" : "issues";
    await this.put(`/projects/${pid}/${resource}/${number}`, {
      remove_labels: label,
    }).catch(() => {});
  }

  async ensureLabelExists(
    repo: VcsRepoRef,
    label: string,
    color = "#5319e7",
    _description = "",
  ): Promise<void> {
    const pid = this.projectId(repo);
    await this.post(`/projects/${pid}/labels`, { name: label, color }).catch(() => {});
  }

  async getPullRequest(
    repo: VcsRepoRef,
    mrNumber: number,
  ): Promise<{
    number: number;
    state: "open" | "closed";
    draft: boolean;
    mergeable: boolean | null;
    mergeableState: string;
    headSha: string;
    baseRef: string;
    nodeId: string;
  }> {
    const pid = this.projectId(repo);
    const mr = await this.get<GitLabMR>(`/projects/${pid}/merge_requests/${mrNumber}`);
    const draft = mr.draft ?? mr.work_in_progress ?? false;
    const mergeStatus = mr.merge_status ?? "unknown";
    return {
      number: mr.iid,
      state: mr.state === "opened" ? "open" : "closed",
      draft,
      mergeable:
        mergeStatus === "can_be_merged" ? true : mergeStatus === "cannot_be_merged" ? false : null,
      mergeableState: mergeStatus,
      headSha: mr.sha,
      baseRef: mr.target_branch,
      nodeId: String(mr.id),
    };
  }

  async getCombinedStatus(repo: VcsRepoRef, ref: string): Promise<string> {
    const pid = this.projectId(repo);
    try {
      const pipelines = await this.get<GitLabPipeline[]>(
        `/projects/${pid}/pipelines?ref=${encodeURIComponent(ref)}&per_page=1`,
      );
      const first = Array.isArray(pipelines) ? pipelines[0] : undefined;
      if (!first) return "no_checks";
      return mapPipelineStatus(first.status);
    } catch {
      return "no_checks";
    }
  }

  async mergePullRequest(
    repo: VcsRepoRef,
    mrNumber: number,
    strategy: "merge" | "squash" | "rebase",
  ): Promise<{ merged: boolean; sha?: string; message?: string }> {
    const pid = this.projectId(repo);
    try {
      const mr = await this.put<GitLabMR>(`/projects/${pid}/merge_requests/${mrNumber}/merge`, {
        squash: strategy === "squash",
        should_remove_source_branch: false,
      });
      return { merged: mr.state === "merged", sha: mr.sha };
    } catch (e) {
      return { merged: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  async markReadyForReview(repo: VcsRepoRef, mrNumber: number): Promise<void> {
    const pid = this.projectId(repo);
    const mr = await this.get<GitLabMR>(`/projects/${pid}/merge_requests/${mrNumber}`);
    let title = mr.title;
    if (title.startsWith("Draft: ")) title = title.slice("Draft: ".length);
    else if (title.startsWith("WIP: ")) title = title.slice("WIP: ".length);
    await this.put(`/projects/${pid}/merge_requests/${mrNumber}`, { title, draft: false });
  }

  /** Returns number of unresolved resolvable discussions. Uses GraphQL (v15+) with REST fallback. */
  async getUnresolvedThreadCount(repo: VcsRepoRef, mrNumber: number): Promise<number> {
    // GraphQL path (GitLab v15+)
    try {
      const query = `query($projectPath: ID!, $mrIid: String!) {
        project(fullPath: $projectPath) {
          mergeRequest(iid: $mrIid) {
            discussions { nodes { resolved resolvable } }
          }
        }
      }`;
      const res = await fetch(this.gqlBase, {
        method: "POST",
        headers: { "PRIVATE-TOKEN": this.token, "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          variables: {
            projectPath: `${repo.owner}/${repo.name}`,
            mrIid: String(mrNumber),
          },
        }),
      });
      if (res.ok) {
        interface GqlResult {
          data?: {
            project?: {
              mergeRequest?: {
                discussions: { nodes: Array<{ resolved: boolean; resolvable: boolean }> };
              };
            };
          };
          errors?: unknown[];
        }
        const data = (await res.json()) as GqlResult;
        if (!data.errors && data.data?.project?.mergeRequest) {
          return data.data.project.mergeRequest.discussions.nodes.filter(
            (n) => n.resolvable && !n.resolved,
          ).length;
        }
      }
    } catch {
      // fall through to REST fallback
    }

    // REST fallback for older GitLab versions
    const pid = this.projectId(repo);
    const discussions = await this.paginate<GitLabDiscussion>(
      `/projects/${pid}/merge_requests/${mrNumber}/discussions`,
    );
    return discussions.filter((d) => !d.individual_note && d.resolved === false).length;
  }

  /** Reply to a discussion thread. Falls back to standalone comment if discussion is unknown. */
  async replyToReviewComment(
    repo: VcsRepoRef,
    mrNumber: number,
    commentId: number,
    body: string,
  ): Promise<CommentRef> {
    const pid = this.projectId(repo);
    const discId = this._noteToDisc.get(commentId);
    if (!discId) {
      // Discussion not in cache — post as standalone MR comment
      return this.postComment(repo, mrNumber, body);
    }
    const note = await this.post<GitLabNote>(
      `/projects/${pid}/merge_requests/${mrNumber}/discussions/${discId}/notes`,
      { body },
    );
    return { id: String(note.id), url: note.web_url ?? "" };
  }

  /** Resolve discussions that contain any of the given note IDs. Returns count resolved. */
  async resolveReviewThreadsForComments(
    repo: VcsRepoRef,
    mrNumber: number,
    commentDatabaseIds: number[],
  ): Promise<number> {
    if (commentDatabaseIds.length === 0) return 0;
    const pid = this.projectId(repo);
    const discIds = new Set<string>();
    for (const id of commentDatabaseIds) {
      const discId = this._noteToDisc.get(id);
      if (discId) discIds.add(discId);
    }
    let resolved = 0;
    for (const discId of discIds) {
      try {
        await this.put(`/projects/${pid}/merge_requests/${mrNumber}/discussions/${discId}`, {
          resolved: true,
        });
        resolved++;
      } catch (e) {
        console.warn("[gitlab] resolveDiscussion failed:", e instanceof Error ? e.message : e);
      }
    }
    return resolved;
  }

  async whoami(): Promise<string> {
    const user = await this.get<{ username: string }>("/user");
    return user.username;
  }
}

// ---- mapping helpers ----

function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { status?: number }).status === 404;
}

function mapGitLabIssue(issue: GitLabIssue): VcsItem {
  return {
    number: issue.iid,
    kind: "issue",
    title: issue.title,
    body: issue.description ?? "",
    author: issue.author.username,
    authorAssociation: "NONE",
    state: issue.state === "opened" ? "open" : "closed",
    labels: issue.labels,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    url: issue.web_url,
  };
}

function mapGitLabMR(mr: GitLabMR): VcsItem {
  return {
    number: mr.iid,
    kind: "pull_request",
    title: mr.title,
    body: mr.description ?? "",
    author: mr.author.username,
    authorAssociation: "NONE",
    state: mr.state === "opened" ? "open" : "closed",
    labels: mr.labels,
    createdAt: mr.created_at,
    updatedAt: mr.updated_at,
    url: mr.web_url,
  };
}

function mapPipelineStatus(status: string): string {
  switch (status) {
    case "success":
      return "success";
    case "failed":
    case "canceled":
      return "failure";
    case "skipped":
      return "success"; // skipped jobs don't block merge
    default:
      return "pending"; // running / pending / preparing / manual / scheduled / created
  }
}

/** Map GitHub reaction names to GitLab emoji names. */
function mapEmoji(reaction: string): string {
  const map: Record<string, string> = {
    "+1": "thumbsup",
    "-1": "thumbsdown",
    laugh: "laughing",
    confused: "confused",
    heart: "heart",
    hooray: "tada",
    rocket: "rocket",
    eyes: "eyes",
  };
  return map[reaction] ?? reaction;
}
