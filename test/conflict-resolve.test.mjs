import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { hasConflictMarkers, fileHasConflictMarkers } from "../dist/lib/git.js";

test("hasConflictMarkers detects standard markers at line start", () => {
  assert.equal(hasConflictMarkers("plain text"), false);
  assert.equal(hasConflictMarkers(""), false);
  assert.equal(hasConflictMarkers("foo <<<<<<<HEAD bar"), false, "marker not at line start");
  assert.equal(
    hasConflictMarkers("foo\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> base\n"),
    true,
  );
  assert.equal(hasConflictMarkers(">>>>>>> base"), true);
  assert.equal(hasConflictMarkers("=======\n"), true);
});

test("fileHasConflictMarkers reads file from workdir", () => {
  const dir = mkdtempSync(join(tmpdir(), "aidev-conflict-"));
  try {
    writeFileSync(join(dir, "clean.txt"), "no conflict here\n");
    writeFileSync(join(dir, "dirty.txt"), "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> base\n");
    assert.equal(fileHasConflictMarkers(dir, "clean.txt"), false);
    assert.equal(fileHasConflictMarkers(dir, "dirty.txt"), true);
    // Missing file is fine — treat as resolved (deletion case).
    assert.equal(fileHasConflictMarkers(dir, "missing.txt"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Full end-to-end git plumbing test: synthesize a real conflict in a git
// repo and verify our helpers report the right files. This guards against
// regressions in startRebaseOnto / getConflictedFiles status parsing.
test("rebase helpers detect real conflicts and abort cleanly", async () => {
  const root = mkdtempSync(join(tmpdir(), "aidev-rebase-"));
  const upstream = join(root, "upstream.git");
  const work = join(root, "work");
  try {
    spawnSync("git", ["init", "--bare", "-b", "main", upstream], { stdio: "ignore" });
    spawnSync("git", ["clone", upstream, work], { stdio: "ignore" });
    const cfg = (args) => spawnSync("git", ["-C", work, ...args], { stdio: "pipe" });
    cfg(["config", "user.email", "test@local"]);
    cfg(["config", "user.name", "Test"]);

    writeFileSync(join(work, "f.txt"), "line1\nline2\nline3\n");
    cfg(["add", "f.txt"]);
    cfg(["commit", "-m", "init"]);
    cfg(["push", "origin", "main"]);

    // base advances on main with a conflicting change to line2
    writeFileSync(join(work, "f.txt"), "line1\nMAIN\nline3\n");
    cfg(["add", "f.txt"]);
    cfg(["commit", "-m", "main change"]);
    cfg(["push", "origin", "main"]);

    // feature branch from one commit before, with its own change to line2
    cfg(["checkout", "-b", "feature", "HEAD~1"]);
    writeFileSync(join(work, "f.txt"), "line1\nFEATURE\nline3\n");
    cfg(["add", "f.txt"]);
    cfg(["commit", "-m", "feature change"]);
    cfg(["push", "origin", "feature"]);

    // Now use our helpers
    const { fetchRef, syncToRemoteBranch, startRebaseOnto, rebaseAbort, rebaseInProgress } =
      await import("../dist/lib/git.js");

    await fetchRef(work, "main");
    await syncToRemoteBranch(work, "feature");
    const step = await startRebaseOnto(work, "origin/main");
    assert.equal(step.ok, false, "expected conflict");
    assert.deepEqual(step.conflictedFiles, ["f.txt"], "expected f.txt to be conflicted");
    assert.equal(rebaseInProgress(work), true);
    await rebaseAbort(work);
    assert.equal(rebaseInProgress(work), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
