import { z } from "zod";
import {
  BudgetConfigSchema,
  CharterSchema,
  DirectorAuthoritySchema,
  DirectorModeSchema,
} from "../director/types.js";

// Server config (loaded from env on top, optionally overridden by openronin.yaml/server)
export const ServerConfigSchema = z.object({
  port: z.number().int().positive().default(8090),
  baseUrl: z.string().url().default("http://localhost:8090"),
  adminUser: z.string().default("admin"),
});

// Engine reference (which provider + which model to use for a given job)
export const EngineRefSchema = z.object({
  provider: z.enum(["mimo", "claude_code", "anthropic", "multi_agent"]),
  model: z.string().optional(),
});

// Job-type defaults — used by supervisor when a per-repo override is absent
export const EngineDefaultsSchema = z
  .object({
    triage: EngineRefSchema.default({ provider: "mimo", model: "mimo-v2.5-pro" }),
    analyze: EngineRefSchema.default({ provider: "mimo", model: "mimo-v2.5-pro" }),
    deep_review: EngineRefSchema.default({ provider: "claude_code", model: "sonnet" }),
    patch: EngineRefSchema.default({ provider: "claude_code", model: "sonnet" }),
    pr_dialog: EngineRefSchema.default({ provider: "claude_code", model: "sonnet" }),
    patch_multi: EngineRefSchema.default({ provider: "multi_agent" }),
  })
  .default({});

// Cadence durations — accept "5m" / "1h" / "24h" / "7d"
const DurationStr = z.string().regex(/^\d+[smhd]$/i, "expected duration like 5m / 1h / 24h / 7d");

export const CadenceSchema = z
  .object({
    hot: DurationStr.default("5m"),
    default: DurationStr.default("1h"),
    cold: DurationStr.default("24h"),
  })
  .default({});

// Global config (single file: $OPENRONIN_DATA_DIR/config/openronin.yaml)
export const SchedulerConfigSchema = z
  .object({
    reconcile_interval: DurationStr.default("15m"),
    drain_interval: DurationStr.default("30s"),
    drain_batch_size: z.number().int().positive().default(5),
  })
  .default({});

export const TelegramConfigSchema = z
  .object({
    allowed_user_ids: z.array(z.number().int()).default([]),
    poll_timeout_seconds: z.number().int().positive().default(30),
  })
  .default({});

export const GlobalConfigSchema = z
  .object({
    server: ServerConfigSchema.default({}),
    engines: z
      .object({
        defaults: EngineDefaultsSchema,
      })
      .default({}),
    cadence: CadenceSchema,
    cost_caps: z
      .object({
        per_task_usd: z.number().nonnegative().default(5.0),
        per_day_usd: z.number().nonnegative().default(50.0),
      })
      .default({}),
    // When an engine reports a hard rate-limit (Claude Code 429), pause
    // retrying that task for at least this long. If the engine surfaced an
    // explicit reset moment (e.g. "resets 7am Moscow"), the longer of the
    // two is used. Default 30m so we don't hammer the API while it's down.
    rate_limit_cooldown: DurationStr.default("30m"),
    scheduler: SchedulerConfigSchema,
    telegram: TelegramConfigSchema,
  })
  .default({});

export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

// Jira tracker — optional block inside per-repo YAML config.
// Auth token comes from JIRA_TOKEN env var (never stored in YAML).
export const JiraTrackerConfigSchema = z.object({
  base_url: z.string().url(),
  project_key: z.string().min(1),
  label_filter: z.string().optional(),
  webhook_secret: z.string().optional(),
});

export type JiraTrackerConfig = z.infer<typeof JiraTrackerConfigSchema>;

// Todoist tracker — optional block inside per-repo YAML config.
// Auth token comes from TODOIST_TOKEN env var (never stored in YAML).
export const TodoistTrackerConfigSchema = z.object({
  project_id: z.string().min(1),
  label_filter: z.string().optional(),
  webhook_secret: z.string().optional(),
});

export type TodoistTrackerConfig = z.infer<typeof TodoistTrackerConfigSchema>;

// Per-repo config (one file per repo: $OPENRONIN_DATA_DIR/config/repos/<provider>--<owner>--<name>.yaml)
export const RepoLaneSchema = z.enum([
  "triage",
  "analyze",
  "deep_review",
  "patch",
  "patch_multi",
  "pr_dialog",
]);

export const RepoConfigSchema = z.object({
  provider: z.enum(["github", "gitlab", "gitea"]).default("github"),
  owner: z.string().min(1),
  name: z.string().min(1),
  watched: z.boolean().default(true),
  lanes: z.array(RepoLaneSchema).default(["triage"]),
  cadence: CadenceSchema.optional(),
  protected_labels: z.array(z.string()).default([]),
  skip_authors: z.array(z.string()).default([]),
  allowed_close_reasons: z.array(z.string()).default([]),
  engine_overrides: z
    .object({
      triage: EngineRefSchema.optional(),
      analyze: EngineRefSchema.optional(),
      deep_review: EngineRefSchema.optional(),
      patch: EngineRefSchema.optional(),
      patch_multi: EngineRefSchema.optional(),
      pr_dialog: EngineRefSchema.optional(),
    })
    .default({}),
  prompt_overrides: z.record(z.string(), z.string()).default({}),
  // Patch lane (L3) settings — only consulted when lanes includes "patch".
  patch_trigger_label: z.string().default("openronin:do-it"),
  patch_default_base: z.string().default("main"),
  protected_paths: z
    .array(z.string())
    .default([".github/workflows/", "package-lock.json", "pnpm-lock.yaml", "Cargo.lock", "go.sum"]),
  max_diff_lines: z.number().int().positive().default(500),
  draft_pr: z.boolean().default(true),
  // patch_multi (L6) — multi-agent patch with coder + reviewer critique loop
  patch_multi_max_critique_iterations: z.number().int().min(0).max(5).default(2),
  // PR-dialog (L4)
  pr_dialog_max_iterations: z.number().int().positive().default(10),
  pr_dialog_skip_authors: z.array(z.string()).default(["openronin[bot]"]),
  // Auto-merge (L4.5) — opt-in. When enabled, after a successful pushed
  // iteration with no open agent questions, the system checks PR state
  // (mergeable, no unresolved threads, CI green) and merges + closes.
  auto_merge: z
    .object({
      enabled: z.boolean().default(false),
      strategy: z.enum(["merge", "squash", "rebase"]).default("squash"),
      require_checks_pass: z.boolean().default(true),
      unblock_draft: z.boolean().default(true),
      // When mergeable=false, attempt an automated rebase + agent-driven
      // conflict resolution before bailing. Capped per PR.
      resolve_conflicts: z.boolean().default(true),
      resolve_conflicts_max_attempts: z.number().int().min(0).max(10).default(3),
    })
    .default({}),
  // Deploy (CD) lane — opt-in via non-empty commands list.
  // Continuous-deployment lane.
  //
  //  mode = "disabled" → push events ignored (default, opt-in).
  //  mode = "local"    → commands run on the openronin host itself.
  //                      Used for self-deploy of openronin, or for any
  //                      project hosted on the same machine.
  //  mode = "ssh"      → each command is wrapped in `ssh user@host` and
  //                      executed on the remote target. Use this for
  //                      projects deployed elsewhere.
  //
  //  When mode == "ssh", `ssh.host` must be set (e.g. "deploy@example.com").
  //  `ssh.key_path` is optional — if absent, the default ssh agent /
  //  ~/.ssh/id_* is used. The openronin service runs as the `claude`
  //  user, so any key referenced here must be readable by `claude`.
  deploy: z
    .object({
      mode: z.enum(["disabled", "local", "ssh"]).default("disabled"),
      trigger_branch: z.string().default("main"),
      bot_login: z.string().default("openronin[bot]"),
      require_bot_push: z.boolean().default(true),
      commands: z.array(z.string()).default([]),
      ssh: z
        .object({
          // Username to log in as on the target server (Linux user, NOT a
          // GitHub login). Required.
          user: z.string().min(1),
          // Hostname or IP of the target server. NO 'user@' prefix —
          // the user goes in the field above.
          host: z.string().min(1),
          port: z.number().int().positive().max(65535).default(22),
          key_path: z.string().optional(),
          strict_host_key_checking: z.boolean().default(true),
        })
        .optional(),
    })
    .default({}),
  // Optional Jira tracker integration for this repo's project.
  jira_tracker: JiraTrackerConfigSchema.optional(),
  // Optional Todoist tracker integration for this repo's project.
  todoist_tracker: TodoistTrackerConfigSchema.optional(),
  // Language rules — surface to the agent in every prompt.
  language_for_communication: z.string().default("English"),
  language_for_commits: z.string().default("English"),
  language_for_code_identifiers: z.string().default("English"),
  // Acknowledgment behaviour
  in_progress_label: z.string().default("openronin:in-progress"),
  // Status labels the bot manages on issues / PRs.
  // - awaiting_answer_label: agent posted clarifying questions and is waiting
  //   for a human reply. While set, the analyzer skips re-asking until the
  //   human posts a non-bot comment.
  // - awaiting_action_label: agent finished what it could and now needs the
  //   human to do something (resolve a conflict, take a manual decision,
  //   etc.). pickLane already short-circuits on terminal pr_branches statuses,
  //   so this label is purely informational for the human.
  awaiting_answer_label: z.string().default("openronin:awaiting-answer"),
  awaiting_action_label: z.string().default("openronin:awaiting-action"),
  acknowledge_with_reaction: z.boolean().default(true),
  acknowledge_with_comment: z.boolean().default(true),
  // Director — autonomous PM layer (opt-in per repo). When `enabled: true`
  // and a `charter` is supplied, the openronin-director.service will tick
  // this repo. Without a charter the director silently skips. See
  // docs/DIRECTOR.md for the full schema.
  director: z
    .object({
      enabled: z.boolean().default(false),
      mode: DirectorModeSchema.default("dry_run"),
      cadence_hours: z.number().positive().default(6),
      bot_prefix: z.string().default("👔 director:"),
      charter: CharterSchema.optional(),
      budget: BudgetConfigSchema,
      authority: DirectorAuthoritySchema,
    })
    .default({}),
});

export type RepoConfig = z.infer<typeof RepoConfigSchema>;

// Runtime config — what the daemon holds in memory after loading everything
export const RuntimeConfigSchema = z.object({
  dataDir: z.string(),
  global: GlobalConfigSchema,
  repos: z.array(RepoConfigSchema),
});

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

// Helpers
export function repoKey(repo: Pick<RepoConfig, "provider" | "owner" | "name">): string {
  return `${repo.provider}--${repo.owner}--${repo.name}`;
}

export function repoConfigFilename(repo: Pick<RepoConfig, "provider" | "owner" | "name">): string {
  return `${repoKey(repo)}.yaml`;
}
