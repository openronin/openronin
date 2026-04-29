import { existsSync, mkdirSync, readFileSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import {
  GlobalConfigSchema,
  RepoConfigSchema,
  RuntimeConfigSchema,
  type RuntimeConfig,
} from "./schema.js";

interface LoadOptions {
  dataDir?: string;
}

export function resolveDataDir(override?: string): string {
  return resolve(override ?? process.env.OPENRONIN_DATA_DIR ?? "./.dev-data");
}

export function ensureDataDirs(dataDir: string): void {
  for (const sub of [
    "db",
    "config",
    "config/repos",
    "prompts/overrides",
    "work",
    "reports",
    "logs",
    "backup",
  ]) {
    mkdirSync(resolve(dataDir, sub), { recursive: true });
  }
}

export function loadConfig(options: LoadOptions = {}): RuntimeConfig {
  const dataDir = resolveDataDir(options.dataDir);
  ensureDataDirs(dataDir);

  const globalRaw = readGlobalConfig(dataDir);
  const global = GlobalConfigSchema.parse(applyEnvOverrides(globalRaw));

  const repos = readRepoConfigs(dataDir);

  return RuntimeConfigSchema.parse({ dataDir, global, repos });
}

function readGlobalConfig(dataDir: string): unknown {
  const path = resolve(dataDir, "config", "openronin.yaml");
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  return YAML.parse(raw) ?? {};
}

function readRepoConfigs(dataDir: string): unknown[] {
  const dir = resolve(dataDir, "config", "repos");
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir).filter((name) => /\.ya?ml$/i.test(name));
  const out: unknown[] = [];
  for (const entry of entries) {
    const path = resolve(dir, entry);
    try {
      const parsed = YAML.parse(readFileSync(path, "utf8")) ?? {};
      const validated = RepoConfigSchema.parse(parsed);
      out.push(validated);
    } catch (error) {
      console.error(`[config] invalid repo config ${entry}:`, error);
    }
  }
  return out;
}

// Env vars override a small set of server-level fields. Keep this minimal —
// most config belongs in YAML under admin-UI control.
function applyEnvOverrides(raw: unknown): unknown {
  const obj = (
    raw && typeof raw === "object" ? { ...(raw as Record<string, unknown>) } : {}
  ) as Record<string, unknown>;
  const server = (
    obj.server && typeof obj.server === "object" ? { ...(obj.server as object) } : {}
  ) as Record<string, unknown>;
  if (process.env.OPENRONIN_PORT) server.port = Number(process.env.OPENRONIN_PORT);
  if (process.env.OPENRONIN_BASE_URL) server.baseUrl = process.env.OPENRONIN_BASE_URL;
  if (process.env.OPENRONIN_ADMIN_USER) server.adminUser = process.env.OPENRONIN_ADMIN_USER;
  obj.server = server;
  return obj;
}

// Watch the config directory and call onChange when any YAML changes.
// Returns a stop function. Debounced because editors trigger multiple events per save.
export function watchConfig(dataDir: string, onChange: () => void): () => void {
  const dir = resolve(dataDir, "config");
  ensureDataDirs(dataDir);
  const watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | undefined;

  const trigger = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        onChange();
      } catch (error) {
        console.error("[config] reload failed:", error);
      }
    }, 200);
  };

  const tryWatch = (path: string): void => {
    try {
      const w = watch(path, { recursive: true }, () => trigger());
      watchers.push(w);
    } catch {
      // recursive watch not supported on some platforms — fall back to non-recursive
      try {
        const w = watch(path, () => trigger());
        watchers.push(w);
      } catch (error) {
        console.error("[config] cannot watch", path, error);
      }
    }
  };

  tryWatch(dir);
  tryWatch(resolve(dir, "repos"));

  return () => {
    for (const w of watchers) w.close();
    if (timer) clearTimeout(timer);
  };
}
