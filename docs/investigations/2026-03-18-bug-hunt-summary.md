# TORQUE Bug Hunt — 2026-03-18

**Total issues found: 475**

## Breakdown by Area

| Area | Agent | Issues | Critical/High | Medium | Low |
|------|-------|--------|---------------|--------|-----|
| Server core (DB, execution, scheduler) | 1 | 85 | 29 | 45 | 11 |
| Providers + handlers | 2 | 80 | 24 | 34 | 14 |
| API + utils + config | 3 | 110 | 16 | 75 | 19 |
| Dashboard (views, components) | 4 | 120 | 7 | 68 | 45 |
| Tests (coverage gaps, quality) | 5 | 80 | 8 | 42 | 30 |

## Top 20 Most Critical Issues

1. **Race condition in updateTaskStatus** — manual BEGIN IMMEDIATE pattern can lose COMMIT (database.js:940)
2. **Non-transactional counters** — handlePlanProjectTaskCompletion read-modify-write not atomic (workflow-runtime.js:138)
3. **FK constraint violation** — deleteWorkflow doesn't delete child tasks (workflow-engine.js:318)
4. **No body size limit** in v2-dispatch readJsonBody — OOM DoS vector (v2-dispatch.js:31)
5. **Google AI API key in URL query string** — logged by proxies (google-ai.js:54)
6. **Agentic tasks bypass host slot reservation** — can exceed VRAM capacity (execution.js:391)
7. **Agentic task cancellation silently ignored** — abort controllers not registered (execution.js:449)
8. **Context stuffing reads files outside working directory** — sends to cloud (context-stuffing.js:126)
9. **safeExecChain doesn't handle quoted arguments** — breaks verify_command (safe-exec.js:38)
10. **Predictable temp file path** in plan import — symlink attack (v2-governance-handlers.js:483)
11. **search_files has no symlink cycle detection** — infinite recursion (ollama-tools.js:187)
12. **run_command uses execSync** — blocks entire event loop (ollama-tools.js:408)
13. **Git safety captureSnapshot swallows errors** — safety net silently disabled (agentic-git-safety.js:142)
14. **Wildcard * in command allowlist** — permits arbitrary code execution (ollama-tools.js:241)
15. **WebSocket double-connection** — CONNECTING state not checked (websocket.js:57)
16. **executeHashlineOllamaTask has no cancel/timeout** — runs indefinitely (execute-hashline.js:739)
17. **Shutdown logic cancels orphan tasks** — opposite of intended behavior (index.js:374)
18. **getNextQueuedTask excludes NULL-provider tasks** — deferred tasks stranded (database.js:1371)
19. **Child logger causes double rotation** — log corruption (logger.js:200)
20. **CORS hardcoded to port 3456** — breaks non-default configs (middleware.js:227)

## Breakdown by Category

| Category | Count |
|----------|-------|
| Bug (logic/runtime) | 142 |
| Security | 48 |
| Logic error | 67 |
| Performance | 31 |
| Memory leak | 22 |
| Error handling | 29 |
| Race condition | 18 |
| Inconsistency | 34 |
| Dead code | 16 |
| Data integrity | 12 |
| Accessibility | 15 |
| UX issue | 18 |
| Test coverage gap | 43 |

## Full Reports

Individual agent reports with line-level detail are available as conversation artifacts. Each report contains:
- Exact file:line references
- Severity rating (critical/high/medium/low)
- Category classification
- Description of the issue and why it matters
- Suggested fix approach

## Priority Remediation Order

### Phase 1: Security (Critical)
- Fix body size limit in v2-dispatch readJsonBody
- Move Google AI API key from URL to header
- Add symlink cycle detection to search_files
- Fix context-stuffing path validation
- Fix safeExecChain quoted argument handling
- Fix predictable temp file in plan import
- Fix git safety snapshot error swallowing

### Phase 2: Data Integrity (Critical)
- Fix updateTaskStatus transaction pattern
- Fix non-transactional workflow counters
- Fix deleteWorkflow FK violations
- Fix getNextQueuedTask NULL-provider exclusion
- Fix agentic host slot reservation bypass

### Phase 3: Reliability (High)
- Fix WebSocket double-connection
- Fix hashline cancel/timeout
- Fix shutdown orphan task logic
- Fix agentic abort controller registration
- Fix child logger rotation
- Add processQueue calls after requeue paths

### Phase 4: Quality (Medium)
- Dashboard performance (History 5s polling, OutputTab memoization)
- Dashboard memory leaks (orphaned timeouts, unbounded streaming)
- API consistency (v1/v2 mixing, error format standardization)
- Accessibility improvements (charts, toggles, modals)
- Test coverage for agentic pipeline
