import { existsSync } from "node:fs";
import { join } from "node:path";

export function isPaused(dataDir: string): boolean {
  return existsSync(join(dataDir, ".PAUSE"));
}
