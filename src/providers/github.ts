import { Octokit } from "@octokit/rest";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { CommentRef, ReviewComment, VcsItem, VcsProvider, VcsRepoRef } from "./vcs.js";

export type ReactionContent =
  | "+1"
  | "-1"
  | "laugh"
  | "confused"
  | "heart"
  | "hooray"
  | "rocket"
  | "eyes";

const ResilientOctokit = Octokit.plugin(retry, throttling);

interface GithubProviderOptions {
  token?: string;
  userAgent?: string;
}

export class GithubVcsProvider implements VcsProvider {
  readonly id = "github";
  private readonly octokit: InstanceType<typeof ResilientOctokit>;

  constructor(options: GithubProviderOptions = {}) {
    const token = options.token ?? process.env.GITHUB_TOKEN;
    if (!token) {
      throw new Error("GithubVcsProvider requires GITHUB_TOKEN env or options.token");
    }
    this.octokit = new ResilientOctokit({
      auth: token,
      userAgent: options.userAgent ?? "openronin/0.0.1",
      throttle: {
        onRateLimit: (retryAfter, options, _o, retryCount) => {
          console.warn(
            `[github] rate-limited on ${options.method} ${options.url} — retrying in ${retryAfter}s (attempt ${retryCount})`,
          );
          return retryCount < 1;
        },
        onSecondaryRateLimit: (retryAfter, options, _o, retryCount) => {
          console.warn(
            `[github] secondary rate-limit on ${options.method} ${options.url} — retrying in ${retryAfter}s (attempt ${retryCount})`,
          );
          return retryCount < 1;
        },
      },
      retry: { doNotRetry: ["422"] },
    });
  }

  async *listOpenItems(repo: VcsRepoRef): AsyncIterable<VcsItem> {
    const iterator = this.octokit.paginate.iterator(this.octokit.issues.listForRepo, {
      owner: repo.owner,
      repo: repo.name,
      state: "open",
      per_page: 100,
    });
    for await (const page of iterator) {
      for (const raw of page.data) {
        yield mapIssue(raw);
      }
    }
  }

  async getItem(repo: VcsRepoRef, number: number): Promise<VcsItem> {
    const { data } = await this.octokit.issues.get({
      owner: repo.owner,
      repo: repo.name,
      issue_number: number,
    });
    return mapIssue(data);
  }

  async postComment(repo: VcsRepoRef, number: number, body: string): Promise<CommentRef> {
    const { data } = await this.octokit.issues.createComment({
      owner: repo.owner,
      repo: repo.name,
      issue_number: number,
      body,
    });
    return { id: String(data.id), url: data.html_url };
  }

  async updateComment(repo: VcsRepoRef, ref: CommentRef, body: string): Promise<void> {
    await this.octokit.issues.updateComment({
      owner: repo.owner,
      repo: repo.name,
      comment_id: Number(ref.id),
      body,
    });
  }

  async closeItem(repo: VcsRepoRef, number: number, reason?: string): Promise<void> {
    await this.octokit.issues.update({
      owner: repo.owner,
      repo: repo.name,
      issue_number: number,
      state: "closed",
      ...(reason && { state_reason: reason as "completed" | "not_planned" | "reopened" }),
    });
  }

  async addReactionToIssue(
    repo: VcsRepoRef,
    number: number,
    content: ReactionContent,
  ): Promise<void> {
    await this.octokit.reactions.createForIssue({
      owner: repo.owner,
      repo: repo.name,
      issue_number: number,
      content,
    });
  }

  async addReactionToComment(
    repo: VcsRepoRef,
    commentId: number,
    content: ReactionContent,
  ): Promise<void> {
    await this.octokit.reactions.createForIssueComment({
      owner: repo.owner,
      repo: repo.name,
      comment_id: commentId,
      content,
    });
  }

  async addReactionToReviewComment(
    repo: VcsRepoRef,
    commentId: number,
    content: ReactionContent,
  ): Promise<void> {
    await this.octokit.reactions.createForPullRequestReviewComment({
      owner: repo.owner,
      repo: repo.name,
      comment_id: commentId,
      content,
    });
  }

  async addLabel(repo: VcsRepoRef, number: number, label: string): Promise<void> {
    await this.octokit.issues.addLabels({
      owner: repo.owner,
      repo: repo.name,
      issue_number: number,
      labels: [label],
    });
  }

  async removeLabel(repo: VcsRepoRef, number: number, label: string): Promise<void> {
    try {
      await this.octokit.issues.removeLabel({
        owner: repo.owner,
        repo: repo.name,
        issue_number: number,
        name: label,
      });
    } catch (error) {
      // 404 = label wasn't there; ignore.
      if (error instanceof Error && /\b404\b/.test(error.message)) return;
      throw error;
    }
  }

  // Full PR metadata including files changed — used by the re-open detection in analyze lane.
  async getPullRequestMeta(
    repo: VcsRepoRef,
    prNumber: number,
  ): Promise<{
    number: number;
    title: string;
    url: string;
    state: string;
    merged: boolean;
    mergeCommitSha: string | null;
    body: string;
    filesChanged: string[];
  }> {
    const [{ data: pr }, files] = await Promise.all([
      this.octokit.pulls.get({
        owner: repo.owner,
        repo: repo.name,
        pull_number: prNumber,
      }),
      this.octokit.paginate(this.octokit.pulls.listFiles, {
        owner: repo.owner,
        repo: repo.name,
        pull_number: prNumber,
        per_page: 100,
      }),
    ]);
    return {
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      state: pr.state,
      merged: Boolean(pr.merged),
      mergeCommitSha: pr.merge_commit_sha ?? null,
      body: pr.body ?? "",
      filesChanged: files.map((f) => f.filename),
    };
  }

  // Full PR record (mergeable, draft, head sha, etc).
  async getPullRequest(
    repo: VcsRepoRef,
    prNumber: number,
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
    const { data } = await this.octokit.pulls.get({
      owner: repo.owner,
      repo: repo.name,
      pull_number: prNumber,
    });
    return {
      number: data.number,
      state: (data.state as "open" | "closed") ?? "open",
      draft: Boolean(data.draft),
      mergeable: data.mergeable ?? null,
      mergeableState: data.mergeable_state ?? "unknown",
      headSha: data.head.sha,
      baseRef: data.base.ref,
      nodeId: data.node_id,
    };
  }

  // Combined status for a commit. Returns 'success' / 'pending' / 'failure' /
  // 'error' or 'no_checks' if neither commit statuses nor check runs exist.
  async getCombinedStatus(repo: VcsRepoRef, ref: string): Promise<string> {
    const [{ data: status }, { data: checks }] = await Promise.all([
      this.octokit.repos.getCombinedStatusForRef({
        owner: repo.owner,
        repo: repo.name,
        ref,
      }),
      this.octokit.checks.listForRef({
        owner: repo.owner,
        repo: repo.name,
        ref,
        per_page: 100,
      }),
    ]);
    const hasStatuses = status.total_count > 0;
    const hasChecks = checks.total_count > 0;
    if (!hasStatuses && !hasChecks) return "no_checks";

    let aggregate = "success";
    if (hasStatuses) aggregate = status.state; // success / pending / failure
    if (hasChecks) {
      for (const r of checks.check_runs) {
        if (r.status !== "completed") {
          aggregate = "pending";
        } else if (
          r.conclusion === "failure" ||
          r.conclusion === "cancelled" ||
          r.conclusion === "timed_out"
        ) {
          return "failure";
        } else if (r.conclusion === "action_required") {
          return "failure";
        }
      }
    }
    return aggregate;
  }

  // Merge a PR. Strategy: merge / squash / rebase.
  async mergePullRequest(
    repo: VcsRepoRef,
    prNumber: number,
    strategy: "merge" | "squash" | "rebase",
  ): Promise<{ merged: boolean; sha?: string; message?: string }> {
    const { data } = await this.octokit.pulls.merge({
      owner: repo.owner,
      repo: repo.name,
      pull_number: prNumber,
      merge_method: strategy,
    });
    return {
      merged: Boolean(data.merged),
      ...(data.sha != null && { sha: data.sha }),
      ...(data.message != null && { message: data.message }),
    };
  }

  // Promote a draft PR to ready-for-review via GraphQL.
  async markReadyForReview(repo: VcsRepoRef, prNumber: number): Promise<void> {
    const pr = await this.getPullRequest(repo, prNumber);
    await this.octokit.graphql(
      `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }`,
      { id: pr.nodeId },
    );
  }

  // Number of unresolved review threads on the PR.
  async getUnresolvedThreadCount(repo: VcsRepoRef, prNumber: number): Promise<number> {
    const result = await this.octokit.graphql<{
      repository: {
        pullRequest: {
          reviewThreads: { nodes: Array<{ isResolved: boolean }> };
        };
      };
    }>(
      `query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            reviewThreads(first: 100) { nodes { isResolved } }
          }
        }
      }`,
      { owner: repo.owner, repo: repo.name, number: prNumber },
    );
    return result.repository.pullRequest.reviewThreads.nodes.filter((t) => !t.isResolved).length;
  }

  // List pull-request reviews including PENDING (drafts only visible to the
  // user who started them; we authenticate as that user via the PAT).
  async listPrReviews(
    repo: VcsRepoRef,
    prNumber: number,
  ): Promise<
    Array<{ id: number; state: string; user: string; submittedAt: string | null; body: string }>
  > {
    const all = await this.octokit.paginate(this.octokit.pulls.listReviews, {
      owner: repo.owner,
      repo: repo.name,
      pull_number: prNumber,
      per_page: 100,
    });
    return all.map((r) => ({
      id: r.id,
      state: r.state,
      user: r.user?.login ?? "unknown",
      submittedAt: r.submitted_at ?? null,
      body: r.body ?? "",
    }));
  }

  // Reply to an inline review comment, threading under it.
  async replyToReviewComment(
    repo: VcsRepoRef,
    prNumber: number,
    commentId: number,
    body: string,
  ): Promise<CommentRef> {
    const { data } = await this.octokit.pulls.createReplyForReviewComment({
      owner: repo.owner,
      repo: repo.name,
      pull_number: prNumber,
      comment_id: commentId,
      body,
    });
    return { id: String(data.id), url: data.html_url };
  }

  // Resolve PR review threads that contain any of the given comment database
  // IDs. The REST API does not expose thread resolution; we use GraphQL.
  async resolveReviewThreadsForComments(
    repo: VcsRepoRef,
    prNumber: number,
    commentDatabaseIds: number[],
  ): Promise<number> {
    if (commentDatabaseIds.length === 0) return 0;
    const ids = new Set(commentDatabaseIds);
    interface ThreadNode {
      id: string;
      isResolved: boolean;
      comments: { nodes: Array<{ databaseId: number }> };
    }
    const result = await this.octokit.graphql<{
      repository: { pullRequest: { reviewThreads: { nodes: ThreadNode[] } } };
    }>(
      `query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            reviewThreads(first: 100) {
              nodes {
                id
                isResolved
                comments(first: 50) { nodes { databaseId } }
              }
            }
          }
        }
      }`,
      { owner: repo.owner, repo: repo.name, number: prNumber },
    );
    const threads = result.repository.pullRequest.reviewThreads.nodes.filter(
      (t) => !t.isResolved && t.comments.nodes.some((c) => ids.has(c.databaseId)),
    );
    let resolved = 0;
    for (const t of threads) {
      try {
        await this.octokit.graphql(
          `mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }`,
          { id: t.id },
        );
        resolved++;
      } catch (error) {
        console.warn(
          "[github] resolveReviewThread failed:",
          error instanceof Error ? error.message : error,
        );
      }
    }
    return resolved;
  }

  async ensureLabelExists(
    repo: VcsRepoRef,
    label: string,
    color = "5319e7",
    description = "",
  ): Promise<void> {
    try {
      await this.octokit.issues.getLabel({ owner: repo.owner, repo: repo.name, name: label });
    } catch {
      try {
        await this.octokit.issues.createLabel({
          owner: repo.owner,
          repo: repo.name,
          name: label,
          color,
          description,
        });
      } catch {
        // best-effort; not having the label set isn't fatal
      }
    }
  }

  // Aggregate all human-readable feedback on a PR: issue-comments, review summaries, and inline review comments.
  // Sorted oldest first.
  async listAllPrFeedback(repo: VcsRepoRef, prNumber: number): Promise<ReviewComment[]> {
    const out: ReviewComment[] = [];

    const issueComments = await this.octokit.paginate(this.octokit.issues.listComments, {
      owner: repo.owner,
      repo: repo.name,
      issue_number: prNumber,
      per_page: 100,
    });
    for (const c of issueComments) {
      out.push({
        id: String(c.id),
        author: c.user?.login ?? "unknown",
        body: c.body ?? "",
        createdAt: c.created_at,
        source: "issue_comment",
      });
    }

    // PR-only endpoints: 404 if `prNumber` is actually an issue. The method is reused by the
    // analyze lane on issues, so swallow 404s and return whatever issue-level comments we got.
    try {
      const reviews = await this.octokit.paginate(this.octokit.pulls.listReviews, {
        owner: repo.owner,
        repo: repo.name,
        pull_number: prNumber,
        per_page: 100,
      });
      for (const r of reviews) {
        if (!r.body && r.state !== "APPROVED" && r.state !== "CHANGES_REQUESTED") continue;
        out.push({
          id: String(r.id),
          author: r.user?.login ?? "unknown",
          body: r.body ?? "",
          createdAt: r.submitted_at ?? new Date().toISOString(),
          source: "review",
          reviewState: mapReviewState(r.state),
        });
      }
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    try {
      const reviewComments = await this.octokit.paginate(this.octokit.pulls.listReviewComments, {
        owner: repo.owner,
        repo: repo.name,
        pull_number: prNumber,
        per_page: 100,
      });
      for (const c of reviewComments) {
        out.push({
          id: String(c.id),
          author: c.user?.login ?? "unknown",
          body: c.body,
          createdAt: c.created_at,
          path: c.path,
          line: c.line ?? c.original_line ?? undefined,
          source: "review_comment",
        });
      }
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    out.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    return out;
  }

  verifyWebhookSignature(headers: Record<string, string>, body: string, secret: string): boolean {
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
    const sigHeader = lower["x-hub-signature-256"];
    if (!sigHeader || !sigHeader.startsWith("sha256=")) return false;
    const expected = sigHeader.slice("sha256=".length);
    const hmac = createHmac("sha256", secret).update(body).digest("hex");
    if (expected.length !== hmac.length) return false;
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(hmac, "hex"));
  }

  async createIssue(
    repo: VcsRepoRef,
    args: { title: string; body?: string; labels?: string[] },
  ): Promise<{ number: number; url: string }> {
    const { data } = await this.octokit.issues.create({
      owner: repo.owner,
      repo: repo.name,
      title: args.title,
      body: args.body ?? "",
      labels: args.labels ?? [],
    });
    return { number: data.number, url: data.html_url };
  }

  async whoami(): Promise<string> {
    const { data } = await this.octokit.users.getAuthenticated();
    return data.login;
  }
}

interface RawIssue {
  number: number;
  title: string;
  body?: string | null;
  user: { login: string } | null;
  author_association?: string;
  state: string;
  labels: Array<string | { name?: string }>;
  created_at: string;
  updated_at: string;
  html_url: string;
  pull_request?: unknown;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { status?: number }).status === 404
  );
}

function mapReviewState(state: string | null | undefined): ReviewComment["reviewState"] {
  switch (state) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "COMMENTED":
      return "commented";
    case "DISMISSED":
      return "dismissed";
    case "PENDING":
      return "pending";
    default:
      return undefined;
  }
}

function mapIssue(raw: RawIssue): VcsItem {
  return {
    number: raw.number,
    kind: raw.pull_request ? "pull_request" : "issue",
    title: raw.title,
    body: raw.body ?? "",
    author: raw.user?.login ?? "unknown",
    authorAssociation: raw.author_association ?? "NONE",
    state: raw.state === "open" ? "open" : "closed",
    labels: raw.labels.map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean),
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    url: raw.html_url,
  };
}
