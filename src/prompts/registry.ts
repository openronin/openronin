import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RepoConfig } from "../config/schema.js";

// Resolve the prompts/templates directory relative to the repo root, regardless of
// whether we run from src/ (dev) or dist/ (built).
function templatesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/prompts/registry.js → ../../prompts/templates
  // src/prompts/registry.ts  → ../../prompts/templates
  return resolve(here, "..", "..", "prompts", "templates");
}

export function loadTemplate(name: string, repo?: RepoConfig, dataDir?: string): string {
  if (repo && dataDir) {
    const overridePath = resolve(
      dataDir,
      "prompts",
      "overrides",
      `${repo.provider}--${repo.owner}--${repo.name}--${name}.md`,
    );
    if (existsSync(overridePath)) return readFileSync(overridePath, "utf8");
  }
  const builtin = resolve(templatesDir(), `${name}.md`);
  if (!existsSync(builtin)) {
    throw new Error(`Prompt template not found: ${name} (looked in ${builtin})`);
  }
  return readFileSync(builtin, "utf8");
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (key in vars) return vars[key] ?? "";
    return `{{${key}}}`;
  });
}
