import { test } from "node:test";
import assert from "node:assert/strict";

import { GithubVcsProvider } from "../dist/providers/github.js";

const REPO = { owner: "acme", name: "widgets" };

/**
 * listAllPrFeedback() is reused by the analyze lane on issues, where the two PR-only endpoints
 * cannot resolve. Builds a provider whose octokit answers issue comments normally and fails the
 * PR-only calls with the given errors.
 */
function providerWith({ issueComments = [], reviewsError, reviewCommentsError }) {
  const provider = new GithubVcsProvider({ token: "test-token" });

  const listComments = () => "issues.listComments";
  const listReviews = () => "pulls.listReviews";
  const listReviewComments = () => "pulls.listReviewComments";

  provider.octokit = {
    issues: { listComments },
    pulls: { listReviews, listReviewComments },
    paginate: async (endpoint) => {
      if (endpoint === listComments) return issueComments;
      if (endpoint === listReviews) {
        if (reviewsError) throw reviewsError;

        return [];
      }
      if (endpoint === listReviewComments) {
        if (reviewCommentsError) throw reviewCommentsError;

        return [];
      }
      throw new Error("unexpected endpoint");
    },
  };

  return provider;
}

const ISSUE_COMMENT = {
  id: 1,
  user: { login: "maintainer" },
  body: "answers to the questions",
  created_at: "2026-01-01T00:00:00Z",
};

const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

// GitHub answers 404 on /pulls/{n}/reviews but 403 on /pulls/{n}/comments when {n} is an issue —
// the same token reads both fine on a real pull request, so the 403 is not a scope problem.
// Treating it as fatal used to discard the issue comments collected earlier in the same call,
// so an issue thread reached the analyze lane as an empty list on every run.
test("listAllPrFeedback keeps issue comments when the PR-only endpoints reject an issue number", async () => {
  const provider = providerWith({
    issueComments: [ISSUE_COMMENT],
    reviewsError: httpError(404),
    reviewCommentsError: httpError(403),
  });

  const feedback = await provider.listAllPrFeedback(REPO, 222);

  assert.equal(feedback.length, 1);
  assert.equal(feedback[0].source, "issue_comment");
  assert.equal(feedback[0].body, "answers to the questions");
});

test("listAllPrFeedback keeps issue comments when both PR-only endpoints answer 403", async () => {
  const provider = providerWith({
    issueComments: [ISSUE_COMMENT],
    reviewsError: httpError(403),
    reviewCommentsError: httpError(403),
  });

  const feedback = await provider.listAllPrFeedback(REPO, 222);

  assert.equal(feedback.length, 1);
});

// A genuine failure of a PR-only endpoint on a real pull request must still surface: swallowing
// everything would silently drop review feedback the PR dialog depends on.
test("listAllPrFeedback still propagates errors that do not mean 'not a pull request'", async () => {
  const provider = providerWith({
    issueComments: [ISSUE_COMMENT],
    reviewCommentsError: httpError(500),
  });

  await assert.rejects(() => provider.listAllPrFeedback(REPO, 408), /HTTP 500/);
});
