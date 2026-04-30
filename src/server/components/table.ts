import { html, raw, escapeHtml, type TrustedHtml } from "../layout.js";

export interface TableColumn {
  key: string;
  label: string;
  sortable?: boolean;
  nowrap?: boolean;
}

export interface TableProps {
  columns: TableColumn[];
  rows: TrustedHtml[];
  emptyMessage?: string;
  emptyCta?: TrustedHtml;
  maxHeight?: string;
  currentSort?: { key: string; dir: "asc" | "desc" };
  sortHxGet?: string;
  hxTarget?: string;
  hxSwap?: string;
}

export function table(props: TableProps): TrustedHtml {
  const wrapStyle = props.maxHeight
    ? ` style="max-height:${escapeHtml(props.maxHeight)};overflow-y:auto"`
    : "";

  const headers = props.columns.map((col) => {
    const isActive = props.currentSort?.key === col.key;
    const dir = isActive ? props.currentSort!.dir : undefined;
    const sortClass = col.sortable ? " data-table-sort" : "";
    const dirAttr = dir ? ` data-dir="${dir}"` : "";
    const nowrapAttr = col.nowrap ? ` style="white-space:nowrap"` : "";
    if (col.sortable && props.sortHxGet) {
      const nextDir = isActive && dir === "asc" ? "desc" : "asc";
      const url = `${props.sortHxGet}?sort=${encodeURIComponent(col.key)}&dir=${nextDir}`;
      const hxTarget = props.hxTarget ? ` hx-target="${escapeHtml(props.hxTarget)}"` : "";
      const hxSwap = props.hxSwap ? ` hx-swap="${escapeHtml(props.hxSwap)}"` : "";
      return raw(
        `<th class="data-table-th${sortClass}"${dirAttr}${nowrapAttr} hx-get="${escapeHtml(url)}"${hxTarget}${hxSwap}>${escapeHtml(col.label)}</th>`,
      );
    }
    return raw(
      `<th class="data-table-th${sortClass}"${dirAttr}${nowrapAttr}>${escapeHtml(col.label)}</th>`,
    );
  });

  if (props.rows.length === 0) {
    const colSpan = props.columns.length;
    return html`<div class="data-table-wrap" ${raw(wrapStyle)}>
      <table class="data-table">
        <thead>
          <tr>
            ${headers}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td colspan="${colSpan}" class="data-table-empty">
              <div>${props.emptyMessage ?? "Nothing here yet."}</div>
              ${props.emptyCta ? html`<div class="mt-2">${props.emptyCta}</div>` : raw("")}
            </td>
          </tr>
        </tbody>
      </table>
    </div>`;
  }

  return html`<div class="data-table-wrap" ${raw(wrapStyle)}>
    <table class="data-table">
      <thead>
        <tr>
          ${headers}
        </tr>
      </thead>
      <tbody>
        ${props.rows}
      </tbody>
    </table>
  </div>`;
}
