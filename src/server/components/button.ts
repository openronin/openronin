import { raw, escapeHtml, type TrustedHtml } from "../layout.js";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive" | "link";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps {
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  loading?: boolean;
  type?: "button" | "submit" | "reset";
  hxPost?: string;
  hxGet?: string;
  hxPut?: string;
  hxDelete?: string;
  hxTarget?: string;
  hxSwap?: string;
  hxConfirm?: string;
  hxIndicator?: string;
  onclick?: string;
  href?: string;
  title?: string;
  extraClass?: string;
  extraAttrs?: string;
}

const SPINNER =
  `<svg class="btn-spinner" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-hidden="true" stroke="currentColor" stroke-width="3">` +
  `<circle cx="12" cy="12" r="10" stroke-dasharray="60 20" stroke-linecap="round"/>` +
  `</svg>`;

export function button(props: ButtonProps): TrustedHtml {
  const variant = props.variant ?? "secondary";
  const size = props.size ?? "md";
  const isDisabled = props.disabled || props.loading;

  const cls = [
    "btn",
    `btn-${variant}`,
    `btn-${size}`,
    isDisabled ? "btn-disabled" : "",
    props.extraClass ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  const parts: string[] = [`class="${escapeHtml(cls)}"`];
  if (props.hxPost) parts.push(`hx-post="${escapeHtml(props.hxPost)}"`);
  if (props.hxGet) parts.push(`hx-get="${escapeHtml(props.hxGet)}"`);
  if (props.hxPut) parts.push(`hx-put="${escapeHtml(props.hxPut)}"`);
  if (props.hxDelete) parts.push(`hx-delete="${escapeHtml(props.hxDelete)}"`);
  if (props.hxTarget) parts.push(`hx-target="${escapeHtml(props.hxTarget)}"`);
  if (props.hxSwap) parts.push(`hx-swap="${escapeHtml(props.hxSwap)}"`);
  if (props.hxConfirm) parts.push(`hx-confirm="${escapeHtml(props.hxConfirm)}"`);
  if (props.hxIndicator) parts.push(`hx-indicator="${escapeHtml(props.hxIndicator)}"`);
  if (props.onclick) parts.push(`onclick="${escapeHtml(props.onclick)}"`);
  if (props.title) parts.push(`title="${escapeHtml(props.title)}"`);
  if (props.extraAttrs) parts.push(props.extraAttrs);
  if (isDisabled) parts.push("disabled");

  const content = (props.loading ? SPINNER : "") + escapeHtml(props.label);

  if (props.href !== undefined) {
    return raw(`<a href="${escapeHtml(props.href)}" ${parts.join(" ")}>${content}</a>`);
  }

  const type = props.type ?? "button";
  return raw(`<button type="${type}" ${parts.join(" ")}>${content}</button>`);
}
