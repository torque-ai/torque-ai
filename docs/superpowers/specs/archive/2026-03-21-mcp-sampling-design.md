# MCP Sampling for Task Decomposition — Design Spec

**Date:** 2026-03-21
**Status:** Approved
**Motivation:** TORQUE's strategic brain (`strategic-brain.js`) calls cloud LLMs for task decomposition, diagnosis, and code review. This costs money and adds latency. MCP sampling lets the server request completions from the host LLM (Claude Code) for free, with zero latency. The bidirectional protocol layer already exists from the elicitation feature.

## Approach

1. Add `sampling` capability check in `mcp-protocol.js` initialize (alongside elicitation)
2. Create `server/mcp/sampling.js` helper — mirrors `elicit()` pattern
3. Integrate into `strategic-brain.js` `_strategicCall()` as first-choice path before cloud LLM

## Sampling Helper

**New file: `server/mcp/sampling.js`**

```js
const result = await sample(sessionOrId, {
  messages: [
    { role: 'user', content: { type: 'text', text: 'Decompose this feature...' } }
  ],
  maxTokens: 4096,
});
// result = { content: { type: 'text', text: '...' }, model: 'claude-...' }
// or { action: 'decline' } / { action: 'cancel' } on failure
```

Behavior (mirrors `elicit()`):
- Accepts session object or session_id string
- Checks `session.supportsSampling` — returns `{ action: 'decline' }` if false
- No session / disconnected → `{ action: 'decline' }`
- Timeout (2 min for sampling, shorter than elicitation's 5 min) → `{ action: 'cancel' }`
- Uses `sendClientRequest(sessionId, 'sampling/createMessage', params)`

## Strategic Brain Integration

In `strategic-brain.js` `_strategicCall()`, before the existing cloud LLM call:

1. Check if `this._sessionId` is set (stored at brain construction time from task metadata)
2. If yes, try `sample()` with the strategic prompt
3. Parse the response as JSON (decompose returns structured JSON)
4. If sampling succeeds and parse succeeds → return result
5. If sampling fails/declines/returns unparseable → fall through to existing cloud LLM path
6. Existing deterministic fallback remains as last resort

The session ID flows from task metadata (`mcp_session_id`, already stored by elicitation Task 3).

## Files

| File | Action | Purpose |
|------|--------|---------|
| `server/mcp-protocol.js` | **Modify** | Add `session.supportsSampling` in initialize |
| `server/mcp/sampling.js` | **New** | `sample(sessionOrId, params)` helper |
| `server/orchestrator/strategic-brain.js` | **Modify** | Try sampling before cloud LLM in `_strategicCall()` |
| `server/tests/sampling.test.js` | **New** | Unit tests |

## Testing

- `sample()` returns decline when no sampling capability
- `sample()` returns decline for null/undefined session
- `sample()` returns decline for nonexistent session_id
- `sample()` sends correct `sampling/createMessage` request structure
- Strategic brain falls through to cloud LLM when sampling unavailable
- Capability negotiation: `supportsSampling` set from initialize params

## Non-Goals

- No changing the strategic brain's prompt templates (they work as-is)
- No model preferences in sampling request (use whatever the client has)
- No streaming sampling responses (single completion is fine)
