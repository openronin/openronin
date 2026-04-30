import { createHash } from "node:crypto";
import type { VcsItem } from "../providers/vcs.js";

export function computeItemSnapshot(item: VcsItem): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        title: item.title,
        body: item.body.slice(0, 8000),
        state: item.state,
        labels: [...item.labels].sort().join(","),
        updatedAt: item.updatedAt,
        author: item.author,
      }),
    )
    .digest("hex")
    .slice(0, 16);
}
