# Test Fix Guide — Architecture Changes Reference

This session made several architectural changes that broke test compatibility. Here are the changes and how tests need to adapt:

## 1. Event Bus Migration
`process.emit('torque:queue-changed')` → `eventBus.emitQueueChanged()`
`process.emit('torque:shutdown')` → `eventBus.emitShutdown()`
`process.emit('torque:task-updated')` → `eventBus.emitTaskUpdated()`
`process.on('torque:...')` → `eventBus.on...()`

**Test fix:** Import event-bus and use its methods instead of process.emit/on:
```js
const eventBus = require('../event-bus');
eventBus.emitQueueChanged(); // instead of process.emit('torque:queue-changed')
```

## 2. Shell Metacharacter Regex Narrowed
`SHELL_METACHAR_RE` changed from `/[;|&`$(){}!<>]/` to `/[;|&`$]/`
Parentheses, braces, angle brackets, exclamation marks are now ALLOWED (safe with shell:false).

**Test fix:** Tests asserting that `()` `{}` `<>` `!` are rejected should now assert they're ALLOWED.

## 3. Cerebras Default Model Changed
`llama3.1-8b` → `qwen-3-235b-a22b-instruct-2507`

**Test fix:** Update assertions that check the default model name.

## 4. Groq Cost Pricing Changed
Flat `$0.27/1M` → model-specific rates (e.g., llama-3.3-70b = $0.59/1M)

**Test fix:** Update cost assertions to match new model-specific rates.

## 5. Timeout Defaults Changed
hashline-ollama: 10min → 30min
Various providers: normalized to 30min

**Test fix:** Update timeout assertions from 10*60*1000 to 30*60*1000.

## 6. countTasksByStatus Replaces Multiple countTasks Calls
`db.countTasks({status:'running'})` + `db.countTasks({status:'queued'})` → `db.countTasksByStatus()`

**Test fix:** Add `countTasksByStatus` to db mocks.

## 7. Codex supportsAsync Changed to true
adapter-registry: codex `supportsAsync: false` → `supportsAsync: true`

## 8. codex-spark Added to Provider Registry
`PROVIDER_CATEGORIES.codex` now includes `codex-spark`.

## 9. Provider Router Extracted
`resolveProviderRouting` moved from task-manager.js to execution/provider-router.js.
Functions still accessible via task-manager re-exports.

## 10. Shutdown Endpoint Requires X-Requested-With Header
`POST /api/shutdown` now requires `X-Requested-With: XMLHttpRequest` header.

**Test fix:** Add header to shutdown test requests.

## 11. MCP Protocol Auth
`mcp-protocol.js` now rejects unauthenticated sessions. Test sessions need `authenticated: true`.

## 12. Backup Restore Requires force:true to Skip Integrity Check
`restoreDatabase(path, confirm)` → `restoreDatabase(path, confirm, { force: true })` to skip SHA-256 verification.
