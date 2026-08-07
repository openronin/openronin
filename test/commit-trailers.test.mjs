import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { setBotIdentity, installCommitTrailersHook } from "../dist/lib/git.js";

function git(cwd, args, opts = {}) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout ?? "";
}

function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), "openronin-trailers-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  return dir;
}

function lastMsg(dir) {
  return git(dir, ["log", "-1", "--format=%B"]);
}

const COAUTHOR = "Co-authored-by: Jane Doe <jane@example.com>";
const hookPath = (dir) => join(dir, ".git", "hooks", "prepare-commit-msg");

test("prepare-commit-msg hook appends the configured trailer to a commit", async () => {
  const dir = initRepo();
  try {
    await setBotIdentity(dir, [COAUTHOR]);
    assert.ok(existsSync(hookPath(dir)), "hook must be installed");
    writeFileSync(join(dir, "a.txt"), "hello\n");
    git(dir, ["add", "a.txt"]);
    git(dir, ["commit", "-q", "-m", "add a"]);
    assert.match(lastMsg(dir), /Co-authored-by: Jane Doe <jane@example\.com>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("does not duplicate a trailer already present in the message", async () => {
  const dir = initRepo();
  try {
    await setBotIdentity(dir, [COAUTHOR]);
    writeFileSync(join(dir, "b.txt"), "hi\n");
    git(dir, ["add", "b.txt"]);
    git(dir, ["commit", "-q", "-m", `add b\n\n${COAUTHOR}`]);
    const count = (lastMsg(dir).match(/Co-authored-by:/g) || []).length;
    assert.equal(count, 1, "trailer must appear exactly once");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("trailer value with shell metacharacters is treated as data, not executed", async () => {
  const dir = initRepo();
  // A pathological value: quotes, $(...), backticks. Must land verbatim and
  // never be evaluated (the data-file + `read` design guarantees this).
  const nasty = 'Co-authored-by: "x" $(touch pwned) `id` <x@e.com>';
  try {
    await setBotIdentity(dir, [nasty]);
    writeFileSync(join(dir, "c.txt"), "yo\n");
    git(dir, ["add", "c.txt"]);
    git(dir, ["commit", "-q", "-m", "add c"]);
    assert.equal(existsSync(join(dir, "pwned")), false, "no command execution");
    assert.match(lastMsg(dir), /\$\(touch pwned\)/, "value landed verbatim");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no trailers configured → no hook installed, message unchanged", async () => {
  const dir = initRepo();
  try {
    await setBotIdentity(dir, []);
    assert.equal(existsSync(hookPath(dir)), false, "no hook when trailers empty");
    writeFileSync(join(dir, "d.txt"), "x\n");
    git(dir, ["add", "d.txt"]);
    git(dir, ["commit", "-q", "-m", "add d"]);
    assert.doesNotMatch(lastMsg(dir), /Co-authored-by:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installCommitTrailersHook is a no-op for empty/whitespace-only trailers", () => {
  const dir = initRepo();
  try {
    installCommitTrailersHook(dir, ["", "   "]);
    assert.equal(existsSync(hookPath(dir)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
