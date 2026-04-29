import type { VcsProvider } from "./vcs.js";
import { GithubVcsProvider } from "./github.js";
import { GitlabVcsProvider } from "./gitlab.js";
import type { TrackerProvider } from "./tracker.js";
import { JiraTrackerProvider } from "./jira.js";
import type { JiraProviderOptions } from "./jira.js";
import { TodoistTrackerProvider } from "./todoist.js";
import type { TodoistProviderOptions } from "./todoist.js";

export { GithubVcsProvider } from "./github.js";
export { GitlabVcsProvider } from "./gitlab.js";
export { JiraTrackerProvider } from "./jira.js";
export { TodoistTrackerProvider } from "./todoist.js";
export type { TodoistProviderOptions } from "./todoist.js";
export type { VcsProvider, VcsItem, VcsRepoRef, CommentRef } from "./vcs.js";
export type { TrackerProvider, IncomingTask } from "./tracker.js";
export { TelegramTrackerProvider, startTelegramPoller } from "./telegram.js";
export type { TelegramIncomingTask } from "./telegram.js";

export function getVcsProvider(id: string): VcsProvider {
  switch (id) {
    case "github":
      return new GithubVcsProvider();
    case "gitlab":
      return new GitlabVcsProvider();
    default:
      throw new Error(`Unknown VCS provider: ${id}`);
  }
}

export function getTrackerProvider(
  id: string,
  options: JiraProviderOptions | TodoistProviderOptions,
): TrackerProvider {
  switch (id) {
    case "jira":
      return new JiraTrackerProvider(options as JiraProviderOptions);
    case "todoist":
      return new TodoistTrackerProvider(options as TodoistProviderOptions);
    default:
      throw new Error(`Unknown tracker provider: ${id}`);
  }
}
