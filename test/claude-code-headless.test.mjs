import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaudeCodeEngine, buildClaudeArgs, buildClaudeEnv } from "../dist/engines/claude-code.js";

test("buildClaudeArgs: Monitor is disallowed in headless runs", () => {
  const args = buildClaudeArgs("sonnet", { tools: "git-write", userPrompt: "x" });
  const i = args.indexOf("--disallowedTools");
  assert.ok(i >= 0, "--disallowedTools is passed");
  assert.deepEqual(args[i + 1].split(","), ["Monitor"]);
});

test("buildClaudeArgs: optional flags still follow the fixed ones", () => {
  const args = buildClaudeArgs("opus", {
    tools: "read-only",
    userPrompt: "x",
    maxBudgetUsd: 2,
    systemPrompt: "sys",
  });
  assert.deepEqual(args.slice(-4), ["--max-budget-usd", "2", "--append-system-prompt", "sys"]);
  assert.equal(args[args.indexOf("--model") + 1], "opus");
});

test("buildClaudeEnv: disables background tasks and keeps the rest of the environment", () => {
  const env = buildClaudeEnv({ PATH: "/usr/bin", HOME: "/home/x" });
  assert.equal(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, "1");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/x");
});

test("ClaudeCodeEngine.run: the spawned CLI gets the headless flag and env", async () => {
  const dir = mkdtempSync(join(tmpdir(), "openronin-claude-"));
  const record = join(dir, "record.txt");
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > "${record}"`,
      `printf 'BG=%s\\n' "$CLAUDE_CODE_DISABLE_BACKGROUND_TASKS" >> "${record}"`,
      "cat > /dev/null",
      `printf '{"type":"result","result":"ok"}'`,
    ].join("\n"),
  );
  chmodSync(bin, 0o755);

  const result = await new ClaudeCodeEngine({ binary: bin }).run({
    userPrompt: "hello",
    tools: "git-write",
    workdir: dir,
  });

  assert.equal(result.content, "ok");
  const lines = readFileSync(record, "utf8").trim().split("\n");
  assert.equal(lines[lines.indexOf("--disallowedTools") + 1], "Monitor");
  assert.ok(lines.includes("BG=1"), "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 reaches the CLI");
});
