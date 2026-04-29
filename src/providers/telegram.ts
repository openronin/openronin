import type { Db } from "../storage/db.js";
import type { RuntimeConfig } from "../config/schema.js";
import { getRepoId } from "../storage/tasks.js";
import { upsertTask } from "../storage/tasks.js";
import { markDone } from "../scheduler/queue.js";
import { parseTaskText } from "../lib/task-parser.js";
import { BOT_PREFIX } from "../lanes/messages.js";
import type { TrackerProvider, IncomingTask } from "./tracker.js";

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

export interface TelegramIncomingTask extends IncomingTask {
  chatId: number;
}

export class TelegramTrackerProvider implements TrackerProvider {
  readonly id = "telegram";
  private offset = 0;
  private readonly apiBase: string;

  constructor(
    token: string,
    private readonly allowedUserIds: number[],
    private readonly pollTimeoutSeconds = 30,
  ) {
    this.apiBase = `https://api.telegram.org/bot${token}`;
  }

  async *listIncomingTasks(): AsyncIterable<IncomingTask> {
    while (true) {
      const tasks = await this.fetchTasks();
      for (const t of tasks) yield t;
    }
  }

  async getTask(externalId: string): Promise<IncomingTask> {
    throw new Error(`Telegram tasks cannot be retrieved by ID: ${externalId}`);
  }

  // externalId = String(chatId)
  async postUpdate(externalId: string, body: string): Promise<void> {
    await this.sendMessage(Number(externalId), body);
  }

  async updateStatus(_externalId: string, _status: string): Promise<void> {
    // no-op
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    const resp = await fetch(`${this.apiBase}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Telegram sendMessage failed: ${resp.status} ${err}`);
    }
  }

  async fetchTasks(): Promise<TelegramIncomingTask[]> {
    const url = `${this.apiBase}/getUpdates?offset=${this.offset}&timeout=${this.pollTimeoutSeconds}&allowed_updates=%5B%22message%22%5D`;
    const resp = await fetch(url, {
      signal: AbortSignal.timeout((this.pollTimeoutSeconds + 10) * 1000),
    });
    if (!resp.ok) {
      throw new Error(`Telegram getUpdates failed: ${resp.status}`);
    }
    const data = (await resp.json()) as TelegramApiResponse<TelegramUpdate[]>;
    if (!data.ok || !data.result.length) return [];
    this.offset = data.result[data.result.length - 1]!.update_id + 1;
    return data.result.flatMap((upd) => {
      const task = this.updateToTask(upd);
      return task ? [task] : [];
    });
  }

  private updateToTask(upd: TelegramUpdate): TelegramIncomingTask | null {
    const msg = upd.message;
    if (!msg?.text || !msg.from) return null;
    if (this.allowedUserIds.length > 0 && !this.allowedUserIds.includes(msg.from.id)) return null;

    return {
      externalId: `tg_${upd.update_id}`,
      source: "telegram",
      title: (msg.text.split("\n")[0] ?? msg.text).slice(0, 200),
      body: msg.text,
      url: `tg://user?id=${msg.from.id}`,
      createdAt: new Date(msg.date * 1000).toISOString(),
      metadata: {
        chatId: msg.chat.id,
        messageId: msg.message_id,
        userId: msg.from.id,
        username: msg.from.username,
      },
      chatId: msg.chat.id,
    };
  }
}

// Start the long-poll loop as a background async task (fire-and-forget).
export async function startTelegramPoller(
  db: Db,
  getConfig: () => RuntimeConfig,
  token: string,
): Promise<void> {
  const cfg = getConfig().global.telegram;
  const provider = new TelegramTrackerProvider(
    token,
    cfg.allowed_user_ids,
    cfg.poll_timeout_seconds,
  );

  console.log("[telegram] long-poll loop started");

  while (true) {
    try {
      const tasks = await provider.fetchTasks();
      for (const task of tasks) {
        await handleTelegramTask(task, db, getConfig, provider);
      }
    } catch (err) {
      console.error("[telegram] poll error:", err instanceof Error ? err.message : String(err));
      await sleep(5000);
    }
  }
}

async function handleTelegramTask(
  incoming: TelegramIncomingTask,
  db: Db,
  getConfig: () => RuntimeConfig,
  provider: TelegramTrackerProvider,
): Promise<void> {
  const config = getConfig();
  const watchedRepos = config.repos.filter((r) => r.watched);

  const parsed = parseTaskText(incoming.body, watchedRepos);
  if (!parsed.repoKey) {
    const names = watchedRepos.map((r) => `${r.owner}/${r.name}`).join(", ");
    await provider.sendMessage(
      incoming.chatId,
      `${BOT_PREFIX} не удалось определить репозиторий. Укажи repo=owner/name. Доступные: ${names || "(нет)"}`,
    );
    return;
  }

  const [owner, name] = parsed.repoKey.split("/") as [string, string];
  const repoRow = watchedRepos.find((r) => r.owner === owner && r.name === name);
  if (!repoRow) {
    await provider.sendMessage(
      incoming.chatId,
      `${BOT_PREFIX} репозиторий ${parsed.repoKey} не найден в конфиге.`,
    );
    return;
  }

  const repoId = getRepoId(db, { provider: repoRow.provider, owner, name });
  if (repoId === undefined) {
    await provider.sendMessage(
      incoming.chatId,
      `${BOT_PREFIX} репозиторий ${parsed.repoKey} не найден в базе данных.`,
    );
    return;
  }

  try {
    const taskId = upsertTask(db, repoId, incoming.externalId, "telegram_message");
    // Mark done immediately — telegram tasks are created for tracking only, not for VCS lane processing.
    markDone(db, taskId, null);

    const ack = `${BOT_PREFIX} задача принята, repo=${parsed.repoKey}`;
    await provider.sendMessage(incoming.chatId, ack);
    console.log(
      `[telegram] task created: ${incoming.externalId} -> ${parsed.repoKey} "${parsed.title}"`,
    );
  } catch (err) {
    console.error(
      "[telegram] failed to create task:",
      err instanceof Error ? err.message : String(err),
    );
    await provider.sendMessage(
      incoming.chatId,
      `${BOT_PREFIX} ошибка при создании задачи: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
