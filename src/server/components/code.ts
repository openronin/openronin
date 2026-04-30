import { raw, escapeHtml, type TrustedHtml } from "../layout.js";

export interface CodeBlockProps {
  code: string;
  lang?: string;
  copyButton?: boolean;
}

export function codeInline(content: string): TrustedHtml {
  return raw(`<code class="code-inline">${escapeHtml(content)}</code>`);
}

export function codeBlock(props: CodeBlockProps): TrustedHtml {
  const inner = props.lang === "yaml" ? highlightYaml(props.code) : escapeHtml(props.code);
  const copyBtn = props.copyButton
    ? `<button class="code-copy-btn" type="button" onclick="(function(b){` +
      `var pre=b.closest('.code-block-wrap').querySelector('pre');` +
      `navigator.clipboard&&navigator.clipboard.writeText(pre.innerText)` +
      `.then(function(){b.textContent='Copied!';setTimeout(function(){b.textContent='Copy';},1500);})` +
      `})(this)">Copy</button>`
    : "";
  return raw(
    `<div class="code-block-wrap">${copyBtn}<pre class="code-block"><code>${inner}</code></pre></div>`,
  );
}

function highlightYaml(code: string): string {
  return code
    .split("\n")
    .map((line) => {
      const m = line.match(/^( *)([\w][\w.-]*)(:)( *)(.*)$/);
      if (!m) return escapeHtml(line);
      const indent = m[1] ?? "";
      const key = m[2] ?? "";
      const colon = m[3] ?? "";
      const space = m[4] ?? "";
      const rest = m[5] ?? "";
      const header =
        `${escapeHtml(indent)}<span class="yaml-key">${escapeHtml(key)}</span>` +
        `${escapeHtml(colon)}${escapeHtml(space)}`;
      if (!rest) return header;
      const trimmed = rest.trimStart();
      if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
        return `${header}<span class="yaml-string">${escapeHtml(rest)}</span>`;
      }
      return `${header}${escapeHtml(rest)}`;
    })
    .join("\n");
}
