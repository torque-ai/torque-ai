# MCP Tool Annotations — Design Spec

**Date:** 2026-03-21
**Status:** Approved
**Tool count:** 553 (as of 2026-03-21)
**Motivation:** MCP spec 2025-06-18 defines tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) that clients use to decide auto-approve vs. prompt-user behavior. TORQUE's 553 tools currently lack these annotations, meaning clients treat every tool call as potentially dangerous.

## Approach

**Hybrid: Convention-Based Defaults + Explicit Overrides**

Convention rules auto-derive annotations from tool name patterns. Explicit overrides (full 4-field objects) handle edge cases where names mislead the convention. A startup validator catches tools with no coverage.

Chosen over inline-per-file (too scattered for auditing) and pure static map (too much manual maintenance as tools grow). The user expects frequent tool additions — conventions reduce ongoing burden.

## Convention Rules

**Matching order:** Explicit overrides → exact matches → prefix patterns → suffix patterns → fallback. Within prefix and suffix groups, first match wins. Prefix-before-suffix prevents `set_task_review_status` from matching `*_status` (suffix, readOnly) when it should match `set_*` (prefix, idempotent).

### Prefix Rules (checked first)

| Pattern | readOnlyHint | destructiveHint | idempotentHint | openWorldHint |
|---------|:---:|:---:|:---:|:---:|
| **Read-only prefixes:** `list_*`, `get_*`, `check_*`, `find_*`, `search_*`, `scan_*`, `diff_*`, `export_*`, `analyze_*`, `validate_*`, `detect_*`, `compare_*`, `predict_*`, `estimate_*`, `forecast_*`, `verify_*`, `view_*`, `explain_*`, `inspect_*`, `preview_*`, `diagnose_*`, `capture_*`, `lookup_*`, `query_*`, `suggest_*`, `compute_*`, `calculate_*`, `calibrate_*`, `tsserver_*`, `peek_*` (except overridden peek tools) | true | false | true | false |
| **Destructive prefixes:** `delete_*`, `rollback_*`, `archive_*`, `remove_*`, `clear_*`, `revoke_*`, `cleanup_*` | false | true | false | false |
| **Cancel prefixes:** `cancel_*`, `batch_cancel` | false | true | false | false |
| **Create/dispatch prefixes:** `submit_*`, `queue_*`, `create_*`, `run_*`, `schedule_*`, `fork_*`, `clone_*`, `import_*`, `bulk_import_*`, `notify_*`, `send_*`, `test_*`, `trigger_*`, `generate_*`, `backup_*`, `sync_*` | false | false | false | true |
| **Idempotent mutation prefixes:** `set_*`, `configure_*`, `tag_*`, `untag_*`, `manage_*`, `add_*`, `inject_*`, `wire_*`, `normalize_*`, `update_*`, `replace_*`, `register_*`, `unregister_*`, `enable_*`, `disable_*`, `activate_*`, `toggle_*`, `approve_*`, `reject_*`, `deny_*`, `apply_*`, `learn_*`, `save_*`, `setup_*`, `record_*`, `resolve_*` | false | false | true | false |
| **Lifecycle prefixes:** `retry_*`, `resume_*`, `restore_*`, `start_*`, `pause_*`, `skip_*`, `stop_*`, `release_*`, `claim_*`, `steal_*`, `recover_*`, `refresh_*` | false | false | false | false |
| **Blocking/async prefixes:** `await_*`, `wait_*`, `poll_*`, `stream_*` | true | false | false | false |

### Suffix Rules (checked second, only if no prefix matched)

| Pattern | readOnlyHint | destructiveHint | idempotentHint | openWorldHint |
|---------|:---:|:---:|:---:|:---:|
| **Read-only suffixes:** `*_status`, `*_info`, `*_summary`, `*_history`, `*_timeline`, `*_graph`, `*_path`, `*_stats`, `*_report`, `*_dashboard`, `*_health`, `*_insights`, `*_changes`, `*_quotas` | true | false | true | false |

### Exact Matches

| Tool | readOnlyHint | destructiveHint | idempotentHint | openWorldHint |
|------|:---:|:---:|:---:|:---:|
| `ping` | true | false | true | false |
| `blocked_tasks` | true | false | true | false |
| `critical_path` | true | false | true | false |
| `what_if` | true | false | true | false |
| `dependency_graph` | true | false | true | false |

### Fallback (no match)

| | readOnlyHint | destructiveHint | idempotentHint | openWorldHint |
|--|:---:|:---:|:---:|:---:|
| **default** | false | false | false | false |

`openWorldHint: true` on submit/create/dispatch reflects that these send work to external providers (Ollama, Codex, cloud APIs).

## Explicit Overrides

Overrides provide **full 4-field annotation objects** (not partial merges). When a tool has an explicit override, convention rules are not consulted at all.

| Tool | readOnlyHint | destructiveHint | idempotentHint | openWorldHint | Reason |
|------|:---:|:---:|:---:|:---:|--------|
| `peek_interact` | false | false | false | false | Clicks/types in UI despite `peek_*` readOnly convention |
| `peek_launch` | false | false | false | true | Launches application process |
| `peek_build_and_open` | false | false | false | true | Builds and launches |
| `restart_server` | false | true | false | false | Kills and restarts TORQUE |
| `unlock_all_tools` | false | false | true | false | Mutates session state, safe to repeat |
| `unlock_tier` | false | false | true | false | Mutates session state, safe to repeat |
| `commit_task` | false | false | false | true | Commits to git — external side effect |
| `auto_commit_batch` | false | false | false | true | Git commit + optional push |
| `smart_submit_task` | false | false | false | true | Starts with `smart_*`, not `submit_*` — convention misses it |
| `configure` | false | false | true | false | Bare name (no underscore) — `configure_*` pattern misses it |
| `stash_changes` | false | true | false | false | Runs `git stash` — destructive despite `*_changes` suffix |
| `hashline_read` | true | false | true | false | `hashline_*` has mixed behavior — this one is read-only |
| `hashline_edit` | false | false | false | false | File editing — not read-only, not destructive, not idempotent |
| `auto_verify_and_fix` | false | false | false | true | Runs verify command + may submit fix tasks to providers |
| `optimize_database` | false | false | true | false | DB optimization — idempotent mutation |
| `strategic_config_get` | true | false | true | false | Read-only config retrieval |
| `strategic_config_set` | false | false | true | false | Idempotent config mutation |
| `strategic_config_apply_template` | false | false | true | false | Idempotent config mutation |
| `strategic_config_templates` | true | false | true | false | Read-only template listing |
| `strategic_usage` | true | false | true | false | Read-only usage stats |
| `strategic_decompose` | false | false | false | true | Calls external LLM for task decomposition |
| `strategic_diagnose` | false | false | false | true | Calls external LLM for diagnosis |
| `strategic_review` | false | false | false | true | Calls external LLM for code review |
| `strategic_benchmark` | false | false | false | true | Runs benchmark tests externally |
| `audit_codebase` | false | false | false | true | Dispatches to external LLM for analysis |
| `batch_retry` | false | false | false | false | Lifecycle — retries failed tasks |
| `batch_tag` | false | false | true | false | Idempotent bulk tagging |

Override map covers edge cases where tool names mislead conventions or span multiple annotation categories (e.g., `strategic_*`). Conventions handle 90%+ of the remaining tools.

## Architecture

### Files

| File | Action | Purpose |
|------|--------|---------|
| `server/tool-annotations.js` | **New** | Convention rules, explicit overrides, `getAnnotations(name)`, `validateCoverage(names)` |
| `server/tools.js` | **Modify** | Merge annotations into TOOLS array at startup, call validator |
| `server/mcp-protocol.js` | **No change** | Already returns tool objects verbatim — annotations flow through |

### Data Flow

```
tool-defs/*.js (name, description, inputSchema)
        ↓
    tools.js loads TOOLS array
        ↓
    tool-annotations.js: getAnnotations(name)
      → check explicit overrides first (full 4-field object returned directly)
      → check exact matches
      → check prefix rules (first match wins)
      → check suffix rules (first match wins)
      → fallback: all-false
      → return { readOnlyHint, destructiveHint, idempotentHint, openWorldHint }
        ↓
    tools.js merges: tool.annotations = getAnnotations(tool.name)
        ↓
    tools.js calls validateCoverage(allToolNames)
      → warns on uncovered tools (no convention match, no override — hit fallback)
      → warns on stale overrides (override references nonexistent tool)
        ↓
    mcp-protocol.js serves tools/list with annotations included
```

Annotations resolved once at startup. No per-request cost.

### Protocol Compatibility

`mcp-protocol.js` reports `protocolVersion: '2024-11-05'`. Annotations are backward-compatible hints — clients that don't understand them ignore them. No version bump needed.

## Testing

### Unit Tests

1. **Convention correctness** — Representative tools from each prefix pattern return expected annotations:
   - `list_tasks` → `{ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }`
   - `delete_task` → `{ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }`
   - `submit_task` → `{ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }`
   - `set_project_defaults` → `{ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }`
   - `await_workflow` → `{ readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false }`
   - `remove_host` → `{ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }`
   - `analyze_task` → `{ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }`
   - `register_agent` → `{ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }`
   - `ping` → `{ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }`

2. **Override precedence** — Explicit overrides beat convention rules:
   - `peek_interact` returns `{ readOnlyHint: false, ... }` (overrides `peek_*` → readOnly convention)
   - `restart_server` returns `{ destructiveHint: true, ... }`
   - `smart_submit_task` returns `{ openWorldHint: true, ... }` (no `submit_*` convention match)

3. **Prefix-before-suffix ordering** — Prefix rules take priority over suffix matches:
   - `set_task_review_status` matches `set_*` prefix → idempotent (NOT `*_status` suffix → readOnly)
   - `cancel_workflow` matches `cancel_*` prefix → destructive (not a workflow pattern)
   - `list_paused_tasks` matches `list_*` prefix → readOnly

4. **Suffix rules** — Tools with no prefix match use suffix rules:
   - A hypothetical `coordination_dashboard` → matches `*_dashboard` suffix → readOnly

5. **Fallback** — Unknown tool `some_unknown_tool` returns all-false annotations

6. **Shape validation** — Every annotation object has exactly four boolean fields: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`. No extras, no missing keys, no non-boolean values.

7. **Semantic validity** — No tool has both `readOnlyHint: true` AND `destructiveHint: true` (logically contradictory).

### Validator Tests

8. **Full coverage** — `validateCoverage(allRealToolNames)` returns empty uncovered list (all tools covered by convention or override). If any tools remain uncovered after expanding conventions, they must be added as explicit overrides or new convention patterns before this test passes.

9. **Uncovered detection** — Tool name matching no convention and no override appears in uncovered list.

10. **Stale override detection** — Override referencing nonexistent tool name appears in stale list.

### Integration Test

11. **Full merge** — Load real TOOLS array, run merge, assert every tool object has `annotations` field with correct shape. This is the end-to-end sanity check.

## Non-Goals

- No `outputSchema` (Priority 2 — separate spec)
- No changes to `catalog-v1.js` (future namespacing migration will consume annotations from this system)
- No protocol version bump
- No changes to dashboard or REST API (annotations are MCP-only)
