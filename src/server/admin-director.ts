// Admin UI for the Director — two-way chat (PR #3b).
//
// Mounts at /admin/director (list) and /admin/director/:slug (per-repo
// timeline + interactions). HTMX-driven; no JS framework.
//
// Interaction surface:
//   POST /admin/director/:slug/messages
//        body: type=directive|answer|veto, body=<text>
//        → appends a user-role message; tick consumes it next cycle.
//   POST /admin/director/:slug/decisions/:id/approve
//        → re-runs authority gate, executes the side-effect, flips
//          outcome to executed (or failed/skipped). Posts a report.
//   POST /admin/director/:slug/decisions/:id/reject
//        body: reason=<optional text>
//        → flips outcome to rejected, records reason as veto message.
//
// Each POST returns an HTMX-swapped fragment of the chat thread so the
// page updates in place without a full reload.

import { Hono } from "hono";
import type { Db } from "../storage/db.js";
import type { RuntimeConfig } from "../config/schema.js";
import { repoKey, type RepoConfig } from "../config/schema.js";
import { html, isHtmx, page, raw, t as time, type TrustedHtml } from "./layout.js";
import { card } from "./components/card.js";
import { badge, type BadgeTone } from "./components/badge.js";
import { appendMessage, recentMessages } from "../director/chat.js";
import { recentDecisions } from "../director/decisions.js";
import { ensureBudgetState, checkBudgetGate } from "../director/budget.js";
import { latestCharterVersion } from "../director/charter.js";
import { approveDecision, rejectDecision } from "../director/executor.js";
import { GithubVcsProvider } from "../providers/github.js";
import type { VcsProvider } from "../providers/vcs.js";
import type { DirectorMessage, MessageType } from "../director/types.js";

interface Args {
  db: Db;
  getConfig: () => RuntimeConfig;
}

type RepoEntry = {
  repoId: number;
  slug: string;
  owner: string;
  name: string;
  mode: string;
  hasCharter: boolean;
};

function listEntries(db: Db, getConfig: () => RuntimeConfig): RepoEntry[] {
  const config = getConfig();
  const idByKey = new Map<string, number>();
  const rows = db
    .prepare(`SELECT id, provider, owner, name FROM repos WHERE watched = 1`)
    .all() as { id: number; provider: string; owner: string; name: string }[];
  for (const r of rows) idByKey.set(`${r.provider}--${r.owner}--${r.name}`, r.id);
  const out: RepoEntry[] = [];
  for (const repo of config.repos) {
    const d = repo.director;
    if (!d || !d.enabled) continue;
    const id = idByKey.get(repoKey(repo));
    if (id === undefined) continue;
    out.push({
      repoId: id,
      slug: repoKey(repo),
      owner: repo.owner,
      name: repo.name,
      mode: d.mode,
      hasCharter: !!d.charter,
    });
  }
  return out;
}

function modeBadgeTone(mode: string): BadgeTone {
  switch (mode) {
    case "full_auto":
      return "danger";
    case "semi_auto":
      return "warning";
    case "propose":
      return "info";
    case "dry_run":
      return "neutral";
    default:
      return "neutral";
  }
}

function messageTypeBadgeTone(type: MessageType): BadgeTone {
  switch (type) {
    case "proposal":
      return "info";
    case "directive":
    case "veto":
      return "warning";
    case "error":
      return "danger";
    case "report":
      return "success";
    case "question":
      return "info";
    default:
      return "neutral";
  }
}

// Did this proposal-type message represent a still-pending decision? If
// the underlying decision has been executed/rejected/etc, we hide the
// approve/reject buttons.
function decisionStillPending(db: Db, decisionId: number | null): boolean {
  if (decisionId == null) return false;
  const row = db
    .prepare(`SELECT outcome FROM director_decisions WHERE id = ?`)
    .get(decisionId) as { outcome: string } | undefined;
  return row?.outcome === "pending";
}

function renderMessage(db: Db, slug: string, m: DirectorMessage): TrustedHtml {
  const isDirector = m.role === "director";
  const isUser = m.role === "user";
  const align = isUser ? "ml-auto" : "";
  const bubble = isDirector
    ? "bg-[var(--surface-2)]"
    : isUser
      ? "bg-[var(--accent-soft)]"
      : "bg-[var(--surface-3)]";
  const speaker = isDirector ? "👔 director" : isUser ? "👤 you" : "⚙️ system";

  const isLiveProposal =
    m.type === "proposal" && decisionStillPending(db, m.decisionId);

  return html`
    <div class="flex flex-col gap-1 max-w-[80ch] ${align}">
      <div class="flex items-center gap-2 text-xs text-[var(--text-2)]">
        <span class="font-mono">${speaker}</span>
        ${badge({ label: m.type, tone: messageTypeBadgeTone(m.type) })}
        <span>${time(m.ts)}</span>
      </div>
      <div
        class="rounded-md border border-[var(--border)] ${bubble} p-3 text-sm whitespace-pre-wrap"
      >
        ${m.body}
      </div>
      ${isLiveProposal && m.decisionId
        ? renderProposalActions(slug, m.decisionId)
        : ""}
    </div>
  `;
}

function renderProposalActions(slug: string, decisionId: number): TrustedHtml {
  return html`
    <div class="flex items-center gap-2 mt-1">
      <button
        class="btn btn-success btn-sm"
        hx-post="/admin/director/${slug}/decisions/${decisionId}/approve"
        hx-target="#chat-thread"
        hx-swap="outerHTML"
        hx-confirm="Approve and execute decision #${decisionId}?"
      >
        ✓ Approve
      </button>
      <button
        class="btn btn-danger btn-sm"
        hx-post="/admin/director/${slug}/decisions/${decisionId}/reject"
        hx-target="#chat-thread"
        hx-swap="outerHTML"
        hx-include="closest div[data-decision-form]"
      >
        ✗ Reject
      </button>
      <input
        type="text"
        name="reason"
        form="reject-form-${decisionId}"
        placeholder="reject reason (optional)"
        class="form-input form-input-sm flex-1 text-xs"
        data-decision-form
      />
    </div>
  `;
}

function renderUserMessageForm(slug: string): TrustedHtml {
  return html`
    <form
      class="flex flex-col gap-2 p-3 border border-[var(--border)] rounded-md bg-[var(--surface-2)]"
      hx-post="/admin/director/${slug}/messages"
      hx-target="#chat-thread"
      hx-swap="outerHTML"
      hx-on::after-request="if(event.detail.successful) this.reset()"
    >
      <div class="flex items-center gap-2 text-xs">
        <label class="text-[var(--text-2)]">Type:</label>
        <select name="type" class="form-select form-select-sm">
          <option value="directive">directive</option>
          <option value="answer">answer</option>
          <option value="veto">veto</option>
        </select>
      </div>
      <textarea
        name="body"
        rows="2"
        required
        placeholder="Write a directive (e.g. 'focus on tests this week') or answer the director's last question."
        class="form-textarea text-sm"
      ></textarea>
      <div>
        <button type="submit" class="btn btn-primary btn-sm">Send</button>
      </div>
    </form>
  `;
}

function renderChatThread(
  db: Db,
  slug: string,
  messages: DirectorMessage[],
): TrustedHtml {
  return html`
    <div id="chat-thread" class="flex flex-col gap-3">
      ${renderUserMessageForm(slug)}
      ${messages.length === 0
        ? html`<p class="text-sm text-[var(--text-2)]">
            Empty thread. The director will start posting here once it ticks.
          </p>`
        : html`<div class="flex flex-col gap-3">
            ${messages.map((m) => renderMessage(db, slug, m))}
          </div>`}
    </div>
  `;
}

function defaultVcsFactory(repo: RepoConfig): VcsProvider {
  switch (repo.provider) {
    case "github":
      return new GithubVcsProvider();
    default:
      throw new Error(`director admin: VcsProvider for ${repo.provider} not wired`);
  }
}

export function directorAdminRoute({ db, getConfig }: Args): Hono {
  const app = new Hono();

  // Index — list of director-enabled repos.
  app.get("/", (c) => {
    const entries = listEntries(db, getConfig);
    const body = html`
      <div class="flex flex-col gap-4">
        ${entries.length === 0
          ? card({
              title: "No director-enabled repos",
              body: html`
                <p class="text-sm text-[var(--text-2)]">
                  Enable the Director on a repo by setting
                  <code class="code-inline">director.enabled: true</code> and providing a
                  <code class="code-inline">director.charter</code> in its YAML config under
                  <code class="code-inline">$OPENRONIN_DATA_DIR/config/repos/</code>. See
                  <a
                    href="https://github.com/openronin/openronin/blob/main/docs/DIRECTOR.md"
                    class="link"
                    >docs/DIRECTOR.md</a
                  >.
                </p>
              `,
            })
          : html`
              <div class="grid gap-3">
                ${entries.map(
                  (e) => html`
                    <a
                      href="/admin/director/${e.slug}"
                      class="card hover:border-[var(--border-strong)]"
                    >
                      <div class="flex items-center justify-between">
                        <div class="flex flex-col">
                          <div class="font-medium">${e.owner}/${e.name}</div>
                          <div class="text-xs text-[var(--text-2)]">${e.slug}</div>
                        </div>
                        <div class="flex items-center gap-2">
                          ${badge({ label: e.mode, tone: modeBadgeTone(e.mode) })}
                          ${e.hasCharter
                            ? badge({ label: "charter", tone: "success" })
                            : badge({ label: "no charter", tone: "warning" })}
                        </div>
                      </div>
                    </a>
                  `,
                )}
              </div>
            `}
      </div>
    `;
    return c.html(
      page({
        title: "Director",
        section: "director",
        body,
        isHtmx: isHtmx(c.req.raw.headers),
        breadcrumb: [{ label: "Director" }],
      }),
    );
  });

  // Detail — chat + decisions for one repo.
  app.get("/:slug", (c) => {
    const slug = c.req.param("slug");
    const entries = listEntries(db, getConfig);
    const entry = entries.find((e) => e.slug === slug);
    if (!entry) return c.notFound();

    const config = getConfig();
    const repo = config.repos.find((r) => repoKey(r) === slug);
    if (!repo || !repo.director) return c.notFound();

    const messages = recentMessages(db, entry.repoId, 100);
    const decisions = recentDecisions(db, entry.repoId, 20);
    const charter = latestCharterVersion(db, entry.repoId);
    const budgetState = ensureBudgetState(db, entry.repoId, repo.director.budget);
    const gate = checkBudgetGate(budgetState, repo.director.budget);

    const charterCard = card({
      title: `Charter${charter ? ` (v${charter.version})` : ""}`,
      body: charter
        ? html`
            <div class="flex flex-col gap-2">
              <div>
                <div class="text-xs text-[var(--text-2)]">Vision</div>
                <div class="text-sm whitespace-pre-wrap">${charter.charter.vision}</div>
              </div>
              <div>
                <div class="text-xs text-[var(--text-2)]">Priorities</div>
                <ul class="text-sm list-disc pl-5">
                  ${charter.charter.priorities.map(
                    (p) =>
                      html`<li>
                        <code class="code-inline">${p.id}</code> (${p.weight.toFixed(2)}) —
                        ${p.rubric}
                      </li>`,
                  )}
                </ul>
              </div>
              ${charter.charter.out_of_bounds.length > 0
                ? html`
                    <div>
                      <div class="text-xs text-[var(--text-2)]">Out of bounds</div>
                      <ul class="text-sm list-disc pl-5">
                        ${charter.charter.out_of_bounds.map((b) => html`<li>${b}</li>`)}
                      </ul>
                    </div>
                  `
                : ""}
            </div>
          `
        : html`<p class="text-sm text-[var(--text-2)]">No charter version captured yet.</p>`,
    });

    const budgetCard = card({
      title: "Budget",
      body: html`
        <table class="data-table text-sm w-full">
          <tbody>
            <tr>
              <td>Mode</td>
              <td>${badge({ label: entry.mode, tone: modeBadgeTone(entry.mode) })}</td>
            </tr>
            <tr>
              <td>Cadence</td>
              <td>${repo.director.cadence_hours}h</td>
            </tr>
            <tr>
              <td>Daily cap</td>
              <td>
                $${budgetState.dailyCapUsd.toFixed(2)} (spent
                $${budgetState.spentTodayUsd.toFixed(2)})
              </td>
            </tr>
            <tr>
              <td>Weekly cap</td>
              <td>
                $${budgetState.weeklyCapUsd.toFixed(2)} (spent
                $${budgetState.spentWeekUsd.toFixed(2)})
              </td>
            </tr>
            <tr>
              <td>Think today</td>
              <td>
                $${budgetState.spentTodayThinkUsd.toFixed(4)} /
                $${repo.director.budget.think_daily_usd.toFixed(2)}
              </td>
            </tr>
            <tr>
              <td>Failure streak</td>
              <td>${budgetState.failureStreak}</td>
            </tr>
            <tr>
              <td>Status</td>
              <td>
                ${gate.ok
                  ? badge({ label: "ok", tone: "success" })
                  : badge({ label: gate.reason, tone: "warning" })}
              </td>
            </tr>
          </tbody>
        </table>
      `,
    });

    const chatCard = card({
      title: `Chat — ${messages.length} message(s)`,
      body: renderChatThread(db, slug, messages),
    });

    const decisionsCard = card({
      title: `Recent decisions — ${decisions.length}`,
      body:
        decisions.length === 0
          ? html`<p class="text-sm text-[var(--text-2)]">No decisions logged yet.</p>`
          : html`
              <table class="data-table text-sm w-full">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Type</th>
                    <th>Outcome</th>
                    <th>Charter</th>
                    <th>Rationale</th>
                  </tr>
                </thead>
                <tbody>
                  ${decisions.map(
                    (d) => html`
                      <tr>
                        <td>${time(d.ts)}</td>
                        <td><code class="code-inline">${d.decisionType}</code></td>
                        <td>
                          ${badge({
                            label: d.outcome,
                            tone:
                              d.outcome === "executed"
                                ? "success"
                                : d.outcome === "failed"
                                  ? "danger"
                                  : d.outcome === "rejected"
                                    ? "warning"
                                    : "neutral",
                          })}
                        </td>
                        <td>${d.charterVersion ? `v${d.charterVersion}` : "—"}</td>
                        <td>${d.rationale}</td>
                      </tr>
                    `,
                  )}
                </tbody>
              </table>
            `,
    });

    const body = html`
      <div class="grid gap-4 lg:grid-cols-3">
        <div class="lg:col-span-1 flex flex-col gap-4">${charterCard} ${budgetCard}</div>
        <div class="lg:col-span-2 flex flex-col gap-4">${chatCard} ${decisionsCard}</div>
      </div>
    `;
    return c.html(
      page({
        title: `Director — ${entry.owner}/${entry.name}`,
        section: "director",
        body,
        isHtmx: isHtmx(c.req.raw.headers),
        breadcrumb: [
          { label: "Director", href: "/admin/director" },
          { label: `${entry.owner}/${entry.name}` },
        ],
      }),
    );
  });

  // ── POST /:slug/messages — user posts a directive/answer/veto ─────────
  app.post("/:slug/messages", async (c) => {
    const slug = c.req.param("slug");
    const entries = listEntries(db, getConfig);
    const entry = entries.find((e) => e.slug === slug);
    if (!entry) return c.notFound();

    const form = await c.req.parseBody();
    const type = String(form.type ?? "directive");
    const body = String(form.body ?? "").trim();
    if (!body) return c.html(raw("body required"), 400);
    if (!["directive", "answer", "veto"].includes(type)) {
      return c.html(raw("invalid type"), 400);
    }

    appendMessage(db, {
      repoId: entry.repoId,
      role: "user",
      type: type as "directive" | "answer" | "veto",
      body,
      metadata: { repo: slug, actor: "admin" },
    });

    const messages = recentMessages(db, entry.repoId, 100);
    return c.html(renderChatThread(db, slug, messages));
  });

  // ── POST /:slug/decisions/:id/approve — execute a pending decision ────
  app.post("/:slug/decisions/:id/approve", async (c) => {
    const slug = c.req.param("slug");
    const decisionId = Number(c.req.param("id"));
    const entries = listEntries(db, getConfig);
    const entry = entries.find((e) => e.slug === slug);
    if (!entry) return c.notFound();

    const config = getConfig();
    const repo = config.repos.find((r) => repoKey(r) === slug);
    if (!repo || !repo.director) return c.notFound();

    await approveDecision({
      db,
      decisionId,
      repo,
      director: repo.director,
      actor: "admin",
      getVcs: () => defaultVcsFactory(repo),
    });

    const messages = recentMessages(db, entry.repoId, 100);
    return c.html(renderChatThread(db, slug, messages));
  });

  // ── POST /:slug/decisions/:id/reject — record reject + reason ─────────
  app.post("/:slug/decisions/:id/reject", async (c) => {
    const slug = c.req.param("slug");
    const decisionId = Number(c.req.param("id"));
    const entries = listEntries(db, getConfig);
    const entry = entries.find((e) => e.slug === slug);
    if (!entry) return c.notFound();

    const config = getConfig();
    const repo = config.repos.find((r) => repoKey(r) === slug);
    if (!repo) return c.notFound();

    const form = await c.req.parseBody();
    const reason = String(form.reason ?? "").trim() || undefined;

    rejectDecision({
      db,
      decisionId,
      repo,
      actor: "admin",
      reason,
    });

    const messages = recentMessages(db, entry.repoId, 100);
    return c.html(renderChatThread(db, slug, messages));
  });

  return app;
}
