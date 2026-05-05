// Admin UI for the Director — classic-chat layout.
//
// Mounts at /admin/director (list) and /admin/director/:slug (per-repo
// timeline + interactions). HTMX-driven; no JS framework.
//
// Layout: messages render top-to-bottom by timestamp (oldest at top, newest
// at bottom). The composer sits at the bottom under the thread, typewriter-
// style. After every HTMX swap the JS scrolls the thread to the latest
// message. Repetitive `tick_log` / system-noise messages are collapsed into
// a single "show N system events" disclosure to keep the human-readable
// signal in focus.
//
// Markdown is rendered with `marked` (CDN) and sanitised through DOMPurify
// before insertion. Done client-side post-render rather than server-side
// because (a) markdown lives in untrusted LLM output, (b) DOMPurify handles
// the XSS gauntlet better than handrolled escaping, (c) keeps the server
// hot path Hono-string-only.
//
// Interaction surface (POST):
//   /:slug/messages
//   /:slug/decisions/:id/approve
//   /:slug/decisions/:id/reject

import { Hono } from "hono";
import type { Db } from "../storage/db.js";
import type { RuntimeConfig } from "../config/schema.js";
import { repoKey, type RepoConfig } from "../config/schema.js";
import { html, isHtmx, page, raw, t as time, type TrustedHtml } from "./layout.js";
import { card } from "./components/card.js";
import { badge, type BadgeTone } from "./components/badge.js";
import { appendMessage, recentMessages, unansweredUserDirectives } from "../director/chat.js";
import { recentDecisions } from "../director/decisions.js";
import { ensureBudgetState, checkBudgetGate } from "../director/budget.js";
import type { BudgetState } from "../director/types.js";
import { latestCharterVersion } from "../director/charter.js";
import { approveDecision, rejectDecision } from "../director/executor.js";
import { getActiveTick } from "../director/active-tick.js";
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

// Resolve the persona display name for a repo. Charter is optional and
// the persona block within it is also optional; fall back to a neutral
// "Director" / 🥷 pair when nothing is configured. Used for both the
// chat-bubble label and the empty-state copy.
function resolvePersonaName(repo: RepoConfig | undefined): string {
  const name = repo?.director?.charter?.persona?.name;
  return name && name.trim().length > 0 ? name : "Director";
}

function resolvePersonaAvatar(repo: RepoConfig | undefined): string {
  return repo?.director?.charter?.persona?.avatar ?? "🥷";
}

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

// Group consecutive system / tick_log noise into a single collapsed entry
// so a long history of "tick skipped" lines doesn't drown out the
// human-readable conversation. Each non-noise message ends a noise group.
type RenderItem = { kind: "msg"; m: DirectorMessage } | { kind: "noise"; msgs: DirectorMessage[] };

function isNoise(m: DirectorMessage): boolean {
  // System tick_log / error: housekeeping output the human shouldn't
  // need to scan in normal operation.
  if (m.role === "system" && (m.type === "tick_log" || m.type === "error")) return true;
  // Per-approval acks and execution reports: useful audit trail, but
  // visually redundant with the inline outcome badge on the proposal
  // itself. Pattern-match to fold them without losing the records.
  if (m.role === "user" && m.type === "answer" && /^Approved decision #/.test(m.body)) return true;
  if (m.role === "director" && m.type === "report" && /^Decision #\d+ executed:/.test(m.body))
    return true;
  return false;
}

function groupNoise(messages: DirectorMessage[]): RenderItem[] {
  const out: RenderItem[] = [];
  let bucket: DirectorMessage[] = [];
  for (const m of messages) {
    if (isNoise(m)) {
      bucket.push(m);
    } else {
      if (bucket.length > 0) {
        out.push({ kind: "noise", msgs: bucket });
        bucket = [];
      }
      out.push({ kind: "msg", m });
    }
  }
  if (bucket.length > 0) out.push({ kind: "noise", msgs: bucket });
  return out;
}

type DecisionOutcomeView = {
  outcome: string;
  outcomeDetails: string | null;
};

function decisionOutcomeView(db: Db, decisionId: number | null): DecisionOutcomeView | null {
  if (decisionId == null) return null;
  const row = db
    .prepare(`SELECT outcome, outcome_details FROM director_decisions WHERE id = ?`)
    .get(decisionId) as { outcome: string; outcome_details: string | null } | undefined;
  if (!row) return null;
  return { outcome: row.outcome, outcomeDetails: row.outcome_details };
}

function renderMessage(
  db: Db,
  slug: string,
  m: DirectorMessage,
  personaName: string,
  personaAvatar: string,
): TrustedHtml {
  const isUser = m.role === "user";
  const isDirector = m.role === "director";
  // Visual slots: director on the left, user on the right, system small.
  const align = isUser ? "items-end" : "items-start";
  const bubbleColor = isUser
    ? "bg-[var(--accent-soft)] border-[var(--accent)]"
    : isDirector
      ? "bg-[var(--surface-elevated)] border-[var(--border)]"
      : "bg-[var(--surface-sunken)] border-[var(--border)]";
  const speaker = isUser ? "👤 you" : isDirector ? `${personaAvatar} ${personaName}` : "⚙️ system";

  // For proposals, the underlying decision's outcome is part of the bubble
  // — buttons when pending, a closed-out badge when resolved. Keeps the
  // proposal-and-its-result colocated instead of scrolling to find them.
  const proposalOutcome = m.type === "proposal" ? decisionOutcomeView(db, m.decisionId) : null;
  const isLiveProposal = proposalOutcome?.outcome === "pending" && m.decisionId != null;

  return html`
    <div class="flex flex-col ${align} gap-1 w-full">
      <div class="flex items-center gap-2 text-xs text-[var(--fg-muted)]">
        <span class="font-mono">${speaker}</span>
        ${badge({ label: m.type, tone: messageTypeBadgeTone(m.type) })}
        <span>${time(m.ts)}</span>
      </div>
      <div class="rounded-lg border ${bubbleColor} p-3 max-w-[min(42rem,90%)] text-sm shadow-sm">
        <div class="md-body">${m.body}</div>
        ${isLiveProposal && m.decisionId
          ? renderProposalActions(slug, m.decisionId)
          : proposalOutcome
            ? renderProposalOutcome(proposalOutcome)
            : ""}
      </div>
    </div>
  `;
}

function renderProposalOutcome(view: DecisionOutcomeView): TrustedHtml {
  // After a proposal is resolved, show its final state inline so the user
  // doesn't have to scroll for the corresponding report. Removes most of
  // the post-approval chat noise.
  switch (view.outcome) {
    case "executed":
      return html`<div
        class="mt-3 pt-3 border-t border-[var(--border)] text-xs text-[var(--success)] flex items-center gap-2"
      >
        <span>✅ executed</span>
        <span class="text-[var(--fg-muted)]">${view.outcomeDetails ?? ""}</span>
      </div>`;
    case "failed":
      return html`<div
        class="mt-3 pt-3 border-t border-[var(--border)] text-xs text-[var(--danger)] flex items-center gap-2"
      >
        <span>❌ failed</span>
        <span class="text-[var(--fg-muted)]">${view.outcomeDetails ?? ""}</span>
      </div>`;
    case "rejected":
      return html`<div
        class="mt-3 pt-3 border-t border-[var(--border)] text-xs text-[var(--warning)] flex items-center gap-2"
      >
        <span>✗ rejected</span>
        <span class="text-[var(--fg-muted)]">${view.outcomeDetails ?? ""}</span>
      </div>`;
    case "skipped":
      return html`<div
        class="mt-3 pt-3 border-t border-[var(--border)] text-xs text-[var(--fg-muted)]"
      >
        ⊘ skipped — ${view.outcomeDetails ?? ""}
      </div>`;
    case "dry_run":
      return html`<div
        class="mt-3 pt-3 border-t border-[var(--border)] text-xs text-[var(--fg-muted)]"
      >
        (dry_run — not executed)
      </div>`;
    default:
      return raw("");
  }
}

function renderNoiseGroup(msgs: DirectorMessage[]): TrustedHtml {
  // Show first + last + a folded middle. Default collapsed.
  if (msgs.length === 0) return raw("");
  const first = msgs[0]!;
  const last = msgs[msgs.length - 1]!;
  const summary = `${msgs.length} system event${msgs.length === 1 ? "" : "s"} (${first.type}…${last.type})`;
  return html`
    <details class="w-full text-xs text-[var(--fg-muted)] my-1 px-1">
      <summary class="cursor-pointer select-none py-1 hover:text-[var(--fg-primary)]">
        ⚙️ ${summary} · ${time(first.ts)} → ${time(last.ts)}
      </summary>
      <div class="flex flex-col gap-2 mt-2 pl-4 border-l-2 border-[var(--border)]">
        ${msgs.map(
          (m) => html`
            <div class="flex flex-col gap-1">
              <div class="flex items-center gap-2 text-[10px] text-[var(--fg-muted)]">
                ${badge({ label: m.type, tone: messageTypeBadgeTone(m.type) })}
                <span>${time(m.ts)}</span>
              </div>
              <div
                class="rounded border border-[var(--border)] bg-[var(--surface-sunken)] p-2 text-xs whitespace-pre-wrap"
              >
                ${m.body}
              </div>
            </div>
          `,
        )}
      </div>
    </details>
  `;
}

function renderProposalActions(slug: string, decisionId: number): TrustedHtml {
  return html`
    <div class="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t border-[var(--border)]">
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
        hx-vals="js:{reason: document.getElementById('reject-${decisionId}').value}"
      >
        ✗ Reject
      </button>
      <input
        id="reject-${decisionId}"
        type="text"
        placeholder="reject reason (optional)"
        class="form-input form-input-sm flex-1 min-w-[14rem] text-xs"
      />
    </div>
  `;
}

// ── Tick status panel ────────────────────────────────────────────────
// Shows when the next scheduled tick will fire, how many user messages
// are still unanswered, and a [Tick now] button. Auto-refreshes every 10s
// so the user sees state changes (Director is running → result posted)
// without manually reloading.

function relativeTime(ts: string | null): string {
  if (!ts) return "never";
  // SQLite text is UTC; append Z so Date.parse treats it as UTC.
  const t = Date.parse(ts.includes("T") ? ts : ts.replace(" ", "T") + "Z");
  if (Number.isNaN(t)) return ts;
  const deltaMs = Date.now() - t;
  const sec = Math.round(deltaMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m ago`;
  const d = Math.round(hr / 24);
  return `${d}d ago`;
}

function untilTime(ts: string | null, cadenceHours: number): string {
  if (!ts) return "any moment now";
  const t = Date.parse(ts.includes("T") ? ts : ts.replace(" ", "T") + "Z");
  if (Number.isNaN(t)) return "?";
  const nextT = t + cadenceHours * 3600_000;
  const deltaMs = nextT - Date.now();
  if (deltaMs <= 0) return "any moment now (loop polls every 60s)";
  const sec = Math.round(deltaMs / 1000);
  if (sec < 60) return `in ${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `in ${min}m`;
  const hr = Math.floor(min / 60);
  return `in ${hr}h ${min % 60}m`;
}

function renderStatusPanel(
  db: Db,
  slug: string,
  repoId: number,
  budget: BudgetState,
  cadenceHours: number,
  personaName: string,
  personaAvatar: string,
): TrustedHtml {
  const unanswered = unansweredUserDirectives(db, repoId);
  // Truth source for "is the director thinking right now": a fresh row in
  // director_active_ticks. Stale rows (process crashed mid-tick) are
  // filtered out by getActiveTick's TTL guard. The previous heuristic
  // (`budget.lastTickAt === null`) only fired on the very first tick of
  // a brand-new repo and was effectively dead code.
  const active = getActiveTick(db, repoId);
  const isProcessing = active !== null;

  // Visual state.
  const stateLabel = isProcessing
    ? `🟡 ${personaAvatar} ${personaName} is thinking… (${active.reason})`
    : budget.paused
      ? "⏸ Paused"
      : "🟢 Idle";
  const stateColor = isProcessing
    ? "border-[var(--warning)] bg-[var(--warning-soft)]"
    : budget.paused
      ? "border-[var(--border)] bg-[var(--surface-sunken)]"
      : "border-[var(--success)] bg-[var(--success-soft)]";

  // While the director is mid-tick, poll faster so the chat refreshes its
  // result the moment the tick finishes. Idle: 10s is plenty.
  const pollInterval = isProcessing ? "2s" : "10s";

  return html`
    <div
      id="director-status"
      hx-get="/admin/director/${slug}/status"
      hx-trigger="every ${pollInterval}"
      hx-swap="outerHTML"
      class="rounded-lg border ${stateColor} p-3 text-sm flex flex-wrap items-center gap-x-4 gap-y-2"
    >
      <span class="font-medium">${stateLabel}</span>
      <span class="text-xs text-[var(--fg-muted)]">
        Last tick: ${relativeTime(budget.lastTickAt)}
        ${budget.lastTickAt
          ? ` · Next scheduled: ${untilTime(budget.lastTickAt, cadenceHours)}`
          : ""}
      </span>
      ${unanswered.length > 0
        ? html`<span class="text-xs">
            ${badge({
              label: `${unanswered.length} unanswered`,
              tone: "warning",
            })}
          </span>`
        : ""}
      <span class="ml-auto flex items-center gap-2">
        <button
          class="btn btn-primary btn-sm"
          hx-post="/admin/director/${slug}/tick-now"
          hx-target="#director-status"
          hx-swap="outerHTML"
          ${isProcessing ? "disabled" : ""}
          title="Force the director to tick within the next 60s instead of waiting for the scheduled tick"
        >
          ▶ Tick now
        </button>
      </span>
    </div>
  `;
}

function renderComposer(slug: string): TrustedHtml {
  return html`
    <form
      class="flex flex-col gap-2 p-3 border border-[var(--border)] rounded-lg bg-[var(--surface-elevated)] shadow-sm"
      hx-post="/admin/director/${slug}/messages"
      hx-target="#chat-thread"
      hx-swap="outerHTML"
      hx-on::after-request="if(event.detail.successful) this.reset()"
    >
      <textarea
        name="body"
        rows="2"
        required
        placeholder="Send a directive, answer a question, or veto. Markdown supported. ⌘/Ctrl+Enter to send."
        class="form-textarea text-sm resize-none"
        onkeydown="if((event.metaKey||event.ctrlKey)&&event.key==='Enter'){event.preventDefault();this.form.requestSubmit();}"
      ></textarea>
      <div class="flex items-center justify-between gap-2">
        <select name="type" class="form-select form-select-sm text-xs">
          <option value="directive">directive</option>
          <option value="answer">answer</option>
          <option value="veto">veto</option>
        </select>
        <button type="submit" class="btn btn-primary btn-sm">Send</button>
      </div>
    </form>
  `;
}

function renderChatThread(
  db: Db,
  slug: string,
  messages: DirectorMessage[],
  personaName: string,
  personaAvatar: string,
): TrustedHtml {
  // messages comes ordered ascending by id (oldest first) — render top→bottom.
  const items = groupNoise(messages);
  return html`
    <div id="chat-thread" class="flex flex-col gap-3">
      <div
        id="chat-scroll"
        class="flex flex-col gap-3 max-h-[60vh] overflow-y-auto p-3 border border-[var(--border)] rounded-lg bg-[var(--surface-base)]"
      >
        ${messages.length === 0
          ? html`<p class="text-sm text-[var(--fg-muted)] text-center py-8">
              Empty thread. ${personaName} will start posting here on its next tick.
            </p>`
          : items.map((it) =>
              it.kind === "msg"
                ? renderMessage(db, slug, it.m, personaName, personaAvatar)
                : renderNoiseGroup(it.msgs),
            )}
      </div>
      ${renderComposer(slug)}
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

// Client-side script that re-renders Markdown in any .md-body element
// after the page (or any HTMX swap) lands. Runs on initial load and after
// every htmx:afterSwap. Uses marked (CDN) + DOMPurify (CDN).
const CHAT_INIT_SCRIPT = `
<script>
(function(){
  // Re-render Markdown for any .md-body that hasn't been processed yet.
  function renderMarkdown(root){
    if(!window.marked || !window.DOMPurify) return;
    var nodes = (root || document).querySelectorAll('.md-body:not([data-md-rendered])');
    nodes.forEach(function(el){
      var raw = el.textContent || '';
      var html = window.marked.parse(raw, {breaks: true, gfm: true});
      el.innerHTML = window.DOMPurify.sanitize(html);
      el.setAttribute('data-md-rendered', '1');
    });
  }

  // ── Scroll discipline ──────────────────────────────────────────────
  // Scroll-to-bottom must NOT fight the user. Rules:
  //   • Initial page load → scroll once to the bottom.
  //   • HTMX swap of the chat thread (new message arrived OR composer
  //     posted) → scroll only if the user was near the bottom before
  //     the swap. If they had scrolled up to read history, leave them
  //     alone.
  //   • HTMX swap of just #director-status (10s status poll) → never
  //     scroll the chat. The status panel is a separate element from
  //     the scroll container.
  var NEAR_BOTTOM_PX = 80;
  function isNearBottom(el){
    return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  }

  var wasNearBottom = true; // assume true so the first swap follows new messages

  document.body.addEventListener('htmx:beforeSwap', function(e){
    var c = document.getElementById('chat-scroll');
    if(c) wasNearBottom = isNearBottom(c);
  });

  document.body.addEventListener('htmx:afterSwap', function(e){
    renderMarkdown(document);
    var swapTarget = e.detail && e.detail.target;
    var swapId = swapTarget ? swapTarget.id : '';
    // Only consider scrolling when the swap touched the chat thread.
    // Status-panel polls (#director-status) must not move the scroll.
    var touchedChat = swapId === 'chat-thread' || (swapTarget && swapTarget.querySelector && swapTarget.querySelector('#chat-scroll'));
    if(touchedChat){
      var c = document.getElementById('chat-scroll');
      if(c && wasNearBottom) c.scrollTop = c.scrollHeight;
    }
  });

  // First-load scroll + markdown. We always scroll on initial load —
  // user just opened the page and expects to see the latest message.
  function init(){
    renderMarkdown(document);
    var c = document.getElementById('chat-scroll');
    if(c) c.scrollTop = c.scrollHeight;
  }
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else { init(); }
})();
</script>
`;

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
                <p class="text-sm text-[var(--fg-muted)]">
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
                          <div class="text-xs text-[var(--fg-muted)]">${e.slug}</div>
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

    const messages = recentMessages(db, entry.repoId, 200);
    const decisions = recentDecisions(db, entry.repoId, 20);
    const charter = latestCharterVersion(db, entry.repoId);
    const budgetState = ensureBudgetState(db, entry.repoId, repo.director.budget);
    const gate = checkBudgetGate(budgetState, repo.director.budget);
    const personaName = resolvePersonaName(repo);
    const personaAvatar = resolvePersonaAvatar(repo);

    const charterCard = card({
      title: `Charter${charter ? ` (v${charter.version})` : ""}`,
      body: charter
        ? html`
            <div class="flex flex-col gap-2">
              <div>
                <div class="text-xs text-[var(--fg-muted)]">Vision</div>
                <div class="text-sm whitespace-pre-wrap">${charter.charter.vision}</div>
              </div>
              <div>
                <div class="text-xs text-[var(--fg-muted)]">Priorities</div>
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
                      <div class="text-xs text-[var(--fg-muted)]">Out of bounds</div>
                      <ul class="text-sm list-disc pl-5">
                        ${charter.charter.out_of_bounds.map((b) => html`<li>${b}</li>`)}
                      </ul>
                    </div>
                  `
                : ""}
            </div>
          `
        : html`<p class="text-sm text-[var(--fg-muted)]">No charter version captured yet.</p>`,
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

    const statusPanel = renderStatusPanel(
      db,
      slug,
      entry.repoId,
      budgetState,
      repo.director.cadence_hours,
      personaName,
      personaAvatar,
    );

    const chatCard = card({
      title: `Chat — ${messages.length} message(s)`,
      body: html`<div class="flex flex-col gap-3">
        ${statusPanel} ${renderChatThread(db, slug, messages, personaName, personaAvatar)}
      </div>`,
    });

    const decisionsCard = card({
      title: `Recent decisions — ${decisions.length}`,
      body:
        decisions.length === 0
          ? html`<p class="text-sm text-[var(--fg-muted)]">No decisions logged yet.</p>`
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
      ${raw(CHAT_INIT_SCRIPT)}
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

  // ── POST /:slug/messages ─────────────────────────────────────────────
  app.post("/:slug/messages", async (c) => {
    const slug = c.req.param("slug");
    const entries = listEntries(db, getConfig);
    const entry = entries.find((e) => e.slug === slug);
    if (!entry) return c.notFound();

    const config = getConfig();
    const repo = config.repos.find((r) => repoKey(r) === slug);

    const form = await c.req.parseBody();
    const type = String(form.type ?? "directive");
    const body = String(form.body ?? "").trim();
    if (!body) return c.html("body required", 400);
    if (!["directive", "answer", "veto"].includes(type)) {
      return c.html("invalid type", 400);
    }

    appendMessage(db, {
      repoId: entry.repoId,
      role: "user",
      type: type as "directive" | "answer" | "veto",
      body,
      metadata: { repo: slug, actor: "admin" },
    });

    const messages = recentMessages(db, entry.repoId, 200);
    return c.html(
      renderChatThread(db, slug, messages, resolvePersonaName(repo), resolvePersonaAvatar(repo))
        .value,
    );
  });

  // ── POST /:slug/decisions/:id/approve ────────────────────────────────
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

    const messages = recentMessages(db, entry.repoId, 200);
    return c.html(
      renderChatThread(db, slug, messages, resolvePersonaName(repo), resolvePersonaAvatar(repo))
        .value,
    );
  });

  // ── POST /:slug/decisions/:id/reject ─────────────────────────────────
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

    const messages = recentMessages(db, entry.repoId, 200);
    return c.html(
      renderChatThread(db, slug, messages, resolvePersonaName(repo), resolvePersonaAvatar(repo))
        .value,
    );
  });

  // ── GET /:slug/status — render just the status panel ──────────────
  // HTMX polls this every 10s so the user sees state changes without a
  // full page reload. Cheap query: just reads budget state.
  app.get("/:slug/status", (c) => {
    const slug = c.req.param("slug");
    const entries = listEntries(db, getConfig);
    const entry = entries.find((e) => e.slug === slug);
    if (!entry) return c.notFound();

    const config = getConfig();
    const repo = config.repos.find((r) => repoKey(r) === slug);
    if (!repo || !repo.director) return c.notFound();

    const budgetState = ensureBudgetState(db, entry.repoId, repo.director.budget);
    const panel = renderStatusPanel(
      db,
      slug,
      entry.repoId,
      budgetState,
      repo.director.cadence_hours,
      resolvePersonaName(repo),
      resolvePersonaAvatar(repo),
    );
    return c.html(panel.value);
  });

  // ── POST /:slug/tick-now — force the director to tick within ~10s ──
  // Clears last_tick_at; the director loop wakes every 10s and treats
  // null as "should tick". The user sees the status panel flip to
  // "thinking" immediately and the result appears in chat once the
  // tick completes (typically 10–60s).
  app.post("/:slug/tick-now", (c) => {
    const slug = c.req.param("slug");
    const entries = listEntries(db, getConfig);
    const entry = entries.find((e) => e.slug === slug);
    if (!entry) return c.notFound();

    const config = getConfig();
    const repo = config.repos.find((r) => repoKey(r) === slug);
    if (!repo || !repo.director) return c.notFound();

    db.prepare(`UPDATE director_budget_state SET last_tick_at = NULL WHERE repo_id = ?`).run(
      entry.repoId,
    );

    appendMessage(db, {
      repoId: entry.repoId,
      role: "system",
      type: "tick_log",
      body: "Tick requested manually via /admin (forces tick on next loop iteration, ≤10s)",
      metadata: { repo: slug, actor: "admin", action: "tick_now" },
    });

    const budgetState = ensureBudgetState(db, entry.repoId, repo.director.budget);
    const panel = renderStatusPanel(
      db,
      slug,
      entry.repoId,
      budgetState,
      repo.director.cadence_hours,
      resolvePersonaName(repo),
      resolvePersonaAvatar(repo),
    );
    return c.html(panel.value);
  });

  return app;
}
