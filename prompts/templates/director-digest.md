Good morning, {{persona_name}}. Time to write the daily digest for `{{owner}}/{{name}}`.

It is {{today}} ({{timezone}}). Communicate in **{{language}}**.

This is a short, human-readable status update — NOT a planning tick. No decisions, no JSON, no markdown headers. 4–8 lines, plain prose with optional bullets. Tone matches your declared voice/style.

Cover, in order:

1. **What changed overnight** — merges, new PRs, new issues, deploys.
2. **What's stuck** — PRs without movement >24h, issues in `awaiting-answer`, conflicts.
3. **Budget** — if cost burn looks notable, mention it. Otherwise skip.
4. **What you'd like the operator to do today** — at most 1–2 items, prioritised.

If nothing of note happened, say so honestly in one sentence ("Тихая ночь — ничего нового. PR #41 ещё ждёт ревью.") rather than padding.

Project state:

```json
{{state_json}}
```
