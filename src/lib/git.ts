import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

export interface GitRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export function runGit(
  workdir: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<GitRunResult> {
  return new Promise((res, rej) => {
    const child = spawn("git", args, {
      cwd: workdir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...opts.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let stdout = "";
    let stderr = "";
    let killTimer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      killTimer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      if (killTimer) clearTimeout(killTimer);
      rej(err);
    });
    child.on("close", (code) => {
      if (killTimer) clearTimeout(killTimer);
      res({ stdout, stderr, code });
    });
  });
}

// Strip token-bearing URLs and bare PATs from any string we might surface
// in logs / comments / error messages.
export function scrubSecrets(s: string): string {
  return s
    .replace(/https:\/\/[^:@\s]+:[^@\s]+@/g, "https://[redacted]@")
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, "[redacted-token]");
}

export async function runGitChecked(workdir: string, args: string[]): Promise<string> {
  const r = await runGit(workdir, args, { timeoutMs: 5 * 60 * 1000 });
  if (r.code !== 0) {
    const safeArgs = args.map(scrubSecrets).join(" ");
    const safeErr = scrubSecrets(r.stderr.slice(0, 500) || r.stdout.slice(0, 500));
    throw new Error(`git ${safeArgs} failed (${r.code}): ${safeErr}`);
  }
  return r.stdout;
}

export interface CloneOptions {
  url: string;
  workdir: string;
  branch?: string;
  depth?: number;
}

export async function clone(opts: CloneOptions): Promise<void> {
  if (existsSync(opts.workdir)) rmSync(opts.workdir, { recursive: true, force: true });
  mkdirSync(opts.workdir, { recursive: true });
  const args = ["clone", "--depth", String(opts.depth ?? 50)];
  if (opts.branch) args.push("--branch", opts.branch);
  args.push("--single-branch", opts.url, ".");
  await runGitChecked(opts.workdir, args);
}

export async function setIdentity(workdir: string, name: string, email: string): Promise<void> {
  await runGitChecked(workdir, ["config", "user.name", name]);
  await runGitChecked(workdir, ["config", "user.email", email]);
}

/**
 * Default bot git identity used by patch / pr-dialog / conflict-resolve lanes
 * when authoring commits. Overridable via env vars so each deployment can
 * present its own bot account without code changes:
 *
 *   OPENRONIN_BOT_GIT_NAME   default: "openronin[bot]"
 *   OPENRONIN_BOT_GIT_EMAIL  default: "openronin-bot@users.noreply.github.com"
 *
 * The default email uses GitHub's noreply domain — it doesn't require owning
 * a real mailbox and won't bounce.
 */
export function getBotIdentity(): { name: string; email: string } {
  return {
    name: process.env.OPENRONIN_BOT_GIT_NAME ?? "openronin[bot]",
    email: process.env.OPENRONIN_BOT_GIT_EMAIL ?? "openronin-bot@users.noreply.github.com",
  };
}

export async function setBotIdentity(workdir: string): Promise<void> {
  const id = getBotIdentity();
  await setIdentity(workdir, id.name, id.email);
}

export async function getCurrentSha(workdir: string): Promise<string> {
  const out = await runGitChecked(workdir, ["rev-parse", "HEAD"]);
  return out.trim();
}

export async function checkoutNewBranch(workdir: string, branch: string): Promise<void> {
  await runGitChecked(workdir, ["checkout", "-b", branch]);
}

export interface DiffStats {
  hasChanges: boolean;
  filesChanged: string[];
  linesAdded: number;
  linesRemoved: number;
}

export async function diffStats(workdir: string): Promise<DiffStats> {
  const status = await runGitChecked(workdir, ["status", "--porcelain"]);
  if (!status.trim())
    return { hasChanges: false, filesChanged: [], linesAdded: 0, linesRemoved: 0 };

  const files = status
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^.{2,3}\s+/, "").trim());

  const numstat = await runGitChecked(workdir, ["diff", "HEAD", "--numstat"]);
  let added = 0;
  let removed = 0;
  for (const line of numstat.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2) {
      const a = Number(parts[0]);
      const r = Number(parts[1]);
      if (!Number.isNaN(a)) added += a;
      if (!Number.isNaN(r)) removed += r;
    }
  }
  return { hasChanges: true, filesChanged: files, linesAdded: added, linesRemoved: removed };
}

export async function commitAll(workdir: string, message: string): Promise<void> {
  await runGitChecked(workdir, ["add", "-A"]);
  await runGitChecked(workdir, ["commit", "-m", message]);
}

// Push using a token-authenticated URL so we don't rely on the workdir's
// stored creds.
//
// If a plain push is rejected because the remote already has the branch
// from a previous (crashed / interrupted) run of the same task, fall back
// to a force-with-lease push: fetch the remote head, then force the push
// gated by it. The lease protects against the unlikely case of a concurrent
// writer pushing to the same branch in between our fetch and our push.
export async function pushBranchWithToken(
  workdir: string,
  remoteUrl: string,
  branch: string,
  token: string,
): Promise<void> {
  const auth = remoteUrl.replace(/^https:\/\//, `https://x-access-token:${token}@`);
  try {
    await runGitChecked(workdir, ["push", auth, `${branch}:${branch}`]);
    return;
  } catch (e) {
    if (!isNonFastForwardRejection(e)) throw e;
  }
  // Refetch the remote branch so we know exactly what's there, then force-push
  // with an explicit lease against that sha.
  await runGitChecked(workdir, [
    "fetch",
    "--no-tags",
    "--depth",
    "100",
    auth,
    `+${branch}:refs/remotes/origin/${branch}`,
  ]);
  const expected = (
    await runGitChecked(workdir, ["rev-parse", `refs/remotes/origin/${branch}`])
  ).trim();
  await runGitChecked(workdir, [
    "push",
    `--force-with-lease=${branch}:${expected}`,
    auth,
    `${branch}:${branch}`,
  ]);
}

function isNonFastForwardRejection(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message;
  return (
    /\[rejected\]/.test(msg) &&
    (/fetch first/.test(msg) ||
      /non-fast-forward/i.test(msg) ||
      /failed to push some refs/i.test(msg))
  );
}

export function workdirFor(
  dataDir: string,
  providerOwner: string,
  name: string,
  taskId: number,
): string {
  return resolve(dataDir, "work", providerOwner, name, String(taskId));
}

export function cleanupWorkdir(workdir: string): void {
  if (existsSync(workdir)) {
    try {
      rmSync(workdir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

export function slugify(s: string, maxLen = 40): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/, "");
}

// ---------------------------------------------------------------------------
// Rebase / conflict resolution helpers
// ---------------------------------------------------------------------------

// Fetch a single ref from origin into the local repo. Used before rebase so
// `origin/<ref>` is up to date.
//
// We always pass the explicit refspec `<ref>:refs/remotes/origin/<ref>` so
// it works even on `--single-branch` clones where the configured fetch
// refspec would otherwise restrict updates to the original branch only.
export async function fetchRef(workdir: string, ref: string): Promise<void> {
  await runGitChecked(workdir, [
    "fetch",
    "--no-tags",
    "--depth",
    "100",
    "origin",
    // Leading '+' allows non-fast-forward updates of the remote-tracking ref,
    // which we want — base branches can be force-pushed.
    `+${ref}:refs/remotes/origin/${ref}`,
  ]);
}

// Make sure the working tree is on `branch` and matches origin/<branch>. If
// the tree is already there but stale, fast-forward to remote. Caller must
// have run fetchRef(workdir, branch) before.
export async function syncToRemoteBranch(workdir: string, branch: string): Promise<void> {
  // git rev-parse will fail if the local branch ref doesn't exist yet.
  const local = await runGit(workdir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (local.code === 0) {
    await runGitChecked(workdir, ["checkout", branch]);
    await runGitChecked(workdir, ["reset", "--hard", `origin/${branch}`]);
  } else {
    await runGitChecked(workdir, ["checkout", "-b", branch, `origin/${branch}`]);
  }
}

export interface RebaseStep {
  ok: boolean;
  conflictedFiles?: string[];
  // Raw stderr/stdout for diagnostics if the rebase failed for non-conflict reasons.
  diagnostic?: string;
}

// Try to rebase the current branch onto `onto` (e.g. "origin/main"). Returns
// ok=true if no conflicts, otherwise the list of files needing manual edits.
// On a clean rebase the rebase is "in not in progress" state; on conflict
// the rebase is paused mid-flight (so caller can resolve and `--continue`
// or call rebaseAbort()).
export async function startRebaseOnto(workdir: string, onto: string): Promise<RebaseStep> {
  const r = await runGit(workdir, ["rebase", onto], { timeoutMs: 5 * 60 * 1000 });
  if (r.code === 0) return { ok: true };
  const conflicted = await getConflictedFiles(workdir);
  if (conflicted.length > 0) return { ok: false, conflictedFiles: conflicted };
  // Rebase failed for some other reason (e.g. detached HEAD, missing onto). Abort
  // so the working tree is left clean.
  await rebaseAbort(workdir);
  return { ok: false, diagnostic: scrubSecrets((r.stderr || r.stdout || "").slice(0, 500)) };
}

// Continue an interrupted rebase. Same return semantics as startRebaseOnto.
export async function continueRebase(workdir: string): Promise<RebaseStep> {
  const r = await runGit(workdir, ["-c", "core.editor=true", "rebase", "--continue"], {
    timeoutMs: 5 * 60 * 1000,
  });
  if (r.code === 0) return { ok: true };
  const conflicted = await getConflictedFiles(workdir);
  if (conflicted.length > 0) return { ok: false, conflictedFiles: conflicted };
  await rebaseAbort(workdir);
  return { ok: false, diagnostic: scrubSecrets((r.stderr || r.stdout || "").slice(0, 500)) };
}

// Abort an in-progress rebase. Best-effort — silently swallows errors so it
// can be called from cleanup paths.
export async function rebaseAbort(workdir: string): Promise<void> {
  await runGit(workdir, ["rebase", "--abort"]);
}

// Returns paths of files in the unmerged state (`U` in `git status --porcelain=v1`).
// These are the files the agent has to fix.
export async function getConflictedFiles(workdir: string): Promise<string[]> {
  // --porcelain=v1: each entry has a 2-char status. "UU" means both modified
  // (the typical text conflict). "AA", "DD", "AU", "UA", "DU", "UD" are the
  // other unmerged combinations. We treat all of them as files needing
  // attention.
  const r = await runGitChecked(workdir, ["status", "--porcelain=v1", "-z"]);
  const out: string[] = [];
  for (const entry of r.split("\0")) {
    if (!entry) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (
      code === "UU" ||
      code === "AA" ||
      code === "DD" ||
      code === "AU" ||
      code === "UA" ||
      code === "DU" ||
      code === "UD"
    ) {
      out.push(path);
    }
  }
  return out;
}

const CONFLICT_MARKER_RE = /^(<{7}|={7}|>{7})/m;

// Returns true if a string contains any of the standard conflict markers
// (`<<<<<<<`, `=======`, `>>>>>>>`) at line start. Used to validate that
// the agent actually resolved the conflicts.
export function hasConflictMarkers(content: string): boolean {
  return CONFLICT_MARKER_RE.test(content);
}

// Convenience: read a file from the workdir and check for markers.
export function fileHasConflictMarkers(workdir: string, path: string): boolean {
  const full = resolve(workdir, path);
  if (!existsSync(full)) return false; // deleted-on-our-side resolutions are valid
  try {
    return hasConflictMarkers(readFileSync(full, "utf8"));
  } catch {
    return false;
  }
}

// `git add` a list of (resolved) files. Caller is responsible for verifying
// they no longer contain conflict markers.
export async function addPaths(workdir: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await runGitChecked(workdir, ["add", "--", ...paths]);
}

// Force-push with lease — refuses to clobber remote work that someone else
// pushed in between our last fetch and this push. If `expectedRemoteSha`
// is provided we pass it as the explicit lease expectation, which works
// reliably even when the local repo was set up via single-branch clone
// (where Git refuses to honour the implicit lease form with a "stale info"
// rejection because it doesn't believe its own remote-tracking ref).
export async function forcePushWithLease(
  workdir: string,
  remoteUrl: string,
  branch: string,
  token: string,
  expectedRemoteSha?: string,
): Promise<void> {
  const auth = remoteUrl.replace(/^https:\/\//, `https://x-access-token:${token}@`);
  const leaseArg = expectedRemoteSha
    ? `--force-with-lease=${branch}:${expectedRemoteSha}`
    : `--force-with-lease`;
  await runGitChecked(workdir, ["push", leaseArg, auth, `${branch}:${branch}`]);
}

// Returns true if a rebase is in progress (REBASE_HEAD or rebase-merge dir
// exists). Useful for cleanup at the start of a run.
export function rebaseInProgress(workdir: string): boolean {
  return (
    existsSync(resolve(workdir, ".git", "rebase-merge")) ||
    existsSync(resolve(workdir, ".git", "rebase-apply"))
  );
}
