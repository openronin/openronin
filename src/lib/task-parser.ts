export interface ParsedTask {
  repoKey: string | null;
  title: string;
  body: string;
}

interface WatchedRepo {
  owner: string;
  name: string;
}

// Parse a free-text message into a task.
// Repo detection order:
//   1. Explicit "repo=owner/name" or "repo=name" anywhere in text
//   2. If only one watched repo exists, use it
//   3. null — caller must reject or prompt
export function parseTaskText(text: string, watchedRepos: WatchedRepo[]): ParsedTask {
  const body = text.trim();

  const repoMatch = body.match(/\brepo[=:]\s*(\S+)/i);
  let repoKey: string | null = null;

  if (repoMatch) {
    const ref = repoMatch[1]!.replace(/[,;]+$/, "");
    const found = watchedRepos.find(
      (r) =>
        `${r.owner}/${r.name}`.toLowerCase() === ref.toLowerCase() ||
        r.name.toLowerCase() === ref.toLowerCase(),
    );
    if (found) repoKey = `${found.owner}/${found.name}`;
  }

  if (!repoKey && watchedRepos.length === 1) {
    repoKey = `${watchedRepos[0]!.owner}/${watchedRepos[0]!.name}`;
  }

  const firstLine = (body.split("\n")[0] ?? body).trim();
  const title = firstLine.replace(/\brepo[=:]\s*\S+\s*/i, "").trim() || firstLine;

  return { repoKey, title, body };
}
