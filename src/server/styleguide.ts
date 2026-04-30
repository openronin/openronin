import { Hono } from "hono";
import { html, page, isHtmx } from "./layout.js";
import { button } from "./components/button.js";
import { badge } from "./components/badge.js";
import { card } from "./components/card.js";
import {
  formField,
  formInput,
  formSelect,
  formTextarea,
  formCheckbox,
  formToggle,
} from "./components/form.js";
import { codeInline, codeBlock } from "./components/code.js";
import { table } from "./components/table.js";

const SURFACE_TOKENS = [
  { var: "--surface-base", label: "surface-base" },
  { var: "--surface-elevated", label: "surface-elevated" },
  { var: "--surface-overlay", label: "surface-overlay" },
  { var: "--surface-sunken", label: "surface-sunken" },
];
const FG_TOKENS = [
  { var: "--fg-primary", label: "fg-primary" },
  { var: "--fg-secondary", label: "fg-secondary" },
  { var: "--fg-muted", label: "fg-muted" },
  { var: "--fg-on-brand", label: "fg-on-brand" },
];
const BORDER_TOKENS = [
  { var: "--border-subtle", label: "border-subtle" },
  { var: "--border-strong", label: "border-strong" },
];
const BRAND_TOKENS = [
  { var: "--brand-primary", label: "brand-primary" },
  { var: "--brand-primary-hover", label: "brand-primary-hover" },
];

export function styleguideRoute(): Hono {
  const app = new Hono();

  app.get("/_tokens", (c) => {
    const body = html`
      <h1 class="text-2xl font-semibold text-primary mb-1">Design Tokens</h1>
      <p class="text-muted text-sm mb-8">
        Single source of truth for colours, type, spacing, and radii. All admin pages should reference
        these tokens.
      </p>

      <section class="mb-10">
        <h2 class="text-lg font-semibold text-primary mb-4 border-b border-subtle pb-2">Colour Tokens</h2>

        <h3 class="text-sm font-medium text-secondary uppercase tracking-wide mb-3">Surfaces</h3>
        <div class="grid grid-cols-2 gap-3 mb-6 sm:grid-cols-4">${swatchRow(SURFACE_TOKENS)}</div>

        <h3 class="text-sm font-medium text-secondary uppercase tracking-wide mb-3">Text</h3>
        <div class="grid grid-cols-2 gap-3 mb-6 sm:grid-cols-4">${swatchRow(FG_TOKENS)}</div>

        <h3 class="text-sm font-medium text-secondary uppercase tracking-wide mb-3">Borders</h3>
        <div class="grid grid-cols-2 gap-3 mb-6 sm:grid-cols-4">${swatchRow(BORDER_TOKENS)}</div>

        <h3 class="text-sm font-medium text-secondary uppercase tracking-wide mb-3">Brand</h3>
        <div class="grid grid-cols-2 gap-3 mb-6 sm:grid-cols-4">${swatchRow(BRAND_TOKENS)}</div>

        <h3 class="text-sm font-medium text-secondary uppercase tracking-wide mb-3">Status</h3>
        <div class="grid grid-cols-1 gap-2 mb-6 sm:grid-cols-5">${statusSwatches()}</div>
      </section>

      <section class="mb-10">
        <h2 class="text-lg font-semibold text-primary mb-4 border-b border-subtle pb-2">Status Badges</h2>
        <div class="flex flex-wrap gap-2">
          <span class="badge-success px-2.5 py-1 rounded text-xs font-medium border">success</span>
          <span class="badge-warning px-2.5 py-1 rounded text-xs font-medium border">warning</span>
          <span class="badge-danger px-2.5 py-1 rounded text-xs font-medium border">danger</span>
          <span class="badge-info px-2.5 py-1 rounded text-xs font-medium border">info</span>
          <span class="badge-neutral px-2.5 py-1 rounded text-xs font-medium border">neutral</span>
        </div>
        <div class="mt-3 flex flex-wrap gap-2">
          <span class="badge-success px-2.5 py-1 rounded-full text-xs font-medium border">● done</span>
          <span class="badge-info px-2.5 py-1 rounded-full text-xs font-medium border">● running</span>
          <span class="badge-warning px-2.5 py-1 rounded-full text-xs font-medium border">● pending</span>
          <span class="badge-danger px-2.5 py-1 rounded-full text-xs font-medium border">● error</span>
          <span class="badge-neutral px-2.5 py-1 rounded-full text-xs font-medium border">● closed</span>
        </div>
      </section>

      <section class="mb-10">
        <h2 class="text-lg font-semibold text-primary mb-4 border-b border-subtle pb-2">
          Button Variants
        </h2>
        <div class="flex flex-wrap gap-3 items-center mb-4">
          <button class="btn-primary">Primary</button>
          <button class="btn-secondary">Secondary</button>
          <button class="btn-primary opacity-50 cursor-not-allowed" disabled>Disabled primary</button>
          <button class="btn-secondary opacity-50 cursor-not-allowed" disabled>Disabled secondary</button>
        </div>
        <div class="flex flex-wrap gap-3 items-center">
          <button class="text-xs bg-slate-800 text-white rounded px-3 py-1.5 hover:bg-slate-700">
            Dark action
          </button>
          <button
            class="text-xs bg-sunken text-secondary border border-subtle rounded px-3 py-1.5 hover:bg-elevated"
          >
            Ghost action
          </button>
          <button class="badge-danger border rounded px-3 py-1.5 text-xs hover:opacity-80">
            Destructive
          </button>
        </div>
      </section>

      <section class="mb-10">
        <h2 class="text-lg font-semibold text-primary mb-4 border-b border-subtle pb-2">Type Scale</h2>
        <div class="space-y-3">${typeScale()}</div>
      </section>

      <section class="mb-10">
        <h2 class="text-lg font-semibold text-primary mb-4 border-b border-subtle pb-2">Spacing Scale</h2>
        <div class="space-y-2">${spacingScale()}</div>
      </section>

      <section class="mb-10">
        <h2 class="text-lg font-semibold text-primary mb-4 border-b border-subtle pb-2">Border Radius</h2>
        <div class="flex flex-wrap gap-4 items-end">${radiusScale()}</div>
      </section>

      <section class="mb-10">
        <h2 class="text-lg font-semibold text-primary mb-4 border-b border-subtle pb-2">Shadows</h2>
        <div class="flex flex-wrap gap-6 items-end">${shadowScale()}</div>
      </section>

      <section class="mb-10">
        <h2 class="text-lg font-semibold text-primary mb-4 border-b border-subtle pb-2">
          Z-index Layers
        </h2>
        <div class="grid grid-cols-3 gap-3 max-w-sm">${zIndexTable()}</div>
      </section>

      <section class="mb-10">
        <h2 class="text-lg font-semibold text-primary mb-4 border-b border-subtle pb-2">Buttons</h2>
        <h3 class="text-sm font-medium text-secondary uppercase tracking-wide mb-3">Variants (md)</h3>
        <div class="flex flex-wrap gap-3 items-center mb-4">
          ${button({ variant: "primary", label: "Primary" })} ${button({ variant: "secondary", label: "Secondary" })}
          ${button({ variant: "ghost", label: "Ghost" })} ${button({ variant: "destructive", label: "Destructive" })}
          ${button({ variant: "link", label: "Link" })}
        </div>
        <h3 class="text-sm font-medium text-secondary uppercase tracking-wide mb-3">Sizes</h3>
        <div class="flex flex-wrap gap-3 items-center mb-4">
          ${button({ variant: "primary", size: "sm", label: "Small (sm)" })} ${button({ variant: "primary", size: "md", label: "Medium (md)" })}
          ${button({ variant: "primary", size: "lg", label: "Large (lg)" })}
        </div>
        <h3 class="text-sm font-medium text-secondary uppercase tracking-wide mb-3">States</h3>
        <div class="flex flex-wrap gap-3 items-center">
          ${button({ variant: "primary", label: "Default" })} ${button({ variant: "primary", label: "Disabled", disabled: true })}
          ${button({ variant: "primary", label: "Loading…", loading: true })} ${button({ variant: "secondary", label: "Disabled", disabled: true })}
          ${button({ variant: "destructive", label: "Disabled", disabled: true })}
        </div>
      </section>

      <section class="mb-10">
        <h2 class="text-lg font-semibold text-primary mb-4 border-b border-subtle pb-2">Badges</h2>
        <h3 class="text-sm font-medium text-secondary uppercase tracking-wide mb-3">Soft (default)</h3>
        <div class="flex flex-wrap gap-2 mb-4">
          ${badge({ tone: "neutral", label: "neutral" })} ${badge({ tone: "success", label: "success" })}
          ${badge({ tone: "warning", label: "warning" })} ${badge({ tone: "danger", label: "danger" })}
          ${badge({ tone: "info", label: "info" })}
        </div>
        <h3 class="text-sm font-medium text-secondary uppercase tracking-wide mb-3">Solid</h3>
        <div class="flex flex-wrap gap-2 mb-4">
          ${badge({ tone: "neutral", variant: "solid", label: "neutral" })} ${badge({ tone: "success", variant: "solid", label: "success" })}
          ${badge({ tone: "warning", variant: "solid", label: "warning" })} ${badge({ tone: "danger", variant: "solid", label: "danger" })}
          ${badge({ tone: "info", variant: "solid", label: "info" })}
        </div>
        <h3 class="text-sm font-medium text-secondary uppercase tracking-wide mb-3">Outline</h3>
        <div class="flex flex-wrap gap-2 mb-4">
          ${badge({ tone: "neutral", variant: "outline", label: "neutral" })} ${badge({ tone: "success", variant: "outline", label: "success" })}
          ${badge({ tone: "warning", variant: "outline", label: "warning" })} ${badge({ tone: "danger", variant: "outline", label: "danger" })}
          ${badge({ tone: "info", variant: "outline", label: "info" })}
        </div>
        <h3 class="text-sm font-medium text-secondary uppercase tracking-wide mb-3">
          With dot (status use)
        </h3>
        <div class="flex flex-wrap gap-2">
          ${badge({ tone: "success", label: "done", dot: true })} ${badge({ tone: "info", label: "running", dot: true })}
          ${badge({ tone: "warning", label: "pending", dot: true })} ${badge({ tone: "danger", label: "error", dot: true })}
          ${badge({ tone: "neutral", label: "closed", dot: true })}
        </div>
      </section>

      <section class="mb-10">
        <h2 class="text-lg font-semibold text-primary mb-4 border-b border-subtle pb-2">Cards</h2>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
          ${card({ title: "Bordered (default)", variant: "bordered", body: html`<p class="text-secondary text-sm">Default card with border and subtle shadow.</p>` })} ${card({ title: "Elevated", variant: "elevated", body: html`<p class="text-secondary text-sm">Drop shadow, no border. For floating panels.</p>` })}
          ${card({ title: "Inset", variant: "inset", body: html`<p class="text-secondary text-sm">Sunken background. For code previews and embeds.</p>` })}
        </div>
        <div class="mt-4">${card({ title: "With actions", variant: "bordered", actions: html`${button({ variant: "ghost", size: "sm", label: "Edit" })} ${button({ variant: "destructive", size: "sm", label: "Delete" })}`, body: html`<p class="text-secondary text-sm">Card with a title bar and right-aligned action buttons.</p>` })}</div>
      </section>

      <section class="mb-10">
        <h2 class="text-lg font-semibold text-primary mb-4 border-b border-subtle pb-2">Form Controls</h2>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 max-w-2xl">
          ${formField({ id: "ex-text", label: "Text input", helper: "Helper text below the field", control: formInput({ name: "ex-text", id: "ex-text", placeholder: "Enter text…" }) })} ${formField({ id: "ex-pass", label: "Password input", control: formInput({ name: "ex-pass", id: "ex-pass", type: "password", placeholder: "••••••" }) })}
          ${formField({ id: "ex-select", label: "Select", helper: "Pick one option", control: formSelect({ name: "ex-select", id: "ex-select", options: [{ value: "", label: "Choose…" }, { value: "a", label: "Option A" }, { value: "b", label: "Option B" }] }) })} ${formField({ id: "ex-err", label: "With error", error: "This field is required", control: formInput({ name: "ex-err", id: "ex-err", hasError: true, placeholder: "Required field" }) })}
        </div>
        <div class="mt-4 max-w-2xl">${formField({ id: "ex-ta", label: "Textarea", helper: "Resizable multi-line input", control: formTextarea({ name: "ex-ta", id: "ex-ta", rows: 3, placeholder: "Enter description…" }) })}</div>
        <div class="mt-4 flex flex-wrap gap-6 items-center">
          ${formCheckbox({ name: "ex-cb", label: "Checkbox option" })} ${formCheckbox({ name: "ex-cb2", label: "Checked checkbox", checked: true })}
          ${formToggle({ name: "ex-tog", label: "Toggle off" })} ${formToggle({ name: "ex-tog2", label: "Toggle on", checked: true })}
        </div>
      </section>

      <section class="mb-10">
        <h2 class="text-lg font-semibold text-primary mb-4 border-b border-subtle pb-2">Code Blocks</h2>
        <div class="mb-4">
          <p class="text-sm text-secondary mb-2">
            Inline: use ${codeInline("codeInline()")} for short references like
            ${codeInline("--brand-primary")} or ${codeInline("src/server/layout.ts")}.
          </p>
        </div>
        <div class="mb-4">${codeBlock({ code: `# Block code example\nconst greeting = "hello world";\nconsole.log(greeting);`, copyButton: true })}</div>
        <div>${codeBlock({ lang: "yaml", code: `repos:\n  - provider: github\n    owner: openronin\n    name: openronin\nengine:\n  model: claude-sonnet-4-6`, copyButton: true })}</div>
      </section>

      <section class="mb-10">
        <h2 class="text-lg font-semibold text-primary mb-4 border-b border-subtle pb-2">Data Table</h2>
        ${tableDemo()}
      </section>

      <script>
        (function () {
          var swatches = document.querySelectorAll("[data-token]");
          var style = getComputedStyle(document.documentElement);
          swatches.forEach(function (el) {
            var token = el.getAttribute("data-token");
            var val = style.getPropertyValue(token).trim();
            el.style.background = val;
            var hex = el.querySelector(".token-hex");
            if (hex) hex.textContent = val || "(unset)";
          });
        })();
      </script>
    `;
    return c.html(
      page({ title: "Design Tokens", section: "tokens", body, isHtmx: isHtmx(c.req.raw.headers) }),
    );
  });

  return app;
}

function swatchRow(tokens: { var: string; label: string }[]): string {
  return tokens
    .map(
      (t) =>
        `<div class="space-y-1.5">` +
        `<div class="h-12 rounded border border-subtle" data-token="${t.var}" style="background:var(${t.var})">` +
        `<span class="token-hex text-xs font-mono opacity-60 block p-1"></span>` +
        `</div>` +
        `<div class="text-xs font-mono text-secondary">${t.label}</div>` +
        `<div class="text-xs text-muted font-mono">var(${t.var})</div>` +
        `</div>`,
    )
    .join("");
}

function statusSwatches(): string {
  const statuses = [
    { label: "success", bg: "--status-success-bg", fg: "--status-success-fg" },
    { label: "warning", bg: "--status-warning-bg", fg: "--status-warning-fg" },
    { label: "danger", bg: "--status-danger-bg", fg: "--status-danger-fg" },
    { label: "info", bg: "--status-info-bg", fg: "--status-info-fg" },
    { label: "neutral", bg: "--status-neutral-bg", fg: "--status-neutral-fg" },
  ];
  return statuses
    .map(
      (s) =>
        `<div class="rounded border p-2 space-y-1 border-subtle bg-elevated">` +
        `<div class="text-xs font-medium text-primary">${s.label}</div>` +
        `<div class="flex gap-1">` +
        `<div class="h-6 w-8 rounded" data-token="${s.bg}" title="bg"></div>` +
        `<div class="h-6 w-8 rounded" data-token="${s.fg}" title="fg"></div>` +
        `</div>` +
        `<div class="text-xs text-muted font-mono">bg / fg</div>` +
        `</div>`,
    )
    .join("");
}

function typeScale(): string {
  const sizes = [
    { px: 12, label: "12px — caption / label" },
    { px: 14, label: "14px — body / table" },
    { px: 16, label: "16px — default body" },
    { px: 18, label: "18px — lead / subheading" },
    { px: 20, label: "20px — section title" },
    { px: 24, label: "24px — page title" },
    { px: 32, label: "32px — hero" },
  ];
  return sizes
    .map(
      (s) =>
        `<div class="flex items-baseline gap-4">` +
        `<span class="text-muted font-mono text-xs w-12">${s.px}px</span>` +
        `<span class="text-primary" style="font-size:${s.px}px">${s.label}</span>` +
        `</div>`,
    )
    .join("");
}

function spacingScale(): string {
  const steps = [
    { n: 1, px: 4 },
    { n: 2, px: 8 },
    { n: 3, px: 12 },
    { n: 4, px: 16 },
    { n: 5, px: 24 },
    { n: 6, px: 32 },
    { n: 7, px: 48 },
  ];
  return steps
    .map(
      (s) =>
        `<div class="flex items-center gap-3">` +
        `<span class="text-muted font-mono text-xs w-16">--space-${s.n}</span>` +
        `<div class="bg-brand h-4 rounded" style="width:${s.px}px" title="${s.px}px"></div>` +
        `<span class="text-muted text-xs">${s.px}px</span>` +
        `</div>`,
    )
    .join("");
}

function radiusScale(): string {
  const radii = [
    { label: "sm", val: "4px" },
    { label: "md", val: "6px" },
    { label: "lg", val: "8px" },
    { label: "xl", val: "12px" },
  ];
  return radii
    .map(
      (r) =>
        `<div class="text-center space-y-1">` +
        `<div class="w-16 h-16 bg-sunken border border-subtle" style="border-radius:${r.val}"></div>` +
        `<div class="text-xs text-muted font-mono">--radius-${r.label}</div>` +
        `<div class="text-xs text-muted">${r.val}</div>` +
        `</div>`,
    )
    .join("");
}

function shadowScale(): string {
  const shadows = [
    { n: 1, val: "0 1px 2px 0 rgb(0 0 0/.05)" },
    { n: 2, val: "0 1px 3px 0 rgb(0 0 0/.1)" },
    { n: 3, val: "0 4px 6px -1px rgb(0 0 0/.1)" },
  ];
  return shadows
    .map(
      (s) =>
        `<div class="text-center space-y-1">` +
        `<div class="w-20 h-12 bg-elevated border border-subtle rounded" style="box-shadow:${s.val}"></div>` +
        `<div class="text-xs text-muted font-mono">--shadow-${s.n}</div>` +
        `</div>`,
    )
    .join("");
}

function zIndexTable(): string {
  const layers = [
    { var: "--z-dropdown", label: "dropdown", val: "10" },
    { var: "--z-sticky", label: "sticky", val: "20" },
    { var: "--z-modal", label: "modal", val: "50" },
  ];
  return layers
    .map(
      (l) =>
        `<div class="bg-sunken rounded p-2 border border-subtle text-center">` +
        `<div class="text-primary font-semibold text-sm">${l.val}</div>` +
        `<div class="text-muted text-xs font-mono">${l.var}</div>` +
        `<div class="text-muted text-xs">${l.label}</div>` +
        `</div>`,
    )
    .join("");
}

function tableDemo(): import("./layout.js").TrustedHtml {
  const demoRows = [
    html`<tr>
      <td class="px-3 py-2">#1</td>
      <td class="px-3 py-2">openronin/openronin</td>
      <td class="px-3 py-2">${badge({ tone: "success", label: "active", dot: true })}</td>
      <td class="px-3 py-2">${button({ variant: "ghost", size: "sm", label: "View" })}</td>
    </tr>`,
    html`<tr>
      <td class="px-3 py-2">#2</td>
      <td class="px-3 py-2">openronin/docs</td>
      <td class="px-3 py-2">${badge({ tone: "warning", label: "pending", dot: true })}</td>
      <td class="px-3 py-2">${button({ variant: "ghost", size: "sm", label: "View" })}</td>
    </tr>`,
    html`<tr>
      <td class="px-3 py-2">#3</td>
      <td class="px-3 py-2">openronin/playground</td>
      <td class="px-3 py-2">${badge({ tone: "neutral", label: "inactive", dot: true })}</td>
      <td class="px-3 py-2">${button({ variant: "ghost", size: "sm", label: "View" })}</td>
    </tr>`,
  ];
  const fullTable = table({
    columns: [
      { key: "id", label: "#", nowrap: true },
      { key: "name", label: "Name", sortable: true },
      { key: "status", label: "Status", sortable: true },
      { key: "actions", label: "" },
    ],
    rows: demoRows,
    currentSort: { key: "name", dir: "asc" },
  });
  const emptyTable = table({
    columns: [
      { key: "id", label: "#" },
      { key: "name", label: "Name" },
    ],
    rows: [],
    emptyMessage: "No repos configured yet.",
    emptyCta: button({ variant: "primary", size: "sm", label: "Add repo", href: "/admin/repos" }),
  });
  return html`${fullTable}
    <div class="mt-4">${emptyTable}</div>`;
}
