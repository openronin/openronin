import { test } from "node:test";
import assert from "node:assert/strict";

import {
  detectClaudeRateLimit,
  extractDeniedBashCommands,
  mapPermission,
  parseClaudeResetTime,
} from "../dist/engines/claude-code.js";
import { RateLimited } from "../dist/engines/types.js";

test("parseClaudeResetTime: 7am Moscow → next 04:00 UTC", () => {
  // Sample 'now' = 2026-04-28T01:00:00Z. 7am Moscow = 04:00 UTC. That's
  // still in the future today, so we expect today's 04:00 UTC.
  const now = new Date("2026-04-28T01:00:00Z");
  const reset = parseClaudeResetTime("resets 7am (Europe/Moscow)", now);
  assert.ok(reset);
  assert.equal(reset.toISOString(), "2026-04-28T04:00:00.000Z");
});

test("parseClaudeResetTime: 7am Moscow when past today → tomorrow", () => {
  // Now = 2026-04-28T05:00:00Z (already past 04:00 UTC). Expect tomorrow's 04:00 UTC.
  const now = new Date("2026-04-28T05:00:00Z");
  const reset = parseClaudeResetTime("resets 7am (Europe/Moscow)", now);
  assert.ok(reset);
  assert.equal(reset.toISOString(), "2026-04-29T04:00:00.000Z");
});

test("parseClaudeResetTime: 7:30pm Moscow handles minute and meridiem", () => {
  const now = new Date("2026-04-28T01:00:00Z");
  const reset = parseClaudeResetTime("resets 7:30pm (Europe/Moscow)", now);
  assert.ok(reset);
  // 7:30pm Moscow = 16:30 UTC.
  assert.equal(reset.toISOString(), "2026-04-28T16:30:00.000Z");
});

test("parseClaudeResetTime: returns null when timezone is unknown", () => {
  const now = new Date("2026-04-28T01:00:00Z");
  assert.equal(parseClaudeResetTime("resets 7am (America/New_York)", now), null);
});

test("parseClaudeResetTime: returns null on unparseable text", () => {
  assert.equal(parseClaudeResetTime("totally unrelated", new Date()), null);
});

test("detectClaudeRateLimit: spots api_error_status=429", () => {
  const stdout = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: true,
    api_error_status: 429,
    result: "You've hit your limit · resets 7am (Europe/Moscow)",
  });
  const err = detectClaudeRateLimit(stdout);
  assert.ok(err instanceof RateLimited);
  assert.equal(err.engineId, "claude_code");
  assert.ok(err.resetAt instanceof Date);
});

test("detectClaudeRateLimit: returns null on a normal error", () => {
  const stdout = JSON.stringify({
    is_error: true,
    api_error_status: 500,
    result: "internal server error",
  });
  assert.equal(detectClaudeRateLimit(stdout), null);
});

test("detectClaudeRateLimit: returns null on non-JSON stdout", () => {
  assert.equal(detectClaudeRateLimit("not json"), null);
});

// Regression for issue #100: acceptEdits blocks bash in --print mode, so
// code-mutating lanes must use bypassPermissions to actually commit.
test("mapPermission: git-write and read-write use bypassPermissions", () => {
  assert.equal(mapPermission("git-write"), "bypassPermissions");
  assert.equal(mapPermission("read-write"), "bypassPermissions");
  assert.equal(mapPermission("read-only"), "default");
});

test("extractDeniedBashCommands: pulls bash commands out of permission_denials", () => {
  const raw = {
    permission_denials: [
      { tool_name: "Bash", tool_input: { command: "git commit -am fix" } },
      { tool_name: "Read", tool_input: { file_path: "/etc/hostname" } },
      { tool_name: "Bash", tool_input: { command: "php -v" } },
      { tool_name: "Bash", tool_input: {} },
    ],
  };
  assert.deepEqual(extractDeniedBashCommands(raw), ["git commit -am fix", "php -v"]);
});

test("extractDeniedBashCommands: empty / missing / non-object raw", () => {
  assert.deepEqual(extractDeniedBashCommands(undefined), []);
  assert.deepEqual(extractDeniedBashCommands({}), []);
  assert.deepEqual(extractDeniedBashCommands({ permission_denials: [] }), []);
  assert.deepEqual(extractDeniedBashCommands("not-an-object"), []);
});
