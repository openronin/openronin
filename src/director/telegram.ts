// Director Telegram bridge.
//
// Mirrors the director's chat thread to Telegram for one or more whitelisted
// users, and accepts commands back. Runs in-process inside the
// openronin-director service alongside the tick loop.
//
// Outbound (director → telegram):
//   • Every new `director_messages` row with role='director' or role='system'
//     gets pushed to each whitelisted Telegram chat.
//   • A pending proposal is sent with a reminder ("approve via /approve <id>").
//
// Inbound (telegram → director):
//   • Plain text from a whitelisted user → recorded as a user-role
//     `directive` message in the chat (the next tick consumes it).
//   • Slash commands (whitelist enforced):
//       /status                — director state + last 3 messages
//       /budget                — budget + failure-streak per repo
//       /pending               — list pending decisions
//       /approve <id> [text]   — approve decision, run executor
//       /reject  <id> [text]   — reject decision
//       /pause   <slug>        — pause director on this repo
//       /resume  <slug>        — clear pause flag
//       /repos                 — list director-enabled repos
//       /help                  — usage
//
// Uses its own bot token (OPENRONIN_DIRECTOR_TELEGRAM_TOKEN), distinct from
// the tracker's TELEGRAM_BOT_TOKEN — the tracker accepts task input from a
// chat, the director listens for management commands. Whitelist via
// OPENRONIN_DIRECTOR_TELEGRAM_USER_IDS=12345,67890.

import type { Db } from "../storage/db.js";
import type { RuntimeConfig } from "../config/schema.js";
import { repoKey, type RepoConfig } from "../config/schema.js";
import { appendMessage } from "./chat.js";
import { approveDecision, rejectDecision } from "./executor.js";
import { ensureBudgetState, pause as pauseRepo, unpause as unpauseRepo } from "./budget.js";
import { pendingDecisions, getDecisionById } from "./decisions.js";
import { GithubVcsProvider } from "../providers/github.js";
import type { VcsProvider } from "../providers/vcs.js";

const POLL_TIMEOUT_S = 30;
const MIRROR_INTERVAL_MS = 5_000;

interface TelegramMessage {
  message_id: number;
  from?: { id: number; username?: string; first_name?: string };
  chat: { id: number; type: string };
  text?: string;
  date: number;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

export class DirectorTelegramBridge {
  private offset = 0;
  private lastMirroredMessageId = 0;
  private readonly chatIds = new Set<number>();
  private stopping = false;
  // Aborts the in-flight long-poll on stop() so SIGTERM doesn't have to
  // wait the full 30s POLL_TIMEOUT before the bridge unwinds.
  private pollAbort: AbortController | null = null;
  private readonly api: string;

  constructor(
    private readonly db: Db,
    private readonly getConfig: () => RuntimeConfig,
    private readonly token: string,
    private readonly allowedUserIds: number[],
  ) {
    this.api = `https://api.telegram.org/bot${token}`;
  }

  async start(): Promise<void> {
    // Bootstrap mirror cursor at the highest existing director_messages id —
    // we don't backfill historical chat on restart; new ticks pick up from
    // here. Trade-off: simpler than persisting state, at the cost of
    // missing messages produced while the bridge was offline.
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM director_messages`)
      .get() as { m: number };
    this.lastMirroredMessageId = row.m;
    // eslint-disable-next-line no-console
    console.log(
      `[director-telegram] bridge starting; mirror cursor at message_id=${this.lastMirroredMessageId}; whitelist=${JSON.stringify(this.allowedUserIds)}`,
    );

    void this.runIncomingLoop();
    void this.runMirrorLoop();
  }

  stop(): void {
    this.stopping = true;
    // Abort any in-flight long-poll so the loop unblocks immediately
    // instead of waiting up to 30s for Telegram to time out the poll.
    if (this.pollAbort) {
      try {
        this.pollAbort.abort();
      } catch {
        // best-effort
      }
    }
  }

  // ── Outbound: poll new director_messages → push to telegram ──────────

  private async runMirrorLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.mirrorOnce();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[director-telegram] mirror error:", err);
      }
      await this.interruptibleSleep(MIRROR_INTERVAL_MS);
    }
  }

  // Wakes up early when stop() flips the flag — same pattern as the
  // service-loop sleep in index.ts.
  private async interruptibleSleep(ms: number): Promise<void> {
    let elapsed = 0;
    while (elapsed < ms && !this.stopping) {
      const slice = Math.min(250, ms - elapsed);
      await sleep(slice);
      elapsed += slice;
    }
  }

  private async mirrorOnce(): Promise<void> {
    if (this.chatIds.size === 0) return; // no one to send to yet

    const rows = this.db
      .prepare(
        `SELECT m.id, m.repo_id, m.role, m.type, m.body, m.decision_id,
                r.owner, r.name
         FROM director_messages m
         JOIN repos r ON r.id = m.repo_id
         WHERE m.id > ? AND m.role IN ('director','system')
         ORDER BY m.id ASC LIMIT 20`,
      )
      .all(this.lastMirroredMessageId) as {
      id: number;
      repo_id: number;
      role: string;
      type: string;
      body: string;
      decision_id: number | null;
      owner: string;
      name: string;
    }[];

    for (const r of rows) {
      const text = formatChatMessageForTelegram(r);
      for (const chatId of this.chatIds) {
        try {
          await this.sendMessage(chatId, text);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(`[director-telegram] sendMessage to ${chatId} failed:`, err);
        }
      }
      this.lastMirroredMessageId = r.id;
    }
  }

  // ── Inbound: long-poll telegram updates ──────────────────────────────

  private async runIncomingLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.pollOnce();
      } catch (err) {
        // AbortError from stop() is expected — exit cleanly without logging
        // a scary stack trace.
        if (this.stopping) return;
        // eslint-disable-next-line no-console
        console.error("[director-telegram] poll error:", err);
        await this.interruptibleSleep(5_000);
      }
    }
  }

  private async pollOnce(): Promise<void> {
    const url = `${this.api}/getUpdates?offset=${this.offset}&timeout=${POLL_TIMEOUT_S}&allowed_updates=%5B%22message%22%5D`;
    // Compose AbortSignals: timeout (so we don't hang forever on bad
    // network) AND the bridge's own controller (so stop() can interrupt
    // mid-poll). Whichever fires first aborts the fetch.
    this.pollAbort = new AbortController();
    const timeoutSignal = AbortSignal.timeout((POLL_TIMEOUT_S + 10) * 1000);
    const signal = AbortSignal.any
      ? AbortSignal.any([timeoutSignal, this.pollAbort.signal])
      : this.pollAbort.signal;
    let resp;
    try {
      resp = await fetch(url, { signal });
    } finally {
      this.pollAbort = null;
    }
    if (!resp.ok) {
      throw new Error(`getUpdates ${resp.status}`);
    }
    const data = (await resp.json()) as TelegramApiResponse<TelegramUpdate[]>;
    if (!data.ok) throw new Error(`telegram error: ${data.description}`);
    for (const upd of data.result) {
      this.offset = Math.max(this.offset, upd.update_id + 1);
      const msg = upd.message;
      if (!msg?.text || !msg.from) continue;
      if (!this.allowedUserIds.includes(msg.from.id)) {
        // Silently ignore unauthorized senders. Optional: send a reply
        // saying "not authorized", but that leaks bot existence.
        continue;
      }
      // Remember this chat for mirroring future director output.
      this.chatIds.add(msg.chat.id);
      try {
        await this.handleIncoming(msg);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[director-telegram] handler error:", err);
        await this.sendMessage(
          msg.chat.id,
          `❌ Internal error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private async handleIncoming(msg: TelegramMessage): Promise<void> {
    const text = msg.text!.trim();
    if (text.startsWith("/")) {
      await this.handleCommand(msg, text);
    } else {
      await this.handleFreeText(msg, text);
    }
  }

  // Free-form text from the user → recorded as a `directive` message on
  // the first director-enabled repo (or all of them if multiple). The
  // operator can scope explicitly with `/repos` then prefix in future,
  // but for now we keep it simple.
  private async handleFreeText(msg: TelegramMessage, text: string): Promise<void> {
    const repos = this.directorRepos();
    if (repos.length === 0) {
      await this.sendMessage(msg.chat.id, "No director-enabled repos configured.");
      return;
    }
    // Default to first; support `repo:slug -- text` if they want to be explicit.
    let target = repos[0]!;
    let body = text;
    const m = text.match(/^repo:([^\s]+)\s+--\s+([\s\S]+)$/);
    if (m) {
      const explicit = repos.find((r) => repoKey(r) === m[1]);
      if (!explicit) {
        await this.sendMessage(msg.chat.id, `Unknown repo: ${m[1]}`);
        return;
      }
      target = explicit;
      body = m[2]!;
    }

    const repoId = this.repoIdFor(target);
    if (repoId == null) return;
    appendMessage(this.db, {
      repoId,
      role: "user",
      type: "directive",
      body,
      metadata: { actor: `telegram:${msg.from?.id}`, repo: repoKey(target) },
    });
    await this.sendMessage(
      msg.chat.id,
      `✓ directive recorded on ${repoKey(target)}. Director will pick it up on next tick.`,
    );
  }

  // Slash commands — minimal but covers the management surface.
  private async handleCommand(msg: TelegramMessage, text: string): Promise<void> {
    const [raw, ...args] = text.split(/\s+/);
    const cmd = (raw ?? "").toLowerCase().split("@")[0];
    switch (cmd) {
      case "/start":
      case "/help":
        await this.sendMessage(msg.chat.id, helpText());
        return;
      case "/repos":
        await this.handleRepos(msg);
        return;
      case "/status":
        await this.handleStatus(msg);
        return;
      case "/budget":
        await this.handleBudget(msg);
        return;
      case "/pending":
        await this.handlePending(msg);
        return;
      case "/approve":
        await this.handleApprove(msg, args);
        return;
      case "/reject":
        await this.handleReject(msg, args);
        return;
      case "/pause":
        await this.handlePause(msg, args, true);
        return;
      case "/resume":
        await this.handlePause(msg, args, false);
        return;
      default:
        await this.sendMessage(msg.chat.id, `Unknown command: ${raw}\n\n${helpText()}`);
    }
  }

  // ── Command handlers ────────────────────────────────────────────────

  private async handleRepos(msg: TelegramMessage): Promise<void> {
    const repos = this.directorRepos();
    if (repos.length === 0) {
      await this.sendMessage(msg.chat.id, "No director-enabled repos.");
      return;
    }
    const lines = repos.map((r) => `• ${repoKey(r)} — mode=${r.director?.mode}`);
    await this.sendMessage(msg.chat.id, lines.join("\n"));
  }

  private async handleStatus(msg: TelegramMessage): Promise<void> {
    const repos = this.directorRepos();
    if (repos.length === 0) {
      await this.sendMessage(msg.chat.id, "No director-enabled repos.");
      return;
    }
    const lines: string[] = [];
    for (const r of repos) {
      const id = this.repoIdFor(r);
      if (id == null) continue;
      const state = ensureBudgetState(this.db, id, r.director!.budget);
      const pending = pendingDecisions(this.db, id);
      lines.push(
        `*${repoKey(r)}* — mode=${r.director!.mode}, pending=${pending.length}, ` +
          `streak=${state.failureStreak}, paused=${state.paused}, ` +
          `today=$${state.spentTodayThinkUsd.toFixed(4)} think + $${state.spentTodayUsd.toFixed(2)} project`,
      );
    }
    await this.sendMessage(msg.chat.id, lines.join("\n"));
  }

  private async handleBudget(msg: TelegramMessage): Promise<void> {
    await this.handleStatus(msg);
  }

  private async handlePending(msg: TelegramMessage): Promise<void> {
    const repos = this.directorRepos();
    if (repos.length === 0) {
      await this.sendMessage(msg.chat.id, "No director-enabled repos.");
      return;
    }
    const lines: string[] = [];
    for (const r of repos) {
      const id = this.repoIdFor(r);
      if (id == null) continue;
      const ds = pendingDecisions(this.db, id);
      if (ds.length === 0) continue;
      lines.push(`*${repoKey(r)}*:`);
      for (const d of ds) {
        lines.push(
          `  #${d.id} ${d.decisionType} — ${truncate(d.rationale, 120)}\n  /approve ${d.id}  ·  /reject ${d.id}`,
        );
      }
    }
    await this.sendMessage(
      msg.chat.id,
      lines.length === 0 ? "No pending decisions." : lines.join("\n"),
    );
  }

  private async handleApprove(msg: TelegramMessage, args: string[]): Promise<void> {
    const id = Number(args[0]);
    if (!Number.isFinite(id)) {
      await this.sendMessage(msg.chat.id, "Usage: /approve <decision_id>");
      return;
    }
    const decision = getDecisionById(this.db, id);
    if (!decision) {
      await this.sendMessage(msg.chat.id, `decision #${id} not found`);
      return;
    }
    const repo = this.repoForId(decision.repoId);
    if (!repo) {
      await this.sendMessage(msg.chat.id, `repo for decision #${id} not director-enabled`);
      return;
    }
    const result = await approveDecision({
      db: this.db,
      decisionId: id,
      repo,
      director: repo.director!,
      actor: `telegram:${msg.from?.id}`,
      getVcs: () => this.defaultVcs(repo),
    });
    if (!result.ok) {
      await this.sendMessage(msg.chat.id, `❌ ${result.reason}`);
      return;
    }
    await this.sendMessage(msg.chat.id, `✓ decision #${id} → ${result.outcome}: ${result.details}`);
  }

  private async handleReject(msg: TelegramMessage, args: string[]): Promise<void> {
    const id = Number(args[0]);
    if (!Number.isFinite(id)) {
      await this.sendMessage(msg.chat.id, "Usage: /reject <decision_id> [reason]");
      return;
    }
    const reason = args.slice(1).join(" ").trim() || undefined;
    const decision = getDecisionById(this.db, id);
    if (!decision) {
      await this.sendMessage(msg.chat.id, `decision #${id} not found`);
      return;
    }
    const repo = this.repoForId(decision.repoId);
    if (!repo) {
      await this.sendMessage(msg.chat.id, `repo for decision #${id} not director-enabled`);
      return;
    }
    const result = rejectDecision({
      db: this.db,
      decisionId: id,
      repo,
      actor: `telegram:${msg.from?.id}`,
      reason,
    });
    if (!result.ok) {
      await this.sendMessage(msg.chat.id, `❌ ${result.reason}`);
      return;
    }
    await this.sendMessage(msg.chat.id, `✗ decision #${id} → rejected`);
  }

  private async handlePause(
    msg: TelegramMessage,
    args: string[],
    pauseFlag: boolean,
  ): Promise<void> {
    const slug = args[0];
    if (!slug) {
      await this.sendMessage(msg.chat.id, "Usage: /pause <slug> | /resume <slug>");
      return;
    }
    const repo = this.directorRepos().find((r) => repoKey(r) === slug);
    if (!repo) {
      await this.sendMessage(msg.chat.id, `Unknown repo: ${slug}`);
      return;
    }
    const id = this.repoIdFor(repo);
    if (id == null) return;
    // ensureBudgetState first so the UPDATE in pause/unpause has a row to hit.
    ensureBudgetState(this.db, id, repo.director!.budget);
    if (pauseFlag) {
      pauseRepo(this.db, id, `manual pause via telegram by ${msg.from?.id}`);
      await this.sendMessage(msg.chat.id, `⏸ paused ${slug}`);
    } else {
      unpauseRepo(this.db, id);
      await this.sendMessage(msg.chat.id, `▶ resumed ${slug}`);
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private directorRepos(): RepoConfig[] {
    return this.getConfig().repos.filter((r) => r.director?.enabled && r.director.charter);
  }

  private repoIdFor(repo: RepoConfig): number | null {
    const row = this.db
      .prepare(`SELECT id FROM repos WHERE provider = ? AND owner = ? AND name = ?`)
      .get(repo.provider, repo.owner, repo.name) as { id: number } | undefined;
    return row?.id ?? null;
  }

  private repoForId(repoId: number): RepoConfig | null {
    const row = this.db
      .prepare(`SELECT provider, owner, name FROM repos WHERE id = ?`)
      .get(repoId) as { provider: string; owner: string; name: string } | undefined;
    if (!row) return null;
    return (
      this.directorRepos().find(
        (r) => r.provider === row.provider && r.owner === row.owner && r.name === row.name,
      ) ?? null
    );
  }

  private defaultVcs(repo: RepoConfig): VcsProvider {
    if (repo.provider === "github") return new GithubVcsProvider();
    throw new Error(`Telegram bridge: VcsProvider for ${repo.provider} not wired`);
  }

  private async sendMessage(chatId: number, text: string): Promise<void> {
    const resp = await fetch(`${this.api}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 4000), // Telegram message limit ~4096
        parse_mode: "Markdown",
      }),
    });
    if (!resp.ok) {
      // Markdown parse errors fall through; retry without parse_mode so
      // the user at least sees something.
      const fallback = await fetch(`${this.api}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000) }),
      });
      if (!fallback.ok) {
        throw new Error(`sendMessage ${resp.status}`);
      }
    }
  }
}

// ── Module-level entry point ─────────────────────────────────────────

export function startDirectorTelegramBridgeIfConfigured(
  db: Db,
  getConfig: () => RuntimeConfig,
): DirectorTelegramBridge | null {
  const token = process.env.OPENRONIN_DIRECTOR_TELEGRAM_TOKEN;
  if (!token) return null;
  const idsEnv = process.env.OPENRONIN_DIRECTOR_TELEGRAM_USER_IDS ?? "";
  const allowed = idsEnv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n));
  if (allowed.length === 0) {
    // eslint-disable-next-line no-console
    console.warn(
      "[director-telegram] OPENRONIN_DIRECTOR_TELEGRAM_TOKEN is set but OPENRONIN_DIRECTOR_TELEGRAM_USER_IDS is empty — refusing to start (would accept commands from anyone)",
    );
    return null;
  }
  const bridge = new DirectorTelegramBridge(db, getConfig, token, allowed);
  void bridge.start();
  return bridge;
}

// ── Formatting helpers ───────────────────────────────────────────────

function formatChatMessageForTelegram(m: {
  id: number;
  role: string;
  type: string;
  body: string;
  decision_id: number | null;
  owner: string;
  name: string;
}): string {
  const head = m.role === "system" ? "⚙️" : "👔";
  const tail =
    m.type === "proposal" && m.decision_id != null
      ? `\n\n_/approve ${m.decision_id} · /reject ${m.decision_id}_`
      : "";
  return `${head} *${m.owner}/${m.name}* — _${m.type}_\n\n${m.body}${tail}`;
}

function helpText(): string {
  return [
    "*Director commands:*",
    "/repos — list director-enabled repos",
    "/status — current state per repo",
    "/budget — budget + streaks",
    "/pending — pending decisions awaiting approval",
    "/approve <id> — approve a pending decision",
    "/reject <id> [reason] — reject a pending decision",
    "/pause <slug> — pause director on a repo",
    "/resume <slug> — resume",
    "/help — this message",
    "",
    "_Send any plain text → recorded as a directive on the first director-enabled repo. Prefix with `repo:<slug> -- ` to target a specific one._",
  ].join("\n");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
