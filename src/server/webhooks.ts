import { Hono } from "hono";
import type { Db } from "../storage/db.js";
import type { RuntimeConfig } from "../config/schema.js";
import { GithubVcsProvider } from "../providers/github.js";
import { GitlabVcsProvider } from "../providers/gitlab.js";
import { JiraTrackerProvider } from "../providers/jira.js";
import { TodoistTrackerProvider } from "../providers/todoist.js";
import { ensureRepo, upsertTask, upsertJiraTask, upsertTodoistTask } from "../storage/tasks.js";
import { enqueue } from "../scheduler/queue.js";

interface Args {
  db: Db;
  getConfig: () => RuntimeConfig;
  scheduler?: import("../scheduler/index.js").SchedulerHandle;
}

interface GithubIssuePayload {
  action?: string;
  issue?: { number: number; pull_request?: unknown };
  pull_request?: { number: number };
  comment?: { body?: string };
  review?: { body?: string };
  sender?: { login?: string };
  repository?: { name: string; owner: { login: string } };
}

interface GithubPushPayload {
  ref?: string;
  after?: string;
  sender?: { login?: string };
  repository?: { name: string; owner: { login: string } };
}

export function webhooksRoute({ db, getConfig, scheduler }: Args): Hono {
  const app = new Hono();

  app.post("/github/:repoId", async (c) => {
    const repoId = Number(c.req.param("repoId"));
    if (!Number.isFinite(repoId)) return c.json({ error: "invalid repoId" }, 400);

    const secretRow = db
      .prepare("SELECT secret FROM webhook_secrets WHERE repo_id = ?")
      .get(repoId) as { secret: string } | undefined;
    if (!secretRow) return c.json({ error: "no secret registered for this repo" }, 404);

    const body = await c.req.text();
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => {
      headers[key] = value;
    });

    const provider = new GithubVcsProvider();
    if (!provider.verifyWebhookSignature(headers, body, secretRow.secret)) {
      return c.json({ error: "bad signature" }, 401);
    }

    const event = headers["x-github-event"] ?? "";
    let payload: GithubIssuePayload;
    try {
      payload = JSON.parse(body) as GithubIssuePayload;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const config = getConfig();
    const repoCfg = config.repos.find((r) => {
      const expected = `${r.provider}--${r.owner}--${r.name}`;
      const repoRow = db
        .prepare("SELECT id FROM repos WHERE provider = ? AND owner = ? AND name = ?")
        .get(r.provider, r.owner, r.name) as { id: number } | undefined;
      return repoRow?.id === repoId && expected;
    });
    if (!repoCfg) return c.json({ error: "repo not in config" }, 404);

    // Handle push events for the deploy lane before issue/PR routing.
    if (event === "push") {
      const push = payload as unknown as GithubPushPayload;
      const ref = push.ref ?? "";
      const sha = push.after ?? "";
      const senderLogin = push.sender?.login ?? "";
      const deployCfg = repoCfg.deploy;

      if (deployCfg.mode === "disabled") {
        return c.json({ status: "ignored", reason: "deploy disabled" });
      }
      if (!deployCfg.commands.length) {
        return c.json({ status: "ignored", reason: "no deploy commands configured" });
      }
      if (ref !== `refs/heads/${deployCfg.trigger_branch}`) {
        return c.json({ status: "ignored", reason: "not trigger branch" });
      }
      if (deployCfg.require_bot_push && senderLogin !== deployCfg.bot_login) {
        return c.json({ status: "ignored", reason: "not bot push" });
      }
      if (!sha || sha === "0000000000000000000000000000000000000000") {
        return c.json({ status: "ignored", reason: "branch deletion event" });
      }

      const dbRepoId = ensureRepo(db, {
        provider: repoCfg.provider,
        owner: repoCfg.owner,
        name: repoCfg.name,
      });

      const { runDeploy } = await import("../lanes/deploy.js");
      // Track this deploy as an activity so graceful shutdown waits for
      // it before exiting. Otherwise self-deploy of openronin kills
      // its own deploy mid-flight.
      const activityDone = scheduler?.trackActivity(`deploy:${repoCfg.owner}/${repoCfg.name}`);
      runDeploy({
        db,
        repoId: dbRepoId,
        sha,
        branch: deployCfg.trigger_branch,
        triggeredBy: senderLogin,
        commands: deployCfg.commands,
        mode: deployCfg.mode,
        ...(deployCfg.ssh && {
          ssh: {
            user: deployCfg.ssh.user,
            host: deployCfg.ssh.host,
            port: deployCfg.ssh.port,
            keyPath: deployCfg.ssh.key_path,
            strictHostKeyChecking: deployCfg.ssh.strict_host_key_checking,
          },
        }),
      })
        .catch((err: unknown) => {
          console.error("[deploy] unexpected error:", err);
        })
        .finally(() => {
          activityDone?.();
        });

      return c.json({ status: "deploy_started", sha });
    }

    const number = payload.issue?.number ?? payload.pull_request?.number ?? undefined;
    if (!number) return c.json({ status: "ignored", reason: "no issue/pr number" });

    if (!RELEVANT_EVENTS.has(event)) {
      return c.json({ status: "ignored", reason: `event '${event}' not handled` });
    }

    // Drop our own comments / reviews so the bot does not react to itself.
    const candidateBody = payload.comment?.body ?? payload.review?.body ?? "";
    if (candidateBody && (await import("../lanes/messages.js")).isBotMessage(candidateBody)) {
      return c.json({ status: "ignored", reason: "bot self-event" });
    }

    const kind = payload.issue?.pull_request || payload.pull_request ? "pull_request" : "issue";
    const dbRepoId = ensureRepo(db, {
      provider: repoCfg.provider,
      owner: repoCfg.owner,
      name: repoCfg.name,
    });
    const taskId = upsertTask(db, dbRepoId, String(number), kind);
    enqueue(db, taskId, "high", null);

    return c.json({ status: "queued", taskId, event, action: payload.action });
  });

  // -------- GitLab webhook --------
  app.post("/gitlab/:repoId", async (c) => {
    const repoId = Number(c.req.param("repoId"));
    if (!Number.isFinite(repoId)) return c.json({ error: "invalid repoId" }, 400);

    const secretRow = db
      .prepare("SELECT secret FROM webhook_secrets WHERE repo_id = ?")
      .get(repoId) as { secret: string } | undefined;
    if (!secretRow) return c.json({ error: "no secret registered for this repo" }, 404);

    const body = await c.req.text();
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => {
      headers[key] = value;
    });

    const provider = new GitlabVcsProvider();
    if (!provider.verifyWebhookSignature(headers, body, secretRow.secret)) {
      return c.json({ error: "bad signature" }, 401);
    }

    let payload: GitLabWebhookPayload;
    try {
      payload = JSON.parse(body) as GitLabWebhookPayload;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const objectKind = payload.object_kind ?? "";
    if (!GITLAB_RELEVANT_EVENTS.has(objectKind)) {
      return c.json({ status: "ignored", reason: `object_kind '${objectKind}' not handled` });
    }

    // Determine issue/MR iid and kind
    let number: number | undefined;
    let kind: "issue" | "pull_request" = "issue";
    if (objectKind === "merge_request") {
      number = payload.object_attributes?.iid;
      kind = "pull_request";
    } else if (objectKind === "note") {
      const noteable = payload.object_attributes?.noteable_type ?? "";
      number = payload.object_attributes?.noteable_iid;
      kind = noteable === "MergeRequest" ? "pull_request" : "issue";
    } else if (objectKind === "push") {
      // Push events don't map to a single issue/MR — ignore
      return c.json({ status: "ignored", reason: "push events not routed to lanes" });
    }
    if (!number) return c.json({ status: "ignored", reason: "no iid in payload" });

    // Drop bot self-events
    const candidateBody = payload.object_attributes?.note ?? "";
    if (candidateBody && (await import("../lanes/messages.js")).isBotMessage(candidateBody)) {
      return c.json({ status: "ignored", reason: "bot self-event" });
    }

    const config = getConfig();
    const repoRow = db
      .prepare("SELECT provider, owner, name FROM repos WHERE id = ?")
      .get(repoId) as { provider: string; owner: string; name: string } | undefined;
    if (!repoRow) return c.json({ error: "repo not found" }, 404);

    const repoCfg = config.repos.find(
      (r) =>
        r.provider === repoRow.provider && r.owner === repoRow.owner && r.name === repoRow.name,
    );
    if (!repoCfg) return c.json({ error: "repo not in config" }, 404);

    const dbRepoId = ensureRepo(db, {
      provider: repoCfg.provider,
      owner: repoCfg.owner,
      name: repoCfg.name,
    });
    const taskId = upsertTask(db, dbRepoId, String(number), kind);
    enqueue(db, taskId, "high", null);

    return c.json({ status: "queued", taskId, objectKind, number });
  });

  // -------- Jira self-hosted webhook --------
  app.post("/jira/:repoId", async (c) => {
    const repoId = Number(c.req.param("repoId"));
    if (!Number.isFinite(repoId)) return c.json({ error: "invalid repoId" }, 400);

    const body = await c.req.text();
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => {
      headers[key] = value;
    });

    const config = getConfig();
    const repoRow = db
      .prepare("SELECT provider, owner, name FROM repos WHERE id = ?")
      .get(repoId) as { provider: string; owner: string; name: string } | undefined;
    if (!repoRow) return c.json({ error: "repo not found" }, 404);

    const repoCfg = config.repos.find(
      (r) =>
        r.provider === repoRow.provider && r.owner === repoRow.owner && r.name === repoRow.name,
    );
    if (!repoCfg?.jira_tracker)
      return c.json({ error: "no jira_tracker config for this repo" }, 404);

    const { jira_tracker } = repoCfg;
    if (jira_tracker.webhook_secret) {
      const jira = new JiraTrackerProvider({
        baseUrl: jira_tracker.base_url,
        projectKey: jira_tracker.project_key,
        labelFilter: jira_tracker.label_filter,
      });
      if (!jira.verifyWebhookSignature(headers, body, jira_tracker.webhook_secret)) {
        return c.json({ error: "bad signature" }, 401);
      }
    }

    let payload: JiraWebhookPayload;
    try {
      payload = JSON.parse(body) as JiraWebhookPayload;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const event = payload.webhookEvent ?? "";
    if (!JIRA_RELEVANT_EVENTS.has(event)) {
      return c.json({ status: "ignored", reason: `event '${event}' not handled` });
    }

    const issueKey = payload.issue?.key;
    if (!issueKey) return c.json({ status: "ignored", reason: "no issue key" });

    // Drop bot's own comments so the bot does not react to itself.
    if (event === "jira:issue_commented") {
      const commentBody = payload.comment?.body ?? "";
      if ((await import("../lanes/messages.js")).isBotMessage(commentBody)) {
        return c.json({ status: "ignored", reason: "bot self-event" });
      }
    }

    const dbRepoId = ensureRepo(db, {
      provider: repoCfg.provider,
      owner: repoCfg.owner,
      name: repoCfg.name,
    });
    const taskId = upsertJiraTask(db, dbRepoId, issueKey);
    enqueue(db, taskId, event === "jira:issue_created" ? "high" : "normal", null);

    return c.json({ status: "queued", taskId, event, issueKey });
  });

  // -------- Todoist webhook --------
  app.post("/todoist/:repoId", async (c) => {
    const repoId = Number(c.req.param("repoId"));
    if (!Number.isFinite(repoId)) return c.json({ error: "invalid repoId" }, 400);

    const body = await c.req.text();
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => {
      headers[key] = value;
    });

    const config = getConfig();
    const repoRow = db
      .prepare("SELECT provider, owner, name FROM repos WHERE id = ?")
      .get(repoId) as { provider: string; owner: string; name: string } | undefined;
    if (!repoRow) return c.json({ error: "repo not found" }, 404);

    const repoCfg = config.repos.find(
      (r) =>
        r.provider === repoRow.provider && r.owner === repoRow.owner && r.name === repoRow.name,
    );
    if (!repoCfg?.todoist_tracker)
      return c.json({ error: "no todoist_tracker config for this repo" }, 404);

    const { todoist_tracker } = repoCfg;
    if (todoist_tracker.webhook_secret) {
      const todoist = new TodoistTrackerProvider({
        projectId: todoist_tracker.project_id,
        labelFilter: todoist_tracker.label_filter,
      });
      if (!todoist.verifyWebhookSignature(headers, body, todoist_tracker.webhook_secret)) {
        return c.json({ error: "bad signature" }, 401);
      }
    }

    let payload: TodoistWebhookPayload;
    try {
      payload = JSON.parse(body) as TodoistWebhookPayload;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const event = payload.event_name ?? "";
    if (!TODOIST_RELEVANT_EVENTS.has(event)) {
      return c.json({ status: "ignored", reason: `event '${event}' not handled` });
    }

    // For note:added, item id is in event_data.item_id; otherwise event_data.id
    const taskId =
      event === "note:added"
        ? (payload.event_data?.item_id ?? payload.event_data?.id)
        : payload.event_data?.id;
    if (!taskId) return c.json({ status: "ignored", reason: "no task id in payload" });

    // Filter by configured project
    const payloadProjectId = payload.event_data?.project_id;
    if (payloadProjectId && payloadProjectId !== todoist_tracker.project_id) {
      return c.json({ status: "ignored", reason: "project_id mismatch" });
    }

    // Filter by label if configured
    if (todoist_tracker.label_filter && event !== "note:added") {
      const labels: string[] = payload.event_data?.labels ?? [];
      if (!labels.includes(todoist_tracker.label_filter)) {
        return c.json({ status: "ignored", reason: "label_filter mismatch" });
      }
    }

    // Drop bot self-comments on note:added
    if (event === "note:added") {
      const noteContent = payload.event_data?.content ?? "";
      if ((await import("../lanes/messages.js")).isBotMessage(noteContent)) {
        return c.json({ status: "ignored", reason: "bot self-event" });
      }
    }

    const dbRepoId = ensureRepo(db, {
      provider: repoCfg.provider,
      owner: repoCfg.owner,
      name: repoCfg.name,
    });
    const dbTaskId = upsertTodoistTask(db, dbRepoId, String(taskId));
    enqueue(db, dbTaskId, event === "item:added" ? "high" : "normal", null);

    return c.json({ status: "queued", taskId: dbTaskId, event, todoistTaskId: taskId });
  });

  // Health/probe path so you can curl-check it without a real signature
  app.get("/", (c) => c.json({ ok: true, providers: ["github", "gitlab", "jira", "todoist"] }));

  return app;
}

const RELEVANT_EVENTS = new Set([
  "issues",
  "issue_comment",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
]);

interface GitLabWebhookPayload {
  object_kind?: string;
  object_attributes?: {
    iid?: number;
    noteable_type?: string;
    noteable_iid?: number;
    note?: string;
    action?: string;
  };
}

const GITLAB_RELEVANT_EVENTS = new Set(["merge_request", "note", "push"]);

interface JiraWebhookPayload {
  webhookEvent?: string;
  issue?: { key: string; id: string; fields?: Record<string, unknown> };
  comment?: { body?: string; id?: string };
}

const JIRA_RELEVANT_EVENTS = new Set([
  "jira:issue_created",
  "jira:issue_updated",
  "jira:issue_commented",
]);

interface TodoistWebhookPayload {
  event_name?: string;
  event_data?: {
    id?: string;
    item_id?: string;
    project_id?: string;
    content?: string;
    labels?: string[];
  };
}

const TODOIST_RELEVANT_EVENTS = new Set(["item:added", "item:updated", "note:added"]);
