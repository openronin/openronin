import { html, raw, type TrustedHtml } from "../layout.js";

export type CardVariant = "bordered" | "elevated" | "inset";
export type CardPadding = "sm" | "md" | "lg";

export interface CardProps {
  title?: string;
  actions?: TrustedHtml;
  body: TrustedHtml;
  variant?: CardVariant;
  padding?: CardPadding;
}

export function card(props: CardProps): TrustedHtml {
  const variant = props.variant ?? "bordered";
  const padClass =
    props.padding === "sm" ? "card-body-sm" : props.padding === "lg" ? "card-body-lg" : "card-body";

  const header =
    props.title !== undefined || props.actions !== undefined
      ? html`<div class="card-header">
          ${props.title !== undefined
            ? html`<div class="card-title">${props.title}</div>`
            : raw("")}
          ${props.actions !== undefined
            ? html`<div class="card-actions">${props.actions}</div>`
            : raw("")}
        </div>`
      : raw("");

  return html`<div class="card card-${variant}">
    ${header}
    <div class="${padClass}">${props.body}</div>
  </div>`;
}
