# Documentation Scan Findings

**Date:** 2026-04-04
**Scope:** CLAUDE.md, docs/*.md, server/docs/README.md vs actual code
**Scanner:** documentation variant

## Summary

CLAUDE.md was recently condensed from 708 to 460 lines. The condensed version is
mostly accurate, with a few stale counts and incomplete tables. The secondary
docs (server/docs/README.md, server/docs/api/tool-reference.md) have staler numbers.
JSDoc coverage is uneven -- well-documented in transport/registry modules, absent
in policy-engine and governance handlers.

---

## Findings

### F-DOC-01: MCP tool count wrong in CLAUDE.md (HIGH)

**Location:** CLAUDE.md line 344
**Claim:** "TORQUE exposes ~200 MCP tools organized into categories."
**Actual:** 537 built-in tools + 53 plugin tools = 590 total.
**Note:** The Setup section (line 7) correctly says "~600 tools" and the
`server/docs/api/tool-reference.md` also says "~600 tools total". Only the
MCP Tool Reference section header is wrong.
**Status:** ACTIONABLE

### F-DOC-02: Commands table missing 7 slash commands (MEDIUM)

**Location:** CLAUDE.md lines 73-81
**Claim:** 7 commands listed: submit, status, review, workflow, budget, config, cancel.
**Actual:** 14 slash commands exist in `.claude/commands/`:
- Listed: torque-submit, torque-status, torque-review, torque-workflow, torque-budget, torque-config, torque-cancel
- Missing from table: **torque-ci**, **torque-hosts**, **torque-restart**, **torque-scout**, **torque-team**, **torque-templates**, **torque-validate**
**Impact:** Users won't discover these commands from reading CLAUDE.md.
**Status:** ACTIONABLE

### F-DOC-03: Snapscope plugin tool list incomplete (MEDIUM)

**Location:** CLAUDE.md line 229
**Claim:** 6 tools: `capture_screenshots`, `capture_view`, `capture_views`, `validate_manifest`, `peek_ui`, `peek_diagnose`
**Actual:** 33 tools in `server/plugins/snapscope/tool-defs.js`. Missing from list: `peek_interact`, `peek_elements`, `peek_hit_test`, `peek_regression`, `peek_launch`, `peek_discover`, `peek_open_url`, `peek_cdp`, `peek_refresh`, `peek_health_all`, `peek_build_and_open`, `register_peek_host`, `unregister_peek_host`, `list_peek_hosts`, `peek_semantic_diff`, `peek_wait`, `peek_action_sequence`, `peek_ocr`, `peek_color`, `peek_snapshot`, `peek_table`, `peek_summary`, `peek_assert`, and more.
**Suggestion:** Either list key tools + "... and N more" or just state the count.
**Status:** ACTIONABLE

### F-DOC-04: server/docs/README.md tool count stale (MEDIUM)

**Location:** `server/docs/README.md` lines 18, 54
**Claim:** "462 MCP Tools" (appears twice)
**Actual:** 590 total tools (537 built-in + 53 plugin)
**Status:** ACTIONABLE

### F-DOC-05: server/docs/README.md commands table only has 8 entries (LOW)

**Location:** `server/docs/README.md` lines 34-43
**Lists:** 8 commands (the 7 from CLAUDE.md + torque-restart)
**Actual:** 14 commands exist. Missing 6 compared to filesystem.
**Status:** ACTIONABLE (update when fixing F-DOC-02)

### F-DOC-06: Core tool tier count slightly off (LOW)

**Location:** CLAUDE.md line 7 ("~30 core + progressive unlock"), server/docs/api/tool-reference.md ("~30 core tools")
**Actual:** Tier 1 has exactly 35 tools (counted from `server/core-tools.js` TIER_1 array).
**Impact:** Minor -- "~30" vs 35 is reasonable for an approximation but could be "~35".
**Status:** DEFERRED

### F-DOC-07: JSDoc absent on policy-engine and governance modules (MEDIUM)

**Coverage survey of key modules:**

| Module | JSDoc Blocks | Lines | Density |
|--------|-------------|-------|---------|
| `server/container.js` | 3 | 569 | Low |
| `server/event-bus.js` | 1 | 55 | Low |
| `server/database.js` | 8 | 785 | Low |
| `server/mcp-protocol.js` | 3 | 149 | Moderate |
| `server/mcp-sse.js` | 10 | 794 | Moderate |
| `server/tools.js` | 2 | 667 | Very low |
| `server/providers/registry.js` | 7 | 139 | Good |
| `server/providers/execution.js` | 13 | 1263 | Low |
| `server/execution/slot-pull-scheduler.js` | 3 | 263 | Low |
| `server/policy-engine/engine.js` | **0** | **1095** | **None** |
| `server/policy-engine/matchers.js` | **0** | **483** | **None** |
| `server/policy-engine/task-hooks.js` | **0** | **133** | **None** |
| `server/handlers/automation-handlers.js` | 2 | 1110 | Very low |
| `server/handlers/governance-handlers.js` | **0** | **323** | **None** |

**Worst offenders:** `policy-engine/engine.js` (1095 lines, 0 JSDoc), `policy-engine/matchers.js` (483 lines, 0 JSDoc), `governance-handlers.js` (323 lines, 0 JSDoc).
**Status:** DEFERRED (code works but is harder to onboard into)

### F-DOC-08: Duplicate safeguards documentation (LOW)

**Two files:**
- `docs/safeguards.md` -- 48-line condensed version (referenced from CLAUDE.md)
- `server/docs/safeguards.md` -- 432-line comprehensive version (referenced from server/docs/README.md)

These are intentionally different scopes (project-root summary vs server-internal reference) but could confuse contributors who find one and not the other. No action needed unless they drift further apart.
**Status:** DEFERRED

---

## Verified Accurate Claims

The following documented claims were verified against code:

| Claim | Location | Status |
|-------|----------|--------|
| 12 execution providers | CLAUDE.md line 87 | Correct (registry.js ALL_PROVIDERS = 12) |
| Port numbers 3456/3457/3458/9394 | CLAUDE.md (global) | Correct (index.js defaults) |
| DEFAULT_PLUGIN_NAMES = 3 plugins | CLAUDE.md line 225 | Correct (index.js:56) |
| Plugin contract fields | CLAUDE.md line 30 | Correct (plugin-contract.js) |
| Version-control plugin: 13 tools | CLAUDE.md line 230 | Correct |
| Remote-agents plugin: 7 tools | CLAUDE.md line 231 | Correct |
| 5 governance rules | CLAUDE.md line 299 | Correct (governance-rules.js) |
| Slot-pull scheduler exists | CLAUDE.md (condensed out, global mentions) | Correct |
| `configure_fallback_chain` tool exists | CLAUDE.md line 202 | Correct |
| `configure_stall_detection` tool exists | CLAUDE.md line 206 | Correct |
| `configure_quota_auto_scale` tool exists | CLAUDE.md line 353 | Correct |
| All policy-engine files listed exist | CLAUDE.md (condensed out, global has list) | Correct |
| All remote-agents plugin files exist | CLAUDE.md lines 236-247 | Correct |
| `lint:di` npm script exists | CLAUDE.md line 453 | Correct |
| All server/docs/README.md linked docs exist | server/docs/README.md | Correct (7/7) |
| Provider seeds match doc categories | CLAUDE.md lines 109-118 | Correct |
| codex-spark exists as provider | CLAUDE.md line 102 | Correct (registry.js, v2-cli-providers.js) |
| `createEventBus` factory exists | CLAUDE.md (condensed out) | Correct (event-bus.js:8) |
| scripts/worktree-create.sh exists | CLAUDE.md line 39 | Correct |
| scripts/worktree-cutover.sh exists | CLAUDE.md line 53 | Correct |
| .mcp.json.example exists | CLAUDE.md line 11 | Correct |
| stop-torque.sh exists | CLAUDE.md (global) | Correct |
| data-dir.js exists | CLAUDE.md (global) | Correct |

---

## Recommendations

1. **Fix F-DOC-01 immediately** -- change "~200" to "~590" or "~600" in CLAUDE.md line 344.
2. **Expand the Commands table (F-DOC-02)** -- add the 7 missing commands to CLAUDE.md.
3. **Fix snapscope tool list (F-DOC-03)** -- either enumerate key tools + count, or just state "33 tools including peek_ui, peek_interact, peek_elements, ..."
4. **Update server/docs/README.md (F-DOC-04, F-DOC-05)** -- change "462" to "~590" and add missing commands.
5. **JSDoc pass on policy-engine (F-DOC-07)** -- a TORQUE batch of 3-4 tasks could add JSDoc to the zero-coverage modules.
