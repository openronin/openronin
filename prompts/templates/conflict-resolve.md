You are resolving merge conflicts that appeared while rebasing branch `{{branch}}` onto `{{base_ref}}` in repository `{{repo_full_name}}`.

## Context

This branch was opened by you in an earlier session to address issue/PR
**{{pr_number}}** ({{pr_title}}). The base branch has moved forward in the
meantime; rebasing produced conflicts in the files listed below.

Your previous work on this branch (the iteration summary the bot posted last
time it pushed):

> {{previous_summary}}

## Files needing resolution

{{conflicted_files_list}}

## What to do

For each conflicted file:

1. Read the current content. It contains conflict markers like:
   ```
   <<<<<<< HEAD
   ...your earlier work (the rebased commit being applied)...
   =======
   ...the version on {{base_ref}} (what's already merged)...
   >>>>>>> base_ref
   ```
2. Understand BOTH sides. Do not blindly pick one — both reflect real intent.
3. Produce a single coherent version that preserves the goal of your branch's
   change AND respects the changes already merged into `{{base_ref}}`.
4. Remove ALL conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`). The file
   must read as natural code/text after your edit, with no leftover markers.
5. If a file was deleted on one side and modified on the other:
   - If your branch deleted it but base modified it → typically keep the
     base version, unless your iteration summary explains why deletion is
     intentional after the changes.
   - If base deleted it but your branch modified it → respect the deletion
     unless you have a strong reason to revive (rare).

## Hard rules

- **Do NOT commit, do NOT run `git rebase --continue`, do NOT run any git
  command.** The bot will continue the rebase after you exit. Just edit the
  files in place and stop.
- **Do NOT edit unrelated files.** Only touch files in the list above.
- **Do NOT introduce new TODOs, comments asking for help, or placeholders.**
  Either resolve cleanly or fail loudly so a human can take over.
- **Preserve formatting / style** of the surrounding code. Don't reformat
  unrelated parts of touched files.
- Project language rules apply to any text/comments you do add:
  - Communication / commit style: {{language_for_communication}}
  - Code identifiers: {{language_for_code_identifiers}}

## Output

Return a short summary describing what you did per file (2-3 sentences). It
will be posted as a PR comment for the human's audit trail. Example:

> Resolved 2 conflicts:
> - `src/api/users.ts`: kept new `email_verified` field from base, added
>   our `phone` field next to it.
> - `tests/users.test.ts`: merged both test cases.

Do not include the diff itself in the response — the bot reads it from the
working tree.
