import { raw, escapeHtml, type TrustedHtml } from "../layout.js";

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";
export type BadgeVariant = "soft" | "solid" | "outline";

export interface BadgeProps {
  label: string;
  tone?: BadgeTone;
  variant?: BadgeVariant;
  dot?: boolean;
}

export function badge(props: BadgeProps): TrustedHtml {
  const tone = props.tone ?? "neutral";
  const variant = props.variant ?? "soft";
  const cls = variant === "soft" ? `bdg bdg-${tone}` : `bdg bdg-${variant}-${tone}`;
  const dot = props.dot ? `<span aria-hidden="true">● </span>` : "";
  return raw(`<span class="${cls}">${dot}${escapeHtml(props.label)}</span>`);
}
