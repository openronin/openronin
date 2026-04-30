import { html, raw, escapeHtml, type TrustedHtml } from "../layout.js";

export interface FormFieldProps {
  label: string;
  control: TrustedHtml;
  id?: string;
  helper?: string;
  error?: string;
}

export interface InputProps {
  name: string;
  id?: string;
  type?: "text" | "number" | "password" | "email" | "url";
  value?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  hasError?: boolean;
  extraClass?: string;
  extraAttrs?: string;
}

export interface SelectProps {
  name: string;
  id?: string;
  options: { value: string; label: string }[];
  value?: string;
  disabled?: boolean;
  required?: boolean;
  hasError?: boolean;
  extraClass?: string;
}

export interface TextareaProps {
  name: string;
  id?: string;
  value?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  mono?: boolean;
  rows?: number;
  hasError?: boolean;
  extraClass?: string;
  extraAttrs?: string;
}

export interface CheckboxProps {
  name: string;
  id?: string;
  label: string;
  checked?: boolean;
  disabled?: boolean;
  value?: string;
}

export interface ToggleProps {
  name: string;
  id?: string;
  label: string;
  checked?: boolean;
  disabled?: boolean;
}

export interface YamlEditorProps {
  name: string;
  id?: string;
  value?: string;
  rows?: number;
  disabled?: boolean;
}

export function formField(props: FormFieldProps): TrustedHtml {
  const forAttr = props.id ? ` for="${escapeHtml(props.id)}"` : "";
  return html`<div class="form-field">
    <label class="form-label" ${raw(forAttr)}>${props.label}</label>
    ${props.control}
    ${props.helper ? html`<span class="form-helper">${props.helper}</span>` : raw("")}
    ${props.error ? html`<span class="form-error" role="alert">${props.error}</span>` : raw("")}
  </div>`;
}

export function formInput(props: InputProps): TrustedHtml {
  const id = props.id ?? props.name;
  const cls = ["form-input", props.hasError ? "form-input-error" : "", props.extraClass ?? ""]
    .filter(Boolean)
    .join(" ");
  const attrs: string[] = [
    `id="${escapeHtml(id)}"`,
    `name="${escapeHtml(props.name)}"`,
    `type="${props.type ?? "text"}"`,
    `class="${escapeHtml(cls)}"`,
  ];
  if (props.value !== undefined) attrs.push(`value="${escapeHtml(props.value)}"`);
  if (props.placeholder) attrs.push(`placeholder="${escapeHtml(props.placeholder)}"`);
  if (props.disabled) attrs.push("disabled");
  if (props.required) attrs.push("required");
  if (props.extraAttrs) attrs.push(props.extraAttrs);
  return raw(`<input ${attrs.join(" ")}>`);
}

export function formSelect(props: SelectProps): TrustedHtml {
  const id = props.id ?? props.name;
  const cls = ["form-select", props.hasError ? "form-select-error" : "", props.extraClass ?? ""]
    .filter(Boolean)
    .join(" ");
  const attrs = [
    `id="${escapeHtml(id)}"`,
    `name="${escapeHtml(props.name)}"`,
    `class="${escapeHtml(cls)}"`,
    ...(props.disabled ? ["disabled"] : []),
    ...(props.required ? ["required"] : []),
  ];
  const options = props.options
    .map(
      (o) =>
        `<option value="${escapeHtml(o.value)}"${o.value === props.value ? " selected" : ""}>${escapeHtml(o.label)}</option>`,
    )
    .join("");
  return raw(`<select ${attrs.join(" ")}>${options}</select>`);
}

export function formTextarea(props: TextareaProps): TrustedHtml {
  const id = props.id ?? props.name;
  const cls = [
    "form-textarea",
    props.mono ? "form-textarea-mono" : "",
    props.hasError ? "form-textarea-error" : "",
    props.extraClass ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  const attrs: string[] = [
    `id="${escapeHtml(id)}"`,
    `name="${escapeHtml(props.name)}"`,
    `class="${escapeHtml(cls)}"`,
  ];
  if (props.rows) attrs.push(`rows="${props.rows}"`);
  if (props.placeholder) attrs.push(`placeholder="${escapeHtml(props.placeholder)}"`);
  if (props.disabled) attrs.push("disabled");
  if (props.required) attrs.push("required");
  if (props.extraAttrs) attrs.push(props.extraAttrs);
  return raw(
    `<textarea ${attrs.join(" ")}>${props.value !== undefined ? escapeHtml(props.value) : ""}</textarea>`,
  );
}

export function formCheckbox(props: CheckboxProps): TrustedHtml {
  const id = props.id ?? props.name;
  const attrs = [
    `type="checkbox"`,
    `id="${escapeHtml(id)}"`,
    `name="${escapeHtml(props.name)}"`,
    `class="form-checkbox"`,
  ];
  if (props.value !== undefined) attrs.push(`value="${escapeHtml(props.value)}"`);
  if (props.checked) attrs.push("checked");
  if (props.disabled) attrs.push("disabled");
  return html`<label class="form-check-wrap" for="${id}">
    <input ${raw(attrs.join(" "))} />
    <span>${props.label}</span>
  </label>`;
}

export function formToggle(props: ToggleProps): TrustedHtml {
  const id = props.id ?? props.name;
  const attrs = [
    `type="checkbox"`,
    `id="${escapeHtml(id)}"`,
    `name="${escapeHtml(props.name)}"`,
    `class="form-toggle"`,
    `role="switch"`,
  ];
  if (props.checked) attrs.push("checked");
  if (props.disabled) attrs.push("disabled");
  return html`<label class="form-toggle-wrap" for="${id}">
    <input ${raw(attrs.join(" "))} />
    <span>${props.label}</span>
  </label>`;
}

export function yamlEditor(props: YamlEditorProps): TrustedHtml {
  const id = props.id ?? props.name;
  const value = props.value ?? "";
  const lineCount = Math.max(value.split("\n").length, 5);
  const gutterNums = Array.from({ length: lineCount }, (_, i) => i + 1).join("\n");
  const rows = props.rows ?? Math.max(lineCount, 8);

  const taAttrs = [
    `id="${escapeHtml(id)}"`,
    `name="${escapeHtml(props.name)}"`,
    `class="yaml-editor"`,
    `rows="${rows}"`,
    `spellcheck="false"`,
    `autocomplete="off"`,
    `wrap="off"`,
    ...(props.disabled ? ["disabled"] : []),
  ].join(" ");

  const initScript =
    `(function(){` +
    `var sc=document.currentScript,w=sc&&sc.previousElementSibling;` +
    `if(!w)return;` +
    `var ta=w.querySelector('textarea'),g=w.querySelector('.yaml-gutter');` +
    `if(!ta||!g)return;` +
    `function sync(){` +
    `var n=Math.max(ta.value.split('\\n').length,1);` +
    `g.textContent=Array.from({length:n},function(_,i){return i+1;}).join('\\n');` +
    `g.scrollTop=ta.scrollTop;` +
    `}` +
    `ta.addEventListener('input',sync);` +
    `ta.addEventListener('scroll',function(){g.scrollTop=ta.scrollTop;});` +
    `})();`;

  return raw(
    `<div class="yaml-editor-wrap">` +
      `<div class="yaml-gutter" aria-hidden="true">${gutterNums}</div>` +
      `<textarea ${taAttrs}>${escapeHtml(value)}</textarea>` +
      `</div>` +
      `<script>${initScript}</script>`,
  );
}
