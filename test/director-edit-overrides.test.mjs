// Edit-before-approve: payload override merge.
//
// Verifies the type-aware merge in the executor does the right thing:
//   • only fields recognised for the decision-type pass through
//   • original fields not touched by overrides are preserved
//   • unknown decision types (e.g. no_op) reject all edits

import { test } from "node:test";
import assert from "node:assert/strict";
import { editableFieldsFor, mergePayloadOverrides } from "../dist/director/executor.js";

test("editableFieldsFor: returns expected fields for create_issue", () => {
  const fields = editableFieldsFor("create_issue");
  assert.deepEqual([...fields].sort(), ["body", "labels", "priority", "title"]);
});

test("editableFieldsFor: empty list for unknown type", () => {
  assert.deepEqual([...editableFieldsFor("no_op")], []);
  assert.deepEqual([...editableFieldsFor("delete_repo")], []);
});

test("mergePayloadOverrides: applies title + labels override on create_issue", () => {
  const original = {
    title: "Old title",
    body: "Body markdown",
    labels: ["openronin:do-it"],
    priority: "low",
  };
  const merged = mergePayloadOverrides("create_issue", original, {
    title: "New title",
    labels: ["bug", "good first issue"],
  });
  assert.deepEqual(merged, {
    title: "New title",
    body: "Body markdown",
    labels: ["bug", "good first issue"],
    priority: "low",
  });
});

test("mergePayloadOverrides: drops unknown fields silently", () => {
  const original = { body: "hi" };
  const merged = mergePayloadOverrides("comment_on_issue", original, {
    body: "bye",
    issue_number: 999, // not editable
    secret: "leak",
  });
  assert.deepEqual(merged, { body: "bye" });
});

test("mergePayloadOverrides: refuses to mutate no_op payload", () => {
  const original = { foo: "bar" };
  const merged = mergePayloadOverrides("no_op", original, { foo: "baz" });
  assert.deepEqual(merged, original);
});

test("mergePayloadOverrides: handles missing original gracefully", () => {
  const merged = mergePayloadOverrides("close_issue", null, { reason: "stale" });
  assert.deepEqual(merged, { reason: "stale" });
});

test("mergePayloadOverrides: preserves issue_number across edit on label_issue", () => {
  // label_issue has issue_number (not editable) + add/remove (editable).
  // The non-editable identifying field MUST survive an edit so the
  // executed call still targets the right issue.
  const original = {
    issue_number: 42,
    add: ["bug"],
    remove: [],
  };
  const merged = mergePayloadOverrides("label_issue", original, {
    add: ["bug", "high-priority"],
  });
  assert.equal(merged.issue_number, 42);
  assert.deepEqual(merged.add, ["bug", "high-priority"]);
});
