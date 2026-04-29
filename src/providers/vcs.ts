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
}
