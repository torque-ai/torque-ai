---
description: Triage rejected work items that exhausted auto-recovery
---

# /torque-recovery-inbox [project]

Surface and triage factory work items that were auto-rejected, attempted by replan-recovery up to the hard cap, and routed to the `needs_review` inbox.

## Workflow

1. Call `list_recovery_inbox` (optionally with `project_id` if the user gave one). Format the result as a table sorted by `recovery_attempts` descending — most-stuck first.

2. For each item the user wants to act on, call `inspect_recovery_item` to load full history (work item + recovery_history_json + factory_decisions entries).

3. Propose ONE of:
   - **retry as-is** — reset attempts, status -> pending. Use when codebase has clearly evolved since the original failure.
   - **edit and retry** — suggest a rewritten title/description based on the prior failure history; user confirms; call `revive_recovery_item` with `mode: 'edit'`.
   - **decompose** — suggest 2-3 child specs; user confirms; call `revive_recovery_item` with `mode: 'split'` and `children`.
   - **dismiss** — call `dismiss_recovery_item` with `reason`. The item flips to `unactionable` permanently and is excluded from future recovery sweeps.

4. After each action, summarize what changed and offer the next item.

## Notes

- The four MCP tools (`list_recovery_inbox`, `inspect_recovery_item`, `revive_recovery_item`, `dismiss_recovery_item`) are the only authoritative path. Do not modify items via raw SQL or `update_work_item`.
- Dismissals are logged to `factory_decisions` as `recovery_inbox_dismissed`. Revivals as `recovery_inbox_revived`. Both are auditable alongside auto-recovery decisions.
- The inbox is a human-in-the-loop surface — never claim items "automatically" without explicit user choice.
