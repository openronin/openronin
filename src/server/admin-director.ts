// Admin UI for the Director (read-only in foundation phase).
//
// Mounts at /admin/director — list of director-enabled repos — and
// /admin/director/:slug — the chat thread + recent decisions for one repo.
// Two-way chat (HTMX message form, approval buttons) lands in PR #23.

import { Hono } from "hono";
import type { Db } from "../storage/db.js";
import type { RuntimeConfig } from "../config/schema.js";
import { repoKey } from "../config/schema.js";
import { html, isHtmx, page, t as time, type TrustedHtml } from "./layout.js";
import { card } from "./components/card.js";
import { badge, type BadgeTone } from "./components/badge.js";
import { recentMessages } from "../director/chat.js";
import { recentDecisions } from "../director/decisions.js";
import { ensureBudgetState, checkBudgetGate } from "../director/budget.js";
import { latestCharterVersion } from "../director/charter.js";
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
  enabled: boolean;
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
      enabled: d.enabled,
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
    default:
      return "neutral";
  }
}

function renderMessage(m: DirectorMessage): TrustedHtml {
  const isDirector = m.role === "director";
  const isUser = m.role === "user";
  const align = isUser ? "ml-auto" : "";
  const bubble = isDirector
    ? "bg-[var(--surface-2)]"
    : isUser
      ? "bg-[var(--accent-soft)]"
      : "bg-[var(--surface-3)]";
  const speaker = isDirector ? "👔 director" : isUser ? "👤 you" : "⚙️ system";
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
    </div>
  `;
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
      body:
        messages.length === 0
          ? html`<p class="text-sm text-[var(--text-2)]">
              Empty thread. The director will start posting here once it ticks.
            </p>`
          : html` <div class="flex flex-col gap-2">${messages.map(renderMessage)}</div> `,
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

  return app;
}
