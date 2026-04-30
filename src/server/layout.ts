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

// Primary nav: most-frequented pages shown directly in the header.
const PRIMARY_NAV = [
  { href: "/admin/", label: "Dashboard", section: "dashboard", key: "d" },
  { href: "/admin/repos", label: "Repos", section: "repos", key: "r" },
  { href: "/admin/tasks", label: "Tasks", section: "tasks", key: "t" },
  { href: "/admin/cost", label: "Cost", section: "cost", key: "c" },
];

// Secondary nav: available via the "More" dropdown or mobile drawer.
const MORE_NAV = [
  { href: "/admin/logs", label: "Logs", section: "logs", key: "l" },
  { href: "/admin/metrics", label: "Metrics", section: "metrics", key: "m" },
  { href: "/admin/prompts", label: "Prompts", section: "prompts", key: "p" },
  { href: "/admin/settings", label: "Settings", section: "settings", key: "s" },
  { href: "/admin/audit", label: "Audit", section: "audit", key: "a" },
];

const NAV = [...PRIMARY_NAV, ...MORE_NAV];

export function page(opts: {
  title: string;
  section: string;
  body: TrustedHtml | string;
  isHtmx: boolean;
  breadcrumb?: Array<{ label: string; href?: string }>;
  tabs?: Array<{ label: string; href: string; active?: boolean }>;
  actions?: TrustedHtml | string;
}): string {
  const bodyStr = opts.body instanceof TrustedHtml ? opts.body.value : opts.body;
  if (opts.isHtmx) return bodyStr;

  const isMoreActive = MORE_NAV.some((item) => item.section === opts.section);

  const primaryNavHtml = PRIMARY_NAV.map((item) => {
    const active = item.section === opts.section;
    const cls = active
      ? "px-3 py-2 rounded text-sm text-white bg-slate-700 border-b-2 border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:ring-inset"
      : "px-3 py-2 rounded text-sm text-slate-300 hover:bg-slate-800 hover:text-white focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-inset transition-colors";
    return `<a href="${item.href}" class="${cls}"${active ? ' aria-current="page"' : ""}>${item.label}</a>`;
  }).join("");

  const moreItemsHtml = MORE_NAV.map((item) => {
    const active = item.section === opts.section;
    return `<a href="${item.href}" class="block px-4 py-2 text-sm ${active ? "bg-slate-600 text-white font-medium" : "text-slate-200 hover:bg-slate-700"} transition-colors">${item.label}</a>`;
  }).join("");

  const moreButtonCls = isMoreActive
    ? "px-3 py-2 rounded text-sm text-white bg-slate-700 border-b-2 border-indigo-400 flex items-center gap-1 focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:ring-inset"
    : "px-3 py-2 rounded text-sm text-slate-300 hover:bg-slate-800 hover:text-white flex items-center gap-1 focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-inset transition-colors";

  const mobileNavHtml = NAV.map((item) => {
    const active = item.section === opts.section;
    return `<a href="${item.href}" class="block px-3 py-2.5 rounded text-sm ${active ? "bg-slate-700 text-white font-medium" : "text-slate-300 hover:bg-slate-800 hover:text-white"} transition-colors">${item.label}</a>`;
  }).join("");

  const cmdItems = JSON.stringify(NAV.map((n) => ({ label: n.label, href: n.href, key: n.key })));

  // Breadcrumb + tabs section rendered between header and main.
  let breadcrumbSection = "";
  if (opts.breadcrumb && opts.breadcrumb.length > 0) {
    const crumbs = opts.breadcrumb
      .map((crumb, i) => {
        const sep = i > 0 ? `<span class="text-muted mx-1.5 select-none">/</span>` : "";
        if (crumb.href) {
          return `${sep}<a href="${escapeHtml(crumb.href)}" class="hover:text-secondary transition-colors">${escapeHtml(crumb.label)}</a>`;
        }
        return `${sep}<span class="text-primary font-medium">${escapeHtml(crumb.label)}</span>`;
      })
      .join("");

    const actionsHtml =
      opts.actions != null
        ? `<div class="flex items-center gap-2">${opts.actions instanceof TrustedHtml ? opts.actions.value : opts.actions}</div>`
        : "";

    const tabsHtml =
      opts.tabs && opts.tabs.length > 0
        ? `<div class="flex gap-0 -mb-px mt-2" role="tablist">${opts.tabs
            .map((tab) => {
              const cls = tab.active
                ? "px-4 py-2 text-sm font-medium text-brand border-b-2 border-brand"
                : "px-4 py-2 text-sm text-muted hover:text-secondary border-b-2 border-transparent hover:border-subtle transition-colors";
              return `<a href="${escapeHtml(tab.href)}" class="${cls}" role="tab"${tab.active ? ' aria-current="page"' : ""}>${escapeHtml(tab.label)}</a>`;
            })
            .join("")}</div>`
        : "";

    breadcrumbSection = `<div class="border-b border-subtle bg-surface">
  <div class="max-w-6xl mx-auto px-4">
    <div class="flex items-center justify-between pt-2.5 pb-1">
      <nav class="text-sm text-muted" aria-label="Breadcrumb"><ol class="flex items-center flex-wrap">${crumbs}</ol></nav>
      ${actionsHtml}
    </div>
    ${tabsHtml}
  </div>
</div>`;
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)} · openronin</title>
<script>(function(){var t=localStorage.getItem('aidev.dark');var d=t!==null?t==='1':window.matchMedia&&window.matchMedia('(prefers-color-scheme:dark)').matches;if(d){document.documentElement.classList.add('dark');document.documentElement.setAttribute('data-theme','dark');}})();</script>
<script>tailwind.config = { darkMode: 'class' }</script>
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://unpkg.com/htmx.org@2.0.4"></script>
<style>
/* ─── Design Tokens ─────────────────────────────────────────────────────── */
:root {
  --surface-base:     #fafaf9;
  --surface-elevated: #ffffff;
  --surface-overlay:  #ffffff;
  --surface-sunken:   #f1f0ee;
  --fg-primary:       #1c1917;
  --fg-secondary:     #57534e;
  --fg-muted:         #a8a29e;
  --fg-on-brand:      #ffffff;
  --border-subtle:    #e7e5e4;
  --border-strong:    #a8a29e;
  --brand-primary:       #4f46e5;
  --brand-primary-hover: #4338ca;
  --brand-primary-fg:    #ffffff;
  --status-success-bg:#dcfce7; --status-success-fg:#166534; --status-success-border:#86efac;
  --status-warning-bg:#fef9c3; --status-warning-fg:#713f12; --status-warning-border:#fde047;
  --status-danger-bg: #fee2e2; --status-danger-fg: #991b1b; --status-danger-border: #fca5a5;
  --status-info-bg:   #dbeafe; --status-info-fg:   #1e40af; --status-info-border:   #93c5fd;
  --status-neutral-bg:#f1f5f9; --status-neutral-fg:#475569; --status-neutral-border:#cbd5e1;
  --space-1:4px; --space-2:8px; --space-3:12px; --space-4:16px; --space-5:24px; --space-6:32px; --space-7:48px;
  --radius-sm:4px; --radius-md:6px; --radius-lg:8px; --radius-xl:12px;
  --shadow-1:0 1px 2px 0 rgb(0 0 0/.05);
  --shadow-2:0 1px 3px 0 rgb(0 0 0/.1),0 1px 2px -1px rgb(0 0 0/.1);
  --shadow-3:0 4px 6px -1px rgb(0 0 0/.1),0 2px 4px -2px rgb(0 0 0/.1);
  --z-dropdown:10; --z-sticky:20; --z-modal:50;
}
:root[data-theme="dark"] {
  --surface-base:     #0f1419;
  --surface-elevated: #15202b;
  --surface-overlay:  #1c2a38;
  --surface-sunken:   #0a0e14;
  --fg-primary:       #e8eaed;
  --fg-secondary:     #9aa0a6;
  --fg-muted:         #5f6368;
  --fg-on-brand:      #ffffff;
  --border-subtle:    #253341;
  --border-strong:    #3d5266;
  --brand-primary:       #818cf8;
  --brand-primary-hover: #6366f1;
  --brand-primary-fg:    #ffffff;
  --status-success-bg:#0d2818; --status-success-fg:#4ade80; --status-success-border:#166534;
  --status-warning-bg:#2d1f00; --status-warning-fg:#fbbf24; --status-warning-border:#92400e;
  --status-danger-bg: #2d0f0f; --status-danger-fg: #f87171; --status-danger-border: #991b1b;
  --status-info-bg:   #0d1d3a; --status-info-fg:   #60a5fa; --status-info-border:   #1e40af;
  --status-neutral-bg:#1c2937; --status-neutral-fg:#94a3b8; --status-neutral-border:#334155;
  --shadow-1:0 1px 2px 0 rgb(0 0 0/.3);
  --shadow-2:0 1px 3px 0 rgb(0 0 0/.4),0 1px 2px -1px rgb(0 0 0/.4);
  --shadow-3:0 4px 6px -1px rgb(0 0 0/.5),0 2px 4px -2px rgb(0 0 0/.4);
}
/* ─── Semantic utilities ──────────────────────────────────────────────────── */
body{font-family:system-ui,-apple-system,sans-serif;background:var(--surface-base);color:var(--fg-primary)}
pre,code,textarea{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.bg-surface   {background:var(--surface-base)}
.bg-elevated  {background:var(--surface-elevated)}
.bg-overlay   {background:var(--surface-overlay)}
.bg-sunken    {background:var(--surface-sunken)}
.text-primary  {color:var(--fg-primary)}
.text-secondary{color:var(--fg-secondary)}
.text-muted    {color:var(--fg-muted)}
.text-on-brand {color:var(--fg-on-brand)}
.border-subtle {border-color:var(--border-subtle)}
.border-strong {border-color:var(--border-strong)}
.bg-brand      {background:var(--brand-primary);color:var(--brand-primary-fg)}
.bg-brand:hover{background:var(--brand-primary-hover)}
.text-brand    {color:var(--brand-primary)}
.border-brand  {border-color:var(--brand-primary)}
.badge-success{background:var(--status-success-bg);color:var(--status-success-fg);border-color:var(--status-success-border)}
.badge-warning{background:var(--status-warning-bg);color:var(--status-warning-fg);border-color:var(--status-warning-border)}
.badge-danger {background:var(--status-danger-bg); color:var(--status-danger-fg); border-color:var(--status-danger-border)}
.badge-info   {background:var(--status-info-bg);   color:var(--status-info-fg);   border-color:var(--status-info-border)}
.badge-neutral{background:var(--status-neutral-bg);color:var(--status-neutral-fg);border-color:var(--status-neutral-border)}
.btn-primary  {background:var(--brand-primary);color:var(--brand-primary-fg);border-radius:var(--radius-md);padding:var(--space-2) var(--space-4);font-size:14px;cursor:pointer;border:none;display:inline-block}
.btn-primary:hover{background:var(--brand-primary-hover)}
.btn-secondary{background:var(--surface-sunken);color:var(--fg-secondary);border:1px solid var(--border-subtle);border-radius:var(--radius-md);padding:var(--space-2) var(--space-4);font-size:14px;cursor:pointer;display:inline-block}
.btn-secondary:hover{background:var(--surface-elevated);border-color:var(--border-strong)}
/* ─── Dark mode: backward-compat overrides ───────────────────────────────── */
.dark .bg-elevated,.dark .bg-white{background:var(--surface-elevated)!important;color:var(--fg-primary)}
.dark .bg-surface,.dark .bg-slate-50{background:var(--surface-base)!important}
.dark .bg-sunken,.dark .bg-slate-100{background:var(--surface-sunken)!important}
.dark .text-secondary,.dark .text-slate-600,.dark .text-slate-700,.dark .text-gray-700{color:var(--fg-secondary)!important}
.dark .text-muted,.dark .text-slate-400,.dark .text-slate-500{color:var(--fg-muted)!important}
.dark .text-primary,.dark .text-slate-900,.dark .text-gray-900,.dark .text-slate-800{color:var(--fg-primary)!important}
.dark .border-subtle,.dark .border,.dark .border-slate-200,.dark .border-slate-300{border-color:var(--border-subtle)!important}
.dark .shadow-sm{box-shadow:var(--shadow-1)!important}
.dark table{border-color:var(--border-subtle)}
.dark thead{background:var(--surface-sunken)!important}
.dark tr:hover{background:var(--surface-elevated)}
.dark input:not([class*="bg-slate"]):not([class*="bg-gray"]),
.dark textarea:not([class*="bg-slate"]),
.dark select:not(#tz-select):not(#refresh-rate){
  background:var(--surface-elevated);color:var(--fg-primary);border-color:var(--border-strong)
}
.dark .badge-success{background:var(--status-success-bg);color:var(--status-success-fg);border-color:var(--status-success-border)}
.dark .badge-warning{background:var(--status-warning-bg);color:var(--status-warning-fg);border-color:var(--status-warning-border)}
.dark .badge-danger {background:var(--status-danger-bg); color:var(--status-danger-fg); border-color:var(--status-danger-border)}
.dark .badge-info   {background:var(--status-info-bg);   color:var(--status-info-fg);   border-color:var(--status-info-border)}
.dark .badge-neutral{background:var(--status-neutral-bg);color:var(--status-neutral-fg);border-color:var(--status-neutral-border)}
/* ─── Mobile responsive ───────────────────────────────────────────────────── */
@media(max-width:767px){
  .mobile-scroll-x{overflow-x:auto;-webkit-overflow-scrolling:touch}
  .mobile-table{min-width:600px}
}
/* ─── Header: pause warning border ──────────────────────────────────────── */
#app-header:has(.pause-active){border-top:3px solid var(--status-warning-border)}
/* ─── Mobile drawer ──────────────────────────────────────────────────────── */
#mobile-drawer{transform:translateX(-100%);transition:transform 200ms ease}
#mobile-drawer.open{transform:translateX(0)}
/* ─── More dropdown ──────────────────────────────────────────────────────── */
#more-menu{display:none}
#more-menu.open{display:block}
/* ─── Breadcrumb tabs ────────────────────────────────────────────────────── */
[role="tablist"] a{text-decoration:none}
/* ─── Button component ────────────────────────────────────────────────────── */
.btn{display:inline-flex;align-items:center;gap:6px;font-weight:500;border-radius:var(--radius-md);cursor:pointer;border:none;text-decoration:none;white-space:nowrap;line-height:1;box-sizing:border-box;transition:background .15s,opacity .15s,border-color .15s}
.btn:focus-visible{outline:2px solid var(--brand-primary);outline-offset:2px}
.btn-sm{height:28px;padding:0 12px;font-size:13px}
.btn-md{height:36px;padding:0 16px;font-size:14px}
.btn-lg{height:44px;padding:0 20px;font-size:16px}
.btn-primary{background:var(--brand-primary);color:var(--brand-primary-fg)}
.btn-primary:hover:not(:disabled){background:var(--brand-primary-hover)}
.btn-secondary{background:var(--surface-sunken);color:var(--fg-secondary);border:1px solid var(--border-subtle)}
.btn-secondary:hover:not(:disabled){background:var(--surface-elevated);border-color:var(--border-strong)}
.btn-ghost{background:transparent;color:var(--fg-secondary);border:1px solid transparent}
.btn-ghost:hover:not(:disabled){background:var(--surface-sunken)}
.btn-destructive{background:var(--status-danger-bg);color:var(--status-danger-fg);border:1px solid var(--status-danger-border)}
.btn-destructive:hover:not(:disabled){opacity:.85}
.btn-link{background:none;color:var(--brand-primary);border:none;padding:0;height:auto;font-size:inherit}
.btn-link:hover:not(:disabled){text-decoration:underline}
.btn-disabled,.btn:disabled{opacity:.5;cursor:not-allowed!important}
.btn-spinner{width:14px;height:14px;animation:btn-spin .7s linear infinite;flex-shrink:0}
@keyframes btn-spin{to{transform:rotate(360deg)}}
/* ─── Badge component ─────────────────────────────────────────────────────── */
.bdg{display:inline-flex;align-items:center;gap:4px;border-radius:9999px;font-size:12px;font-weight:500;line-height:1;padding:3px 8px;border:1px solid transparent}
.bdg-neutral{background:var(--status-neutral-bg);color:var(--status-neutral-fg);border-color:var(--status-neutral-border)}
.bdg-success{background:var(--status-success-bg);color:var(--status-success-fg);border-color:var(--status-success-border)}
.bdg-warning{background:var(--status-warning-bg);color:var(--status-warning-fg);border-color:var(--status-warning-border)}
.bdg-danger {background:var(--status-danger-bg); color:var(--status-danger-fg); border-color:var(--status-danger-border)}
.bdg-info   {background:var(--status-info-bg);   color:var(--status-info-fg);   border-color:var(--status-info-border)}
.bdg-solid-neutral{background:var(--status-neutral-fg);color:var(--surface-elevated)}
.bdg-solid-success{background:var(--status-success-fg);color:#fff}
.bdg-solid-warning{background:var(--status-warning-fg);color:#fff}
.bdg-solid-danger {background:var(--status-danger-fg); color:#fff}
.bdg-solid-info   {background:var(--status-info-fg);   color:#fff}
.bdg-outline-neutral{background:transparent;color:var(--status-neutral-fg);border-color:var(--status-neutral-border)}
.bdg-outline-success{background:transparent;color:var(--status-success-fg);border-color:var(--status-success-border)}
.bdg-outline-warning{background:transparent;color:var(--status-warning-fg);border-color:var(--status-warning-border)}
.bdg-outline-danger {background:transparent;color:var(--status-danger-fg); border-color:var(--status-danger-border)}
.bdg-outline-info   {background:transparent;color:var(--status-info-fg);   border-color:var(--status-info-border)}
/* ─── Card component ──────────────────────────────────────────────────────── */
.card{border-radius:var(--radius-lg);overflow:hidden}
.card-bordered{background:var(--surface-elevated);border:1px solid var(--border-subtle);box-shadow:var(--shadow-1)}
.card-elevated{background:var(--surface-elevated);box-shadow:var(--shadow-3)}
.card-inset{background:var(--surface-sunken);border:1px solid var(--border-subtle)}
.card-header{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--border-subtle)}
.card-title{font-weight:600;font-size:14px;color:var(--fg-primary)}
.card-actions{display:flex;align-items:center;gap:8px}
.card-body{padding:16px}
.card-body-sm{padding:12px}
.card-body-lg{padding:20px}
/* ─── Form controls ───────────────────────────────────────────────────────── */
.form-field{display:flex;flex-direction:column;gap:4px}
.form-label{font-size:13px;font-weight:500;color:var(--fg-secondary)}
.form-helper{font-size:12px;color:var(--fg-muted)}
.form-error{font-size:12px;color:var(--status-danger-fg)}
.form-input,.form-select,.form-textarea{background:var(--surface-elevated);color:var(--fg-primary);border:1px solid var(--border-subtle);border-radius:var(--radius-md);font-size:14px;outline:none;transition:border-color .15s,box-shadow .15s;width:100%;box-sizing:border-box}
.form-input{height:36px;padding:0 12px}
.form-select{height:44px;padding:0 12px}
.form-textarea{padding:8px 12px;min-height:80px;resize:vertical;line-height:1.5}
.form-input:focus,.form-select:focus,.form-textarea:focus{border-color:var(--brand-primary);box-shadow:0 0 0 3px rgba(79,70,229,.2)}
.form-input:disabled,.form-select:disabled,.form-textarea:disabled{opacity:.6;cursor:not-allowed;background:var(--surface-sunken)}
.form-input-error,.form-select-error,.form-textarea-error{border-color:var(--status-danger-border)!important}
.form-input-error:focus,.form-select-error:focus,.form-textarea-error:focus{box-shadow:0 0 0 3px rgba(153,27,27,.2)!important}
.form-textarea-mono{font-family:ui-monospace,"JetBrains Mono",SF Mono,Menlo,monospace}
.form-check-wrap,.form-toggle-wrap{display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;color:var(--fg-secondary)}
.form-checkbox,.form-radio{width:16px;height:16px;accent-color:var(--brand-primary);cursor:pointer;flex-shrink:0}
.form-toggle{appearance:none;width:36px;height:20px;background:var(--border-strong);border-radius:9999px;position:relative;cursor:pointer;transition:background .2s;flex-shrink:0}
.form-toggle:checked{background:var(--brand-primary)}
.form-toggle::after{content:"";position:absolute;width:14px;height:14px;background:#fff;border-radius:9999px;top:3px;left:3px;transition:left .2s}
.form-toggle:checked::after{left:19px}
.form-toggle:focus-visible,.form-checkbox:focus-visible,.form-radio:focus-visible{outline:2px solid var(--brand-primary);outline-offset:2px}
/* ─── YAML editor ─────────────────────────────────────────────────────────── */
.yaml-editor-wrap{border:1px solid var(--border-subtle);border-radius:var(--radius-md);overflow:hidden;display:flex;background:var(--surface-elevated)}
.yaml-editor-wrap:focus-within{border-color:var(--brand-primary);box-shadow:0 0 0 3px rgba(79,70,229,.2)}
.yaml-gutter{user-select:none;background:var(--surface-sunken);color:var(--fg-muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;line-height:1.5;padding:8px 8px 8px 4px;text-align:right;min-width:36px;border-right:1px solid var(--border-subtle);overflow:hidden;white-space:pre}
.yaml-editor{flex:1;border:none!important;border-radius:0!important;box-shadow:none!important;resize:vertical;font-family:ui-monospace,"JetBrains Mono",SF Mono,Menlo,monospace;font-size:13px;line-height:1.5;padding:8px 12px;tab-size:2;background:var(--surface-elevated);color:var(--fg-primary);min-height:160px;outline:none}
/* ─── Code blocks ─────────────────────────────────────────────────────────── */
.code-inline{background:var(--surface-sunken);border:1px solid var(--border-subtle);border-radius:var(--radius-sm);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em;padding:1px 5px}
.code-block-wrap{position:relative;border-radius:var(--radius-lg);overflow:hidden;background:var(--surface-sunken);border:1px solid var(--border-subtle)}
.code-block{display:block;margin:0;padding:16px;font-family:ui-monospace,"JetBrains Mono",SF Mono,Menlo,monospace;font-size:13px;line-height:1.5;overflow-x:auto;white-space:pre;color:var(--fg-primary)}
.code-copy-btn{position:absolute;top:8px;right:8px;padding:3px 8px;font-size:12px;background:var(--surface-elevated);border:1px solid var(--border-subtle);border-radius:var(--radius-sm);cursor:pointer;color:var(--fg-secondary);z-index:1}
.code-copy-btn:hover{background:var(--surface-overlay);border-color:var(--border-strong)}
.yaml-key{color:var(--brand-primary)}
.yaml-string{color:var(--status-success-fg)}
/* ─── Data table ──────────────────────────────────────────────────────────── */
.data-table-wrap{overflow-x:auto;border:1px solid var(--border-subtle);border-radius:var(--radius-lg)}
.data-table{width:100%;border-collapse:collapse;font-size:13px}
.data-table thead{position:sticky;top:0;z-index:var(--z-sticky);background:var(--surface-sunken)}
.data-table-th{padding:8px 12px;text-align:left;font-weight:600;font-size:12px;color:var(--fg-secondary);border-bottom:1px solid var(--border-subtle);white-space:nowrap;text-transform:uppercase;letter-spacing:.025em}
.data-table td{padding:8px 12px;border-bottom:1px solid var(--border-subtle);color:var(--fg-primary)}
.data-table tbody tr:hover{background:var(--surface-sunken)}
.data-table tbody tr:last-child td{border-bottom:none}
.data-table-sort{cursor:pointer;user-select:none}
.data-table-sort::after{content:" ↕";opacity:.4;font-size:11px}
.data-table-sort[data-dir="asc"]::after{content:" ↑";opacity:.9}
.data-table-sort[data-dir="desc"]::after{content:" ↓";opacity:.9}
.data-table-empty{text-align:center;padding:32px 16px;color:var(--fg-muted);font-size:14px}
</style>
</head>
<body class="bg-surface text-primary min-h-screen">

<header id="app-header" class="bg-slate-900 text-white">
  <div class="max-w-6xl mx-auto px-4 flex items-center h-12 gap-0">

    <!-- Zone 1: Brand -->
    <a href="/admin/" class="flex items-center gap-2 font-semibold tracking-tight text-base shrink-0 mr-5 text-white hover:text-slate-200 transition-colors">
      <img src="/admin/_assets/icon.png" width="20" height="20" alt="" class="rounded opacity-90" onerror="this.style.display='none'">
      openronin
    </a>

    <!-- Zone 2: Primary nav (desktop) -->
    <nav class="hidden md:flex items-center gap-0.5 text-sm" aria-label="Main navigation">
      ${primaryNavHtml}
      <!-- More dropdown -->
      <div class="relative" id="more-dropdown-container">
        <button id="more-btn" type="button"
          class="${moreButtonCls}"
          aria-expanded="false" aria-haspopup="true" aria-controls="more-menu">
          More
          <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24" class="opacity-70"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/></svg>
        </button>
        <div id="more-menu" class="absolute top-full left-0 mt-1 w-40 bg-slate-800 rounded-lg shadow-xl border border-slate-700 py-1 z-10 overflow-hidden" role="menu">
          ${moreItemsHtml}
        </div>
      </div>
    </nav>

    <!-- Mobile hamburger (hidden on desktop) -->
    <button id="nav-toggle" class="md:hidden p-1.5 rounded hover:bg-slate-700 text-slate-300 ml-2 shrink-0" aria-label="Open navigation" aria-expanded="false" aria-controls="mobile-drawer">
      <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16"/></svg>
    </button>

    <!-- Zone 3: System state cluster (pushed right, thin divider before it) -->
    <div class="ml-auto flex items-center gap-1.5">
      <!-- Vertical divider (desktop only) -->
      <div class="hidden md:block w-px h-5 bg-slate-700 mr-1.5 shrink-0"></div>

      <!-- Pause state indicator + toggle (HTMX fragment) -->
      <div id="pause-state-container" hx-get="/admin/api/pause-state" hx-trigger="load, ai:refresh from:body" hx-swap="innerHTML" class="flex items-center"></div>

      <!-- TZ selector (desktop only) -->
      <label class="hidden md:flex items-center gap-1 ml-1">
        <span class="text-xs text-slate-400">tz</span>
        <select id="tz-select" class="bg-slate-800 text-slate-100 rounded px-1 py-0.5 text-xs border border-slate-700">
          <option value="Europe/Moscow" selected>MSK</option>
          <option value="UTC">UTC</option>
          <option value="local">local</option>
          <option value="Europe/London">London</option>
          <option value="America/New_York">New York</option>
        </select>
      </label>

      <!-- Refresh rate selector (desktop only) -->
      <label class="hidden md:flex items-center gap-1 ml-1">
        <span class="text-xs text-slate-400">refresh</span>
        <select id="refresh-rate" class="bg-slate-800 text-slate-100 rounded px-1 py-0.5 text-xs border border-slate-700">
          <option value="0">off</option>
          <option value="5">5s</option>
          <option value="10" selected>10s</option>
          <option value="60">1m</option>
          <option value="sse">auto (SSE)</option>
        </select>
      </label>

      <!-- Theme toggle -->
      <button id="dark-toggle" class="p-1.5 rounded hover:bg-slate-700 text-slate-300 text-sm" title="Toggle dark mode (D)">🌙</button>

      <!-- Help / keyboard shortcuts -->
      <button id="shortcuts-btn" class="p-1.5 rounded hover:bg-slate-700 text-slate-300 text-xs font-mono" title="Keyboard shortcuts (?)">?</button>
    </div>
  </div>
</header>

<!-- Mobile drawer backdrop -->
<div id="mobile-drawer-backdrop" class="fixed inset-0 bg-black/50 z-40 hidden md:hidden" aria-hidden="true"></div>

<!-- Mobile slide-in drawer (left side) -->
<div id="mobile-drawer" class="fixed inset-y-0 left-0 w-72 bg-slate-900 z-50 overflow-y-auto md:hidden shadow-2xl" aria-hidden="true" aria-label="Navigation drawer">
  <div class="flex items-center justify-between px-4 py-3 border-b border-slate-800">
    <a href="/admin/" class="font-semibold text-white tracking-tight">openronin</a>
    <button id="mobile-drawer-close" class="p-1.5 rounded text-slate-400 hover:text-white hover:bg-slate-700 transition-colors" aria-label="Close navigation">
      <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
    </button>
  </div>
  <nav class="px-3 py-3 flex flex-col gap-0.5" aria-label="Mobile navigation">
    ${mobileNavHtml}
  </nav>
  <!-- Mobile system controls -->
  <div class="px-4 py-3 border-t border-slate-800 mt-2 space-y-3">
    <label class="flex items-center justify-between text-sm text-slate-300">
      <span>Timezone</span>
      <select id="tz-select-mobile" class="bg-slate-800 text-slate-100 rounded px-1.5 py-1 text-xs border border-slate-700">
        <option value="Europe/Moscow" selected>MSK</option>
        <option value="UTC">UTC</option>
        <option value="local">local</option>
        <option value="Europe/London">London</option>
        <option value="America/New_York">New York</option>
      </select>
    </label>
    <label class="flex items-center justify-between text-sm text-slate-300">
      <span>Refresh</span>
      <select id="refresh-rate-mobile" class="bg-slate-800 text-slate-100 rounded px-1.5 py-1 text-xs border border-slate-700">
        <option value="0">off</option>
        <option value="5">5s</option>
        <option value="10" selected>10s</option>
        <option value="60">1m</option>
        <option value="sse">auto (SSE)</option>
      </select>
    </label>
  </div>
</div>

<!-- Keyboard shortcuts modal -->
<div id="shortcuts-modal" class="hidden fixed inset-0 z-50 bg-black/60 flex items-start justify-center pt-16 px-4" role="dialog" aria-modal="true">
  <div class="bg-elevated rounded-xl shadow-2xl p-6 max-w-md w-full border border-subtle">
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-lg font-semibold text-primary">Keyboard shortcuts</h2>
      <button id="shortcuts-close" class="text-muted hover:text-secondary text-xl leading-none">×</button>
    </div>
    <table class="w-full text-sm">
      <tbody class="divide-y divide-slate-100 dark:divide-slate-700">
        <tr><td class="py-1.5 font-mono text-xs bg-sunken px-2 rounded w-24">Ctrl/⌘ K</td><td class="py-1.5 pl-3 text-secondary">Open command palette</td></tr>
        <tr><td class="py-1.5 font-mono text-xs bg-sunken px-2 rounded">?</td><td class="py-1.5 pl-3 text-secondary">This shortcuts overlay</td></tr>
        <tr><td class="py-1.5 font-mono text-xs bg-sunken px-2 rounded">g d</td><td class="py-1.5 pl-3 text-secondary">Go to Dashboard</td></tr>
        <tr><td class="py-1.5 font-mono text-xs bg-sunken px-2 rounded">g r</td><td class="py-1.5 pl-3 text-secondary">Go to Repos</td></tr>
        <tr><td class="py-1.5 font-mono text-xs bg-sunken px-2 rounded">g t</td><td class="py-1.5 pl-3 text-secondary">Go to Tasks</td></tr>
        <tr><td class="py-1.5 font-mono text-xs bg-sunken px-2 rounded">g l</td><td class="py-1.5 pl-3 text-secondary">Go to Logs</td></tr>
        <tr><td class="py-1.5 font-mono text-xs bg-sunken px-2 rounded">g c</td><td class="py-1.5 pl-3 text-secondary">Go to Cost</td></tr>
        <tr><td class="py-1.5 font-mono text-xs bg-sunken px-2 rounded">g m</td><td class="py-1.5 pl-3 text-secondary">Go to Metrics</td></tr>
        <tr><td class="py-1.5 font-mono text-xs bg-sunken px-2 rounded">g p</td><td class="py-1.5 pl-3 text-secondary">Go to Prompts</td></tr>
        <tr><td class="py-1.5 font-mono text-xs bg-sunken px-2 rounded">g s</td><td class="py-1.5 pl-3 text-secondary">Go to Settings</td></tr>
        <tr><td class="py-1.5 font-mono text-xs bg-sunken px-2 rounded">g a</td><td class="py-1.5 pl-3 text-secondary">Go to Audit log</td></tr>
        <tr><td class="py-1.5 font-mono text-xs bg-sunken px-2 rounded">j / k</td><td class="py-1.5 pl-3 text-secondary">Move selection in tables</td></tr>
        <tr><td class="py-1.5 font-mono text-xs bg-sunken px-2 rounded">Esc</td><td class="py-1.5 pl-3 text-secondary">Close modals</td></tr>
      </tbody>
    </table>
  </div>
</div>

<!-- Command palette -->
<div id="cmd-palette" class="hidden fixed inset-0 z-50 bg-black/60 flex items-start justify-center pt-24 px-4" role="dialog" aria-modal="true">
  <div class="bg-elevated rounded-xl shadow-2xl w-full max-w-lg overflow-hidden border border-subtle">
    <div class="flex items-center border-b border-subtle px-4">
      <svg class="text-muted shrink-0 w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
      <input id="cmd-input" type="text" placeholder="Search pages and actions…" autocomplete="off"
        class="flex-1 px-3 py-3 text-sm outline-none bg-transparent text-primary placeholder-slate-400">
      <kbd class="text-xs text-muted font-mono">Esc</kbd>
    </div>
    <div id="cmd-results" class="py-1 max-h-72 overflow-y-auto"></div>
  </div>
</div>

<script>
(function(){
  // ── Dark mode ──────────────────────────────────────────────────────────────
  var htmlEl = document.documentElement;
  function applyDark(on) {
    if (on) { htmlEl.classList.add('dark'); htmlEl.setAttribute('data-theme','dark'); }
    else    { htmlEl.classList.remove('dark'); htmlEl.removeAttribute('data-theme'); }
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

  // ── Mobile drawer ──────────────────────────────────────────────────────────
  var mobileDrawer = document.getElementById('mobile-drawer');
  var mobileBackdrop = document.getElementById('mobile-drawer-backdrop');
  var navToggle = document.getElementById('nav-toggle');
  var drawerClose = document.getElementById('mobile-drawer-close');
  function openDrawer() {
    if (!mobileDrawer) return;
    mobileDrawer.classList.add('open');
    mobileDrawer.setAttribute('aria-hidden', 'false');
    if (mobileBackdrop) mobileBackdrop.classList.remove('hidden');
    if (navToggle) navToggle.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
  }
  function closeDrawer() {
    if (!mobileDrawer) return;
    mobileDrawer.classList.remove('open');
    mobileDrawer.setAttribute('aria-hidden', 'true');
    if (mobileBackdrop) mobileBackdrop.classList.add('hidden');
    if (navToggle) navToggle.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
  }
  if (navToggle) navToggle.addEventListener('click', openDrawer);
  if (drawerClose) drawerClose.addEventListener('click', closeDrawer);
  if (mobileBackdrop) mobileBackdrop.addEventListener('click', closeDrawer);

  // ── More dropdown ──────────────────────────────────────────────────────────
  var moreBtn = document.getElementById('more-btn');
  var moreMenu = document.getElementById('more-menu');
  function openMore() {
    if (!moreMenu || !moreBtn) return;
    moreMenu.classList.add('open');
    moreBtn.setAttribute('aria-expanded', 'true');
  }
  function closeMore() {
    if (!moreMenu || !moreBtn) return;
    moreMenu.classList.remove('open');
    moreBtn.setAttribute('aria-expanded', 'false');
  }
  if (moreBtn) {
    moreBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      moreMenu && moreMenu.classList.contains('open') ? closeMore() : openMore();
    });
  }
  document.addEventListener('click', function(e) {
    if (moreMenu && moreMenu.classList.contains('open')) {
      var container = document.getElementById('more-dropdown-container');
      if (container && !container.contains(e.target)) closeMore();
    }
  });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && moreMenu && moreMenu.classList.contains('open')) closeMore();
  });

  // ── Auto-refresh ───────────────────────────────────────────────────────────
  var sel = document.getElementById('refresh-rate');
  var selMobile = document.getElementById('refresh-rate-mobile');
  if (sel) {
    var saved = localStorage.getItem('aidev.refreshSec');
    if (saved !== null) {
      sel.value = saved;
      if (selMobile) selMobile.value = saved;
    }
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
    function applyRefresh(val) {
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
    sel.addEventListener('change', function() {
      if (selMobile) selMobile.value = sel.value;
      applyRefresh(sel.value);
    });
    if (selMobile) selMobile.addEventListener('change', function() {
      sel.value = selMobile.value;
      applyRefresh(selMobile.value);
    });
    applyRefresh(sel.value);
  }

  // ── Timezone formatter ─────────────────────────────────────────────────────
  var tzSel = document.getElementById('tz-select');
  var tzSelMobile = document.getElementById('tz-select-mobile');
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
  function applyTz(val) {
    localStorage.setItem('aidev.tz', val);
    if (tzSel) tzSel.value = val;
    if (tzSelMobile) tzSelMobile.value = val;
    relabelTimes();
  }
  if (tzSel) {
    var savedTz = localStorage.getItem('aidev.tz');
    if (savedTz) { tzSel.value = savedTz; if (tzSelMobile) tzSelMobile.value = savedTz; }
    tzSel.addEventListener('change', function() { applyTz(tzSel.value); });
    if (tzSelMobile) tzSelMobile.addEventListener('change', function() { applyTz(tzSelMobile.value); });
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
      a.className = 'flex items-center justify-between px-4 py-2 text-sm hover:bg-surface text-primary cursor-pointer' + (i === 0 ? ' bg-surface' : '');
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
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      if (cmdPalette && !cmdPalette.classList.contains('hidden')) { closePalette(); }
      else { openPalette(); }
      return;
    }
    if (inInput) return;
    if (e.key === 'Escape') { closeShortcuts(); closePalette(); closePrDrawer(); closeDrawer(); return; }
    if (e.key === '?') { openShortcuts(); return; }
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
<div id="pr-drawer" class="fixed inset-y-0 right-0 w-96 bg-elevated shadow-2xl z-40 transform translate-x-full transition-transform duration-200 overflow-y-auto border-l border-subtle" aria-hidden="true">
  <div class="px-4 py-3 border-b border-subtle flex items-center justify-between sticky top-0 bg-elevated z-10">
    <h3 class="font-semibold text-primary text-sm" id="pr-drawer-title">PR Details</h3>
    <button id="pr-drawer-close" class="text-muted hover:text-secondary text-xl leading-none p-1" title="Close (Esc)">&times;</button>
  </div>
  <div id="pr-drawer-body"><p class="text-muted text-sm p-4">Select a PR row to view details</p></div>
</div>
<div id="pr-drawer-backdrop" class="hidden fixed inset-0 bg-black/20 z-30"></div>

${breadcrumbSection}
<main class="max-w-6xl mx-auto px-4 py-6">${bodyStr}</main>
<footer class="max-w-6xl mx-auto px-4 py-3 mt-4 border-t border-subtle">
  <a href="/admin/_tokens" class="text-xs text-muted hover:text-secondary">design tokens</a>
</footer>
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
