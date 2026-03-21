# MCP Sampling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add MCP sampling support so TORQUE's strategic brain can use the host LLM (Claude Code) for free task decomposition instead of paid cloud LLMs.

**Architecture:** New `server/mcp/sampling.js` helper (mirrors `elicit()`), capability check in initialize, integration into `strategic-brain.js` `_strategicCall()` as first-choice path.

**Tech Stack:** Node.js, Vitest, MCP protocol

**Spec:** `docs/superpowers/specs/2026-03-21-mcp-sampling-design.md`

**IMPORTANT:** Push to origin/main before running tests. Use `torque-remote` for test execution.

---

### Task 1: Sampling Helper + Capability Check

**Files:**
- Modify: `server/mcp-protocol.js` — add `supportsSampling` to initialize
- Create: `server/mcp/sampling.js`
- Create: `server/tests/sampling.test.js`

- [ ] **Step 1: Write tests**

Create `server/tests/sampling.test.js`:

```js
'use strict';

describe('mcp sampling', () => {
  describe('capability negotiation', () => {
    it('session with sampling capability is marked', () => {
      const session = {};
      const params = { capabilities: { sampling: {} } };
      session.supportsSampling = Boolean(params.capabilities?.sampling);
      expect(session.supportsSampling).toBe(true);
    });

    it('session without sampling capability is not marked', () => {
      const session = {};
      const params = { capabilities: { tools: {} } };
      session.supportsSampling = Boolean(params.capabilities?.sampling);
      expect(session.supportsSampling).toBe(false);
    });
  });

  describe('sample() helper', () => {
    it('returns decline when session has no sampling capability', async () => {
      const { sample } = require('../mcp/sampling');
      const session = { supportsSampling: false, __sessionId: 'test' };
      const result = await sample(session, { messages: [{ role: 'user', content: { type: 'text', text: 'test' } }] });
      expect(result).toEqual({ action: 'decline' });
    });

    it('returns decline when session is null', async () => {
      const { sample } = require('../mcp/sampling');
      const result = await sample(null, { messages: [] });
      expect(result).toEqual({ action: 'decline' });
    });

    it('returns decline when session is undefined', async () => {
      const { sample } = require('../mcp/sampling');
      const result = await sample(undefined, { messages: [] });
      expect(result).toEqual({ action: 'decline' });
    });

    it('returns decline when session_id resolves to no live session', async () => {
      const { sample } = require('../mcp/sampling');
      const result = await sample('nonexistent-session', { messages: [] });
      expect(result).toEqual({ action: 'decline' });
    });
  });
});
```

- [ ] **Step 2: Add `supportsSampling` to mcp-protocol.js initialize**

In `server/mcp-protocol.js`, in the `initialize` case, alongside the existing `supportsElicitation` line, add:

```js
session.supportsSampling = Boolean(params?.capabilities?.sampling);
```

- [ ] **Step 3: Create `server/mcp/sampling.js`**

```js
'use strict';

const logger = require('../logger').child({ component: 'sampling' });

const SAMPLING_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes (shorter than elicitation)

/**
 * Request an LLM completion from the host client via MCP sampling.
 * Gracefully degrades: returns { action: 'decline' } when sampling is unavailable.
 *
 * @param {object|string} sessionOrId - MCP session object or session_id string
 * @param {object} params - { messages: Array, maxTokens?: number, temperature?: number, modelPreferences?: object }
 * @returns {Promise<{ content?: object, model?: string, action?: string }>}
 */
async function sample(sessionOrId, params) {
  let session = null;
  if (sessionOrId && typeof sessionOrId === 'object' && sessionOrId.supportsSampling !== undefined) {
    session = sessionOrId;
  } else if (typeof sessionOrId === 'string') {
    try {
      const { getSession } = require('../mcp-sse');
      session = getSession(sessionOrId);
    } catch {
      // mcp-sse not available
    }
  }

  if (!session) {
    logger.debug('[sample] No session available — declining');
    return { action: 'decline' };
  }

  if (!session.supportsSampling) {
    logger.debug('[sample] Client does not support sampling — declining');
    return { action: 'decline' };
  }

  try {
    const { sendClientRequest } = require('../mcp-sse');
    const result = await sendClientRequest(
      session.__sessionId || session.sessionId,
      'sampling/createMessage',
      {
        messages: params.messages || [],
        maxTokens: params.maxTokens || 4096,
        ...(params.temperature != null ? { temperature: params.temperature } : {}),
        ...(params.modelPreferences ? { modelPreferences: params.modelPreferences } : {}),
      },
      SAMPLING_TIMEOUT_MS
    );
    logger.info(`[sample] Sampling resolved: model=${result?.model || 'unknown'}`);
    return result || { action: 'cancel' };
  } catch (err) {
    logger.warn(`[sample] Sampling failed: ${err.message}`);
    return { action: 'cancel' };
  }
}

module.exports = { sample, SAMPLING_TIMEOUT_MS };
```

- [ ] **Step 4: Commit and push**

```bash
git add server/mcp-protocol.js server/mcp/sampling.js server/tests/sampling.test.js
git commit -m "feat: MCP sampling helper with capability negotiation"
git push origin main
```

---

### Task 2: Integrate Sampling into Strategic Brain

**Files:**
- Modify: `server/orchestrator/strategic-brain.js` — try sampling before cloud LLM
- Modify: `server/tests/sampling.test.js` — add integration test

- [ ] **Step 1: Add integration test**

Add to `server/tests/sampling.test.js`:

```js
  describe('strategic brain integration', () => {
    it('sample returns decline without session — brain falls through to LLM', async () => {
      const { sample } = require('../mcp/sampling');
      // Simulate what strategic brain does: try sampling, fall through on decline
      const result = await sample(null, {
        messages: [{ role: 'user', content: { type: 'text', text: 'Decompose feature X' } }],
      });
      expect(result.action).toBe('decline');
      // Brain would fall through to _callLlm here
    });
  });
```

- [ ] **Step 2: Modify `_strategicCall` in strategic-brain.js**

Read the constructor to understand how to pass session ID. Then in `_strategicCall()` (~line 142), add a sampling attempt BEFORE the existing `_callLlm`:

```js
  async _strategicCall(templateName, variables, fallbackArgs) {
    const argsWithConfig = { ...fallbackArgs, config: this.config };

    // Try MCP sampling first (free, uses host LLM)
    if (this._sessionId) {
      try {
        const { sample } = require('../mcp/sampling');
        const prompt = buildPrompt(templateName, variables);
        const samplingResult = await sample(this._sessionId, {
          messages: [{ role: 'user', content: { type: 'text', text: prompt } }],
          maxTokens: 4096,
        });

        if (samplingResult && samplingResult.content) {
          const text = typeof samplingResult.content === 'string'
            ? samplingResult.content
            : samplingResult.content?.text || '';
          const parsed = extractJson(text);

          if (parsed) {
            if (typeof parsed.confidence === 'number' && parsed.confidence < this.confidenceThreshold) {
              logger.info(`[StrategicBrain] ${templateName}: sampling confidence ${parsed.confidence} below threshold, trying LLM`);
            } else {
              logger.info(`[StrategicBrain] ${templateName}: resolved via MCP sampling`);
              this._usage.sampling_calls = (this._usage.sampling_calls || 0) + 1;
              return { ...parsed, source: 'sampling', model: samplingResult.model };
            }
          } else {
            logger.info(`[StrategicBrain] ${templateName}: sampling returned unparseable output, trying LLM`);
          }
        }
      } catch (err) {
        logger.debug(`[StrategicBrain] ${templateName}: sampling failed (${err.message}), trying LLM`);
      }
    }

    // Existing cloud LLM path
    try {
      const result = await this._callLlm(templateName, variables);
      // ... rest of existing code unchanged ...
```

**IMPORTANT:** The `this._sessionId` needs to be set. Check how `StrategicBrain` is constructed. If it doesn't accept a session ID, add it:

```js
constructor(options = {}) {
  // ... existing code ...
  this._sessionId = options.sessionId || null;
}
```

Then in the callers (orchestrator-handlers.js), pass the session ID from task metadata when constructing the brain.

- [ ] **Step 3: Commit and push**

```bash
git add server/orchestrator/strategic-brain.js server/tests/sampling.test.js
git commit -m "feat: integrate MCP sampling into strategic brain — free task decomposition"
git push origin main
```

---

### Task 3: Verification

- [ ] **Step 1: Run sampling tests on remote**

```bash
torque-remote "cd server && npx vitest run tests/sampling.test.js --reporter verbose"
```

- [ ] **Step 2: Run all session tests for regressions**

```bash
torque-remote "cd server && npx vitest run tests/sampling.test.js tests/elicitation.test.js tests/tool-annotations.test.js tests/tool-output-schemas.test.js tests/context-handler.test.js --reporter verbose"
```

- [ ] **Step 3: Verify exports**

```bash
cd server && node -e "
const { sample } = require('./mcp/sampling');
console.log('sample exported:', typeof sample === 'function');
"
```
