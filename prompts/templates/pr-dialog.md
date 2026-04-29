# openronin PR-dialog iteration — `{{repo_full_name}}` PR #{{pr_number}}

## ⚠️ Language rules — read first, follow strictly

| What you produce | Required language |
| --- | --- |
| **Final response (iteration summary)** | **{{language_for_communication}}** |
| **Comments / replies posted on the PR** | **{{language_for_communication}}** |
| **Git commit messages** | **{{language_for_commits}}** |
| **Code identifiers / file names / inline strings** | **{{language_for_code_identifiers}}** |

Write your iteration summary and per-comment replies in **{{language_for_communication}}**, regardless of what language the reviewer wrote in or what language this prompt is framed in. Do not default to English.

---

You opened PR #{{pr_number}} earlier (branch `{{branch}}`). A reviewer has now left feedback. Your job is to **address it and update the branch** — and to **reply to each comment**.

You are running inside a fresh checkout of branch `{{branch}}`. You are **not** on `main`.

## Original task ({{kind}} #{{number}})

**{{title}}**

{{body}}

## What you have already done

Iteration {{iteration}} of max {{max_iterations}}. Previous summary:

> {{previous_summary}}

## New reviewer feedback to address

The following comments and reviews are new since your last iteration. **Each entry has a stable `comment_id` you must reuse when you reply.**

{{review_feedback}}

## Working agreement

- Stay on this branch — do not start a new one, do not switch to `main`, do not push.
- Address the reviewer's feedback as the priority. Make the smallest correct change.
- Do **not** modify these protected paths: {{protected_paths}}
- Keep the *new* diff (this iteration's commits, not cumulative) under {{max_diff_lines}} lines.
- If the project has tests, run them and ensure they still pass.
- Commit each logical change separately if it helps clarity. Multiple new commits are fine.
- Commit messages must be in **{{language_for_commits}}**.

## Required output

Your final response **must end with** a JSON block exactly in this shape, fenced by ` ```openronin-replies ` and ` ``` `:

````
```openronin-replies
{
  "replies": [
    {"comment_id": "<id from the feedback list>", "kind": "addressed", "body": "..."},
    {"comment_id": "<id>", "kind": "question", "body": "..."},
    {"comment_id": "<id>", "kind": "pushback", "body": "..."}
  ],
  "summary": "<overall summary in {{language_for_communication}}>"
}
```
````

`kind` semantics:

- `addressed` — you made the change the reviewer asked for. The system will resolve the conversation thread for this comment after pushing.
- `question` — the comment is unclear or you need clarification before changing anything. The body is your question to the reviewer; it will be posted as a reply on their comment. The thread stays open.
- `pushback` — you understand but disagree (out of scope, breaks something, contradicts another comment). Body explains why. Thread stays open.

`body` of each reply is in **{{language_for_communication}}** and is what we post as the threaded reply to the original comment. Do not include the `🤖 openronin:` prefix — the system adds it.

`summary` is a short overview of this iteration, in **{{language_for_communication}}**.

If you decide to commit nothing this iteration (only questions / pushback), still produce the JSON block — just leave commits empty, and put your reasoning in the per-comment replies and summary. The system will mark the PR as needing human attention.
