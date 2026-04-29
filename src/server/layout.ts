// Tiny HTML helpers for the admin UI. Keep this dependency-free —
// HTMX + Tailwind come from CDN tags in the layout.

export class TrustedHtml {
  constructor(public readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

// Mark a string as already-safe HTML (won't be escaped on interpolation).
export function raw(s: string): TrustedHtml {
  return new TrustedHtml(s);
}

// Escape a single string for safe HTML interpolation.
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Tagged template tag.
//
// Plain string values are auto-escaped. Values produced by `html` (TrustedHtml)
// or wrapped in `raw()` are inserted verbatim. Arrays are joined with each
// element handled the same way (so `${items.map(x => html`<li>${x}</li>`)}` works).
// null/undefined are skipped.
export function html(strings: TemplateStringsArray, ...values: unknown[]): TrustedHtml {
  let out = "";
  strings.forEach((str, i) => {
    out += str;
    if (i < values.length) out += renderValue(values[i]);
  });
  return new TrustedHtml(out);
}

function renderValue(v: unknown): string {
  if (v == null) return "";
  if (v instanceof TrustedHtml) return v.value;
  if (Array.isArray(v)) return v.map(renderValue).join("");
  return escapeHtml(String(v));
}

const NAV = [
  { href: "/admin/", label: "Dashboard", section: "dashboard", key: "d" },
  { href: "/admin/repos", label: "Repos", section: "repos", key: "r" },
  { href: "/admin/tasks", label: "Tasks", section: "tasks", key: "t" },
  { href: "/admin/logs", label: "Logs", section: "logs", key: "l" },
  { href: "/admin/cost", label: "Cost", section: "cost", key: "c" },
  { href: "/admin/metrics", label: "Metrics", section: "metrics", key: "m" },
  { href: "/admin/prompts", label: "Prompts", section: "prompts", key: "p" },
  { href: "/admin/settings", label: "Settings", section: "settings", key: "s" },
  { href: "/admin/audit", label: "Audit", section: "audit", key: "a" },
];

export function page(opts: {
  title: string;
  section: string;
  body: TrustedHtml | string;
  isHtmx: boolean;
}): string {
  const bodyStr = opts.body instanceof TrustedHtml ? opts.body.value : opts.body;
  if (opts.isHtmx) return bodyStr;
  const nav = NAV.map(
    (item) =>
      `<a href="${item.href}" class="px-3 py-2 rounded ${item.section === opts.section ? "bg-slate-700 text-white" : "text-slate-300 hover:bg-slate-800"}">${item.label}</a>`,
  ).join("");
  const mobileNav = NAV.map(
    (item) =>
      `<a href="${item.href}" class="block px-3 py-2 rounded ${item.section === opts.section ? "bg-slate-700 text-white" : "text-slate-300 hover:bg-slate-800"}">${item.label}</a>`,
  ).join("");
  const cmdItems = JSON.stringify(NAV.map((n) => ({ label: n.label, href: n.href, key: n.key })));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)} · openronin</title>
<script>tailwind.config = { darkMode: 'class' }</script>
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://unpkg.com/htmx.org@2.0.4"></script>
<style>
body{font-family:system-ui,-apple-system,sans-serif}
pre,code,textarea{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
/* Dark mode overrides for server-rendered content */
.dark .bg-white{background-color:#1e293b!important;color:#e2e8f0}
.dark .bg-slate-50{background-color:#0f172a!important}
.dark .text-slate-900,.dark .text-gray-900,.dark .text-slate-800{color:#cbd5e1!important}
.dark .text-slate-600,.dark .text-slate-700,.dark .text-gray-700{color:#94a3b8!important}
.dark .text-slate-500{color:#64748b!important}
.dark .border,.dark .border-slate-200,.dark .border-slate-300{border-color:#334155!important}
.dark .shadow-sm{box-shadow:0 1px 2px 0 rgb(0 0 0/.5)!important}
.dark table{border-color:#334155}
.dark thead,.dark .bg-slate-100{background-color:#1e293b!important}
.dark tr:hover{background-color:#1e293b}
.dark input:not([class*="bg-slate"]):not([class*="bg-gray"]),
.dark textarea:not([class*="bg-slate"]),
.dark select:not(#tz-select):not(#refresh-rate){
  background-color:#1e293b;color:#e2e8f0;border-color:#475569
}
@media(max-width:767px){
  .mobile-scroll-x{overflow-x:auto;-webkit-overflow-scrolling:touch}
  .mobile-table{min-width:600px}
}
</style>
</head>
<body class="bg-slate-50 dark:bg-slate-950 dark:text-slate-200 min-h-screen">
<header class="bg-slate-900 text-white">
  <div class="max-w-6xl mx-auto px-4 py-3 flex items-center gap-2 flex-wrap">
    <a href="/admin/" class="font-semibold tracking-tight text-lg shrink-0">openronin</a>
    <button id="nav-toggle" class="md:hidden p-1.5 rounded hover:bg-slate-700 text-slate-300" aria-label="Toggle menu">
      <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16"/></svg>
    </button>
    <nav class="hidden md:flex gap-1 text-sm flex-wrap">${nav}</nav>
    <div class="ml-auto flex items-center gap-2 flex-wrap">
      <label class="text-xs text-slate-400 flex items-center gap-1">
        tz
        <select id="tz-select" class="bg-slate-800 text-slate-100 rounded px-1 py-0.5 text-xs border border-slate-700">
          <option value="Europe/Moscow" selected>MSK</option>
          <option value="UTC">UTC</option>
          <option value="local">local</option>
          <option value="Europe/London">London</option>
          <option value="America/New_York">New York</option>
        </select>
      </label>
      <label class="text-xs text-slate-400 flex items-center gap-1">
        refresh
        <select id="refresh-rate" class="bg-slate-800 text-slate-100 rounded px-1 py-0.5 text-xs border border-slate-700">
          <option value="0">off</option>
          <option value="5">5s</option>
          <option value="10" selected>10s</option>
          <option value="60">1m</option>
          <option value="sse">auto (SSE)</option>
        </select>
      </label>
      <div hx-get="/admin/api/pause-state" hx-trigger="load, ai:refresh from:body" hx-swap="innerHTML"></div>
      <button id="dark-toggle" class="p-1.5 rounded hover:bg-slate-700 text-slate-300 text-sm" title="Toggle dark mode (D)">🌙</button>
      <button id="shortcuts-btn" class="p-1.5 rounded hover:bg-slate-700 text-slate-300 text-xs font-mono" title="Keyboard shortcuts (?)">?</button>
    </div>
  </div>
  <div id="mobile-nav" class="hidden md:hidden px-4 pb-3 border-t border-slate-800 mt-2 pt-2 flex flex-col gap-1">
    ${mobileNav}
  </div>
</header>

<!-- Keyboard shortcuts modal -->
<div id="shortcuts-modal" class="hidden fixed inset-0 z-50 bg-black/60 flex items-start justify-center pt-16 px-4" role="dialog" aria-modal="true">
  <div class="bg-white dark:bg-slate-800 rounded-xl shadow-2xl p-6 max-w-md w-full">
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-lg font-semibold dark:text-slate-100">Keyboard shortcuts</h2>
      <button id="shortcuts-close" class="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 text-xl leading-none">×</button>
    </div>
    <table class="w-full text-sm">
      <tbody class="divide-y divide-slate-100 dark:divide-slate-700">
        <tr><td class="py-1.5 font-mono text-xs bg-slate-100 dark:bg-slate-700 px-2 rounded w-24">Ctrl/⌘ K</td><td class="py-1.5 pl-3 dark:text-slate-300">Open command palette</td></tr>
        <tr><td class="py-1.5 font-mono text-xs bg-slate-100 dark:bg-slate-700 px-2 rounded">?</td><td class="py-1.5 pl-3 dark:text-slate-300">This shortcuts overlay</td></tr>
        <tr><td class="py-1.5 font-mono text-xs bg-slate-100 dark:bg-slate-700 px-2 rounded">g d</td><td class="py-1.5 pl-3 dark:text-slate-300">Go to Dashboard</td></tr>
        <tr><td class="py-1.5 font-mono text-xs bg-slate-100 dark:bg-slate-700 px-2 rounded">g r</td><td class="py-1.5 pl-3 dark:text-slate-300">Go to Repos</td></tr>
        <tr><td class="py-1.5 font-mono text-xs bg-slate-100 dark:bg-slate-700 px-2 rounded">g t</td><td class="py-1.5 pl-3 dark:text-slate-300">Go to Tasks</td></tr>
        <tr><td class="py-1.5 font-mono text-xs bg-slate-100 dark:bg-slate-700 px-2 rounded">g l</td><td class="py-1.5 pl-3 dark:text-slate-300">Go to Logs</td></tr>
        <tr><td class="py-1.5 font-mono text-xs bg-slate-100 dark:bg-slate-700 px-2 rounded">g c</td><td class="py-1.5 pl-3 dark:text-slate-300">Go to Cost</td></tr>
        <tr><td class="py-1.5 font-mono text-xs bg-slate-100 dark:bg-slate-700 px-2 rounded">g m</td><td class="py-1.5 pl-3 dark:text-slate-300">Go to Metrics</td></tr>
        <tr><td class="py-1.5 font-mono text-xs bg-slate-100 dark:bg-slate-700 px-2 rounded">g p</td><td class="py-1.5 pl-3 dark:text-slate-300">Go to Prompts</td></tr>
        <tr><td class="py-1.5 font-mono text-xs bg-slate-100 dark:bg-slate-700 px-2 rounded">g s</td><td class="py-1.5 pl-3 dark:text-slate-300">Go to Settings</td></tr>
        <tr><td class="py-1.5 font-mono text-xs bg-slate-100 dark:bg-slate-700 px-2 rounded">g a</td><td class="py-1.5 pl-3 dark:text-slate-300">Go to Audit log</td></tr>
        <tr><td class="py-1.5 font-mono text-xs bg-slate-100 dark:bg-slate-700 px-2 rounded">j / k</td><td class="py-1.5 pl-3 dark:text-slate-300">Move selection in tables</td></tr>
        <tr><td class="py-1.5 font-mono text-xs bg-slate-100 dark:bg-slate-700 px-2 rounded">Esc</td><td class="py-1.5 pl-3 dark:text-slate-300">Close modals</td></tr>
      </tbody>
    </table>
  </div>
</div>

<!-- Command palette -->
<div id="cmd-palette" class="hidden fixed inset-0 z-50 bg-black/60 flex items-start justify-center pt-24 px-4" role="dialog" aria-modal="true">
  <div class="bg-white dark:bg-slate-800 rounded-xl shadow-2xl w-full max-w-lg overflow-hidden">
    <div class="flex items-center border-b border-slate-200 dark:border-slate-700 px-4">
      <svg class="text-slate-400 shrink-0 w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
      <input id="cmd-input" type="text" placeholder="Search pages and actions…" autocomplete="off"
        class="flex-1 px-3 py-3 text-sm outline-none bg-transparent dark:text-slate-100 placeholder-slate-400">
      <kbd class="text-xs text-slate-400 font-mono">Esc</kbd>
    </div>
    <div id="cmd-results" class="py-1 max-h-72 overflow-y-auto"></div>
  </div>
</div>

<script>
(function(){
  // ── Dark mode ──────────────────────────────────────────────────────────────
  var htmlEl = document.documentElement;
  function applyDark(on) {
    if (on) { htmlEl.classList.add('dark'); } else { htmlEl.classList.remove('dark'); }
    var btn = document.getElementById('dark-toggle');
    if (btn) btn.textContent = on ? '☀' : '🌙';
  }
  var savedDark = localStorage.getItem('aidev.dark');
  var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  var isDark = savedDark !== null ? savedDark === '1' : prefersDark;
  applyDark(isDark);
  var darkBtn = document.getElementById('dark-toggle');
  if (darkBtn) darkBtn.addEventListener('click', function() {
    isDark = !isDark;
    applyDark(isDark);
    localStorage.setItem('aidev.dark', isDark ? '1' : '0');
  });

  // ── Mobile nav toggle ──────────────────────────────────────────────────────
  var navToggle = document.getElementById('nav-toggle');
  var mobileNav = document.getElementById('mobile-nav');
  if (navToggle && mobileNav) {
    navToggle.addEventListener('click', function() { mobileNav.classList.toggle('hidden'); });
  }

  // ── Auto-refresh ───────────────────────────────────────────────────────────
  // Drive every auto-refreshing HTMX element through one custom event so the
  // user can throttle the whole page at once via the header dropdown.
  // Elements opt in with hx-trigger="load, ai:refresh from:body".
  var sel = document.getElementById('refresh-rate');
  if (sel) {
    var saved = localStorage.getItem('aidev.refreshSec');
    if (saved !== null) sel.value = saved;
    var timer = null;
    var sseSource = null;
    function fireRefresh() {
      document.body.dispatchEvent(new CustomEvent('ai:refresh', { bubbles: true }));
    }
    function connectSse() {
      if (sseSource) { try { sseSource.close(); } catch(e){} sseSource = null; }
      try {
        sseSource = new EventSource('/admin/api/stream');
        sseSource.addEventListener('queue', function() { fireRefresh(); });
        sseSource.onerror = function() {
          if (sseSource && sseSource.readyState === 2) {
            sseSource = null;
            setTimeout(connectSse, 5000);
          }
        };
      } catch(e) {}
    }
    function applyRefresh() {
      var val = sel.value;
      localStorage.setItem('aidev.refreshSec', val);
      if (timer) { clearInterval(timer); timer = null; }
      if (sseSource) { try { sseSource.close(); } catch(e){} sseSource = null; }
      if (val === 'sse') {
        connectSse();
      } else {
        var sec = parseInt(val, 10) || 0;
        if (sec > 0) {
          timer = setInterval(fireRefresh, sec * 1000);
        }
      }
    }
    sel.addEventListener('change', applyRefresh);
    applyRefresh();
  }

  // ── Timezone formatter ─────────────────────────────────────────────────────
  // Server emits timestamps as <time data-ts="iso-Z">UTC fallback</time>.
  // We rewrite each element's text in the user's chosen TZ.
  var tzSel = document.getElementById('tz-select');
  function currentTz() {
    var sv = localStorage.getItem('aidev.tz');
    if (sv) return sv;
    return tzSel ? tzSel.value : 'Europe/Moscow';
  }
  function fmt(date, tz) {
    var opts = { year: 'numeric', month: '2-digit', day: '2-digit',
                 hour: '2-digit', minute: '2-digit', second: '2-digit',
                 hour12: false };
    if (tz && tz !== 'local') opts.timeZone = tz;
    try { return new Intl.DateTimeFormat('sv-SE', opts).format(date); }
    catch (e) { return date.toISOString(); }
  }
  function relabelTimes(root) {
    var tz = currentTz();
    var nodes = (root || document).querySelectorAll('time[data-ts]');
    for (var i = 0; i < nodes.length; i++) {
      var iso = nodes[i].getAttribute('data-ts');
      if (!iso) continue;
      var d = new Date(iso);
      if (isNaN(d.getTime())) continue;
      nodes[i].textContent = fmt(d, tz);
      nodes[i].setAttribute('title', d.toISOString() + ' (UTC)');
    }
  }
  if (tzSel) {
    var savedTz = localStorage.getItem('aidev.tz');
    if (savedTz) tzSel.value = savedTz;
    tzSel.addEventListener('change', function() {
      localStorage.setItem('aidev.tz', tzSel.value);
      relabelTimes();
    });
  }
  document.addEventListener('DOMContentLoaded', function(){ relabelTimes(); });
  relabelTimes();
  document.body.addEventListener('htmx:afterSwap', function(e){ relabelTimes(e.target); });
  document.body.addEventListener('ai:refresh', function(){ relabelTimes(); });

  // ── Keyboard shortcuts overlay ─────────────────────────────────────────────
  var shortcutsModal = document.getElementById('shortcuts-modal');
  var shortcutsClose = document.getElementById('shortcuts-close');
  var shortcutsBtn = document.getElementById('shortcuts-btn');
  function openShortcuts() { if(shortcutsModal) shortcutsModal.classList.remove('hidden'); }
  function closeShortcuts() { if(shortcutsModal) shortcutsModal.classList.add('hidden'); }
  if (shortcutsClose) shortcutsClose.addEventListener('click', closeShortcuts);
  if (shortcutsBtn) shortcutsBtn.addEventListener('click', openShortcuts);
  if (shortcutsModal) shortcutsModal.addEventListener('click', function(e){ if(e.target===shortcutsModal) closeShortcuts(); });

  // ── Command palette ────────────────────────────────────────────────────────
  var cmdPalette = document.getElementById('cmd-palette');
  var cmdInput = document.getElementById('cmd-input');
  var cmdResults = document.getElementById('cmd-results');
  var COMMANDS = ${cmdItems};

  function openPalette() {
    if (!cmdPalette) return;
    cmdPalette.classList.remove('hidden');
    if (cmdInput) { cmdInput.value = ''; cmdInput.focus(); }
    renderCmds(COMMANDS);
  }
  function closePalette() { if(cmdPalette) cmdPalette.classList.add('hidden'); }
  function renderCmds(cmds) {
    if (!cmdResults) return;
    cmdResults.innerHTML = '';
    cmds.forEach(function(cmd, i) {
      var a = document.createElement('a');
      a.href = cmd.href;
      a.className = 'flex items-center justify-between px-4 py-2 text-sm hover:bg-slate-50 dark:hover:bg-slate-700 dark:text-slate-200 cursor-pointer' + (i === 0 ? ' bg-slate-50 dark:bg-slate-700' : '');
      var label = document.createElement('span');
      label.textContent = cmd.label;
      var hint = document.createElement('kbd');
      hint.className = 'text-xs text-slate-400 font-mono';
      hint.textContent = 'g ' + cmd.key;
      a.appendChild(label);
      a.appendChild(hint);
      cmdResults.appendChild(a);
    });
  }
  if (cmdInput) {
    cmdInput.addEventListener('input', function() {
      var q = this.value.toLowerCase();
      renderCmds(COMMANDS.filter(function(c){ return c.label.toLowerCase().includes(q); }));
    });
    cmdInput.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') { closePalette(); return; }
      if (e.key === 'Enter') {
        var first = cmdResults && cmdResults.querySelector('a');
        if (first) { window.location.href = first.getAttribute('href'); }
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        var items = cmdResults ? Array.from(cmdResults.querySelectorAll('a')) : [];
        if (items.length === 0) return;
        var cur = items.findIndex(function(el){ return el.classList.contains('bg-slate-50') || el.classList.contains('dark:bg-slate-700'); });
        items.forEach(function(el){ el.classList.remove('bg-slate-50', 'dark:bg-slate-700'); });
        var next = e.key === 'ArrowDown' ? Math.min((cur < 0 ? 0 : cur) + 1, items.length - 1) : Math.max((cur < 0 ? items.length - 1 : cur) - 1, 0);
        items[next].classList.add('bg-slate-50', 'dark:bg-slate-700');
        items[next].scrollIntoView({ block: 'nearest' });
      }
    });
  }
  if (cmdPalette) cmdPalette.addEventListener('click', function(e){ if(e.target===cmdPalette) closePalette(); });

  // ── Global keyboard handler ────────────────────────────────────────────────
  var gPending = false;
  var gTimer = null;
  var NAV_MAP = { d:'/admin/',r:'/admin/repos',t:'/admin/tasks',l:'/admin/logs',c:'/admin/cost',m:'/admin/metrics',p:'/admin/prompts',s:'/admin/settings',a:'/admin/audit' };
  document.addEventListener('keydown', function(e) {
    var tag = document.activeElement && document.activeElement.tagName;
    var inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    // Cmd-K / Ctrl-K always intercept (even in inputs)
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      if (cmdPalette && !cmdPalette.classList.contains('hidden')) { closePalette(); }
      else { openPalette(); }
      return;
    }
    if (inInput) return;
    if (e.key === 'Escape') { closeShortcuts(); closePalette(); closePrDrawer(); return; }
    if (e.key === '?') { openShortcuts(); return; }
    // g-chord navigation
    if (e.key === 'g' && !e.metaKey && !e.ctrlKey) {
      gPending = true;
      if (gTimer) clearTimeout(gTimer);
      gTimer = setTimeout(function(){ gPending = false; }, 1500);
      return;
    }
    if (gPending) {
      gPending = false;
      if (gTimer) { clearTimeout(gTimer); gTimer = null; }
      var dest = NAV_MAP[e.key];
      if (dest) { window.location.href = dest; return; }
    }
    // j/k row navigation in tables
    if (e.key === 'j' || e.key === 'k') {
      var rows = Array.from(document.querySelectorAll('tbody tr'));
      if (rows.length === 0) return;
      var cur2 = rows.findIndex(function(r){ return r.classList.contains('ring-2'); });
      if (cur2 >= 0) rows[cur2].classList.remove('ring-2', 'ring-inset', 'ring-blue-400');
      var next2 = e.key === 'j' ? Math.min((cur2 < 0 ? 0 : cur2 + 1), rows.length - 1) : Math.max((cur2 <= 0 ? 0 : cur2 - 1), 0);
      rows[next2].classList.add('ring-2', 'ring-inset', 'ring-blue-400');
      rows[next2].scrollIntoView({ block: 'nearest' });
    }
  });
  // ── PR Drawer ──────────────────────────────────────────────────────────────
  var prDrawer = document.getElementById('pr-drawer');
  var prDrawerBackdrop = document.getElementById('pr-drawer-backdrop');
  var prDrawerClose = document.getElementById('pr-drawer-close');
  var prDrawerTitle = document.getElementById('pr-drawer-title');
  var prDrawerBody = document.getElementById('pr-drawer-body');
  window.openPrDrawer = function(taskId, label) {
    if (!prDrawer) return;
    if (prDrawerTitle) prDrawerTitle.textContent = label || 'PR Details';
    if (prDrawerBody) prDrawerBody.innerHTML = '<p class="text-slate-400 text-sm p-4">Loading…</p>';
    prDrawer.classList.remove('translate-x-full');
    prDrawer.setAttribute('aria-hidden', 'false');
    if (prDrawerBackdrop) prDrawerBackdrop.classList.remove('hidden');
    fetch('/admin/api/active-prs/' + taskId + '/drawer')
      .then(function(r) { return r.text(); })
      .then(function(h) { if (prDrawerBody) { prDrawerBody.innerHTML = h; relabelTimes(prDrawerBody); } })
      .catch(function() { if (prDrawerBody) prDrawerBody.innerHTML = '<p class="text-red-500 text-sm p-4">Failed to load</p>'; });
  };
  window.closePrDrawer = function() {
    if (prDrawer) { prDrawer.classList.add('translate-x-full'); prDrawer.setAttribute('aria-hidden', 'true'); }
    if (prDrawerBackdrop) prDrawerBackdrop.classList.add('hidden');
  };
  function closePrDrawer() { window.closePrDrawer(); }
  if (prDrawerClose) prDrawerClose.addEventListener('click', closePrDrawer);
  if (prDrawerBackdrop) prDrawerBackdrop.addEventListener('click', closePrDrawer);
})();
</script>

<!-- PR side drawer -->
<div id="pr-drawer" class="fixed inset-y-0 right-0 w-96 bg-white shadow-2xl z-40 transform translate-x-full transition-transform duration-200 overflow-y-auto border-l border-slate-200" aria-hidden="true">
  <div class="px-4 py-3 border-b flex items-center justify-between sticky top-0 bg-white z-10">
    <h3 class="font-semibold text-slate-800 text-sm" id="pr-drawer-title">PR Details</h3>
    <button id="pr-drawer-close" class="text-slate-400 hover:text-slate-700 text-xl leading-none p-1" title="Close (Esc)">&times;</button>
  </div>
  <div id="pr-drawer-body"><p class="text-slate-400 text-sm p-4">Select a PR row to view details</p></div>
</div>
<div id="pr-drawer-backdrop" class="hidden fixed inset-0 bg-black/20 z-30"></div>

<main class="max-w-6xl mx-auto px-4 py-6">${bodyStr}</main>
</body>
</html>`;
}

export function isHtmx(headers: Headers): boolean {
  return headers.get("HX-Request") === "true";
}

// Render a SQLite-style UTC timestamp as a <time> tag the client JS will
// re-format into the user's chosen timezone. Falls back to the raw UTC
// string for users without JS / before the formatter runs.
//
// Accepts:
//   - SQLite "YYYY-MM-DD HH:MM:SS"  (treated as UTC — that's what
//     datetime('now') produces)
//   - ISO-with-Z "YYYY-MM-DDTHH:MM:SS.sssZ"
//   - null / undefined → renders "—"
export function t(ts: string | null | undefined): TrustedHtml {
  if (!ts) return raw(`<span class="text-slate-400">—</span>`);
  // Normalise to ISO-with-Z so the JS formatter can `new Date(ts)` reliably.
  const iso = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(ts) ? ts : ts.replace(" ", "T") + "Z";
  return raw(`<time data-ts="${escapeHtml(iso)}" class="font-mono">${escapeHtml(ts)}</time>`);
}
