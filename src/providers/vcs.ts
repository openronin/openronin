export interface VcsRepoRef {
  owner: string;
  name: string;
}

export interface VcsItem {
  number: number;
  kind: "issue" | "pull_request";
  title: string;
  body: string;
  author: string;
  authorAssociation: string;
  state: "open" | "closed";
  // GitHub's `state_reason` for closed issues: "completed" (typically
  // closed by a merged PR) vs "not_planned" / "duplicate". Optional so
  // providers without this field can leave it undefined.
  stateReason?: "completed" | "not_planned" | "reopened" | "duplicate" | string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  url: string;
}

export interface CommentRef {
  id: string;
  url: string;
}

export interface ReviewComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  path?: string;
  line?: number;
  source: "issue_comment" | "review" | "review_comment";
  reviewState?: "approved" | "changes_requested" | "commented" | "dismissed" | "pending";
}

export interface VcsProvider {
  readonly id: string;
  listOpenItems(repo: VcsRepoRef): AsyncIterable<VcsItem>;
  getItem(repo: VcsRepoRef, number: number): Promise<VcsItem>;
  postComment(repo: VcsRepoRef, number: number, body: string): Promise<CommentRef>;
  updateComment(repo: VcsRepoRef, ref: CommentRef, body: string): Promise<void>;
  closeItem(repo: VcsRepoRef, number: number, reason?: string): Promise<void>;
  listAllPrFeedback(repo: VcsRepoRef, prNumber: number): Promise<ReviewComment[]>;
  verifyWebhookSignature(headers: Record<string, string>, body: string, secret: string): boolean;

  // ── Director executor surface ────────────────────────────────────────
  // The Director emits structured decisions (create issue, label, approve,
  // merge, …) which `src/director/executor.ts` carries out via these
  // methods. Implementations should be idempotent on the GitHub side —
  // duplicate calls (e.g. labelling something already labelled) must not
  // throw. The Director additionally guards against double-execution at
  // the decision level (outcome check), but defence-in-depth here is
  // welcome.
  createIssue(
    repo: VcsRepoRef,
    args: { title: string; body?: string; labels?: string[] },
  ): Promise<{ number: number; url: string }>;
  addLabels(repo: VcsRepoRef, number: number, labels: string[]): Promise<void>;
  removeLabels(repo: VcsRepoRef, number: number, labels: string[]): Promise<void>;
  approvePullRequest(repo: VcsRepoRef, prNumber: number, body?: string): Promise<void>;
  mergePullRequest(
    repo: VcsRepoRef,
    prNumber: number,
    strategy: "merge" | "squash" | "rebase",
  ): Promise<{ merged: boolean; sha?: string; message?: string }>;
}
