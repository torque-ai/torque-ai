# Fabro #66: Auto-Extracted Memory (mem0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** After every completed task or operator review, run a background **memory extractor** that distills durable facts, preferences, and decisions from the conversation and writes them to scoped archival memory — without requiring the agent to call a save tool. Complementary to Plan 47 (Letta-style agent-managed memory): this is **infrastructure-managed** memory. Inspired by mem0.

**Architecture:** A new `memory-extractor.js` runs as a post-task hook. Given the final task message (user+assistant+tool_results), it calls a model with an extraction prompt — "extract any durable facts/preferences/decisions worth remembering; each as a single sentence". Extracted facts are written to archival memory (Plan 47) scoped by `{ user_id, agent_id, workflow_id }`. Retrieval-time ranking adds a **relevance inference** step: reranks raw vector results by recency, tag match, and operator-tagged priority.

**Tech Stack:** Node.js, existing provider dispatch, Plan 47 archival memory store. Builds on plans 19 (lifecycle hooks), 38 (domains), 47 (agent memory).

---

## File Structure

**New files:**
- `server/memory/memory-extractor.js`
- `server/memory/relevance-reranker.js`
- `server/memory/scoped-memory.js` — user_id/agent_id/run_id scoping layer
- `server/tests/memory-extractor.test.js`
- `server/tests/relevance-reranker.test.js`

**Modified files:**
- `server/execution/task-finalizer.js` — post-task extraction hook
- `server/memory/archival-memory.js` — accept scope params
- `server/handlers/mcp-tools.js` — `recall_memory` tool with scope

---

## Task 1: Extractor

- [ ] **Step 1: Tests**

Create `server/tests/memory-extractor.test.js`:

```js
'use strict';
const { describe, it, expect, vi } = require('vitest');
const { extractMemories } = require('../memory/memory-extractor');

describe('extractMemories', () => {
  it('returns facts array from model response', async () => {
    const callModel = vi.fn(async () => ({
      memories: [
        { content: 'User prefers Postgres over MySQL', tags: ['db', 'preference'] },
        { content: 'Release is scheduled for 2026-04-15', tags: ['timeline'] },
      ],
    }));
    const r = await extractMemories({
      callModel,
      conversation: [
        { role: 'user', content: "I'm thinking postgres not mysql" },
        { role: 'assistant', content: 'Good choice. Let us target 2026-04-15 for release.' },
      ],
    });
    expect(r.memories).toHaveLength(2);
    expect(r.memories[0].content).toMatch(/Postgres/);
  });

  it('returns empty array when model finds nothing worth saving', async () => {
    const callModel = vi.fn(async () => ({ memories: [] }));
    const r = await extractMemories({
      callModel,
      conversation: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }],
    });
    expect(r.memories).toEqual([]);
  });

  it('handles malformed model output (non-array memories) gracefully', async () => {
    const callModel = vi.fn(async () => ({ memories: 'not an array' }));
    const r = await extractMemories({
      callModel,
      conversation: [{ role: 'user', content: 'test' }],
    });
    expect(r.memories).toEqual([]);
    expect(r.error).toBeDefined();
  });

  it('skips extraction when conversation is too short', async () => {
    const callModel = vi.fn();
    const r = await extractMemories({
      callModel,
      conversation: [{ role: 'user', content: 'hi' }],
      minMessages: 2,
    });
    expect(callModel).not.toHaveBeenCalled();
    expect(r.memories).toEqual([]);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/memory/memory-extractor.js`:

```js
'use strict';

const EXTRACTION_PROMPT = `You are a memory extractor. From the conversation below, extract ONLY durable facts, stated preferences, and decisions worth remembering for future sessions. Do NOT include questions, speculation, or ephemeral details.

Each memory should:
- Be a single declarative sentence
- Be written in third person ("User prefers X", not "I prefer X")
- Include 1-3 descriptive tags

Return strict JSON:
{ "memories": [ { "content": "...", "tags": ["..."] }, ... ] }

Return { "memories": [] } if nothing is worth saving.

Conversation:
{{conversation}}`;

async function extractMemories({ callModel, conversation, minMessages = 2, logger = console }) {
  if (!Array.isArray(conversation) || conversation.length < minMessages) {
    return { memories: [] };
  }
  const rendered = conversation.map(m => `${m.role}: ${m.content}`).join('\n');
  const prompt = EXTRACTION_PROMPT.replace('{{conversation}}', rendered);

  let result;
  try {
    result = await callModel({ prompt });
  } catch (err) {
    logger.warn?.('memory extraction model call failed', err);
    return { memories: [], error: err.message };
  }

  if (!result || !Array.isArray(result.memories)) {
    return { memories: [], error: 'model did not return memories array' };
  }
  return { memories: result.memories };
}

module.exports = { extractMemories };
```

Run tests → PASS. Commit: `feat(memory): extractor prompt + loop for distilling conversations into facts`.

---

## Task 2: Relevance reranker

- [ ] **Step 1: Tests**

Create `server/tests/relevance-reranker.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { rerank } = require('../memory/relevance-reranker');

describe('rerank', () => {
  const now = Date.now();
  const recentIso  = new Date(now - 60 * 1000).toISOString();
  const weekAgoIso = new Date(now - 7 * 24 * 3600 * 1000).toISOString();
  const monthAgoIso = new Date(now - 30 * 24 * 3600 * 1000).toISOString();

  it('vector score dominates when recency + tags are identical', () => {
    const items = [
      { content: 'A', vector_score: 0.5, created_at: recentIso, tags: [] },
      { content: 'B', vector_score: 0.9, created_at: recentIso, tags: [] },
    ];
    const r = rerank(items, { query: 'anything', queryTags: [] });
    expect(r[0].content).toBe('B');
  });

  it('fresher items outrank older identical-vector items', () => {
    const items = [
      { content: 'old', vector_score: 0.8, created_at: monthAgoIso, tags: [] },
      { content: 'new', vector_score: 0.8, created_at: recentIso, tags: [] },
    ];
    const r = rerank(items, { query: 'x', queryTags: [] });
    expect(r[0].content).toBe('new');
  });

  it('tag match boosts an item over one without', () => {
    const items = [
      { content: 'generic', vector_score: 0.8, created_at: weekAgoIso, tags: ['general'] },
      { content: 'tagged', vector_score: 0.75, created_at: weekAgoIso, tags: ['db', 'preference'] },
    ];
    const r = rerank(items, { query: 'x', queryTags: ['db'] });
    expect(r[0].content).toBe('tagged');
  });

  it('operator-tagged priority ("starred") outranks non-priority', () => {
    const items = [
      { content: 'starred', vector_score: 0.5, created_at: weekAgoIso, tags: ['starred'] },
      { content: 'normal',  vector_score: 0.9, created_at: recentIso, tags: [] },
    ];
    const r = rerank(items, { query: 'x', queryTags: [], priorityTag: 'starred' });
    expect(r[0].content).toBe('starred');
  });

  it('returns rerank_score + rank on each item', () => {
    const items = [{ content: 'x', vector_score: 0.5, created_at: recentIso, tags: [] }];
    const r = rerank(items, { query: 'x', queryTags: [] });
    expect(typeof r[0].rerank_score).toBe('number');
    expect(r[0].rank).toBe(1);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/memory/relevance-reranker.js`:

```js
'use strict';

// Rerank score = vector_score + recency_bonus + tag_match_bonus + priority_bonus
function rerank(items, { query, queryTags = [], priorityTag = 'starred', now = Date.now() }) {
  const scored = items.map(item => {
    const vec = item.vector_score ?? 0;
    const created = item.created_at ? new Date(item.created_at).getTime() : now;
    const ageDays = Math.max(0, (now - created) / (24 * 3600 * 1000));
    // Recency: full 0.15 if < 1 day, decays to 0 over 30 days
    const recencyBonus = Math.max(0, 0.15 * (1 - ageDays / 30));
    const itemTags = new Set(item.tags || []);
    const tagMatches = queryTags.filter(t => itemTags.has(t)).length;
    const tagBonus = Math.min(0.2, tagMatches * 0.1);
    const priorityBonus = itemTags.has(priorityTag) ? 0.3 : 0;
    return { ...item, rerank_score: vec + recencyBonus + tagBonus + priorityBonus };
  });
  scored.sort((a, b) => b.rerank_score - a.rerank_score);
  return scored.map((s, i) => ({ ...s, rank: i + 1 }));
}

module.exports = { rerank };
```

Run tests → PASS. Commit: `feat(memory): relevance reranker with recency + tag + priority boosts`.

---

## Task 3: Scoped memory + wire into finalizer

- [ ] **Step 1: Scoped memory wrapper**

Create `server/memory/scoped-memory.js`:

```js
'use strict';

function createScopedMemory({ archivalMemory, rerank }) {
  async function store({ userId = null, agentId = null, workflowId = null, runId = null }, content, tags = []) {
    const scopedTags = [...tags];
    if (userId)     scopedTags.push(`user:${userId}`);
    if (agentId)    scopedTags.push(`agent:${agentId}`);
    if (workflowId) scopedTags.push(`workflow:${workflowId}`);
    if (runId)      scopedTags.push(`run:${runId}`);
    return archivalMemory.store(agentId || 'default', content, { tags: scopedTags });
  }

  async function recall({ userId = null, agentId = null, workflowId = null, priorityTag = 'starred' }, query, k = 5) {
    const results = await archivalMemory.search(agentId || 'default', query, k * 3);
    const filtered = results.filter(r => {
      const tags = r.tags_json ? JSON.parse(r.tags_json) : [];
      if (userId     && !tags.includes(`user:${userId}`))         return false;
      if (workflowId && !tags.some(t => t.startsWith('workflow:')
          && (t === `workflow:${workflowId}` || tags.includes('starred')))) return false;
      return true;
    });
    const withScore = filtered.map(r => ({
      content: r.content, tags: r.tags_json ? JSON.parse(r.tags_json) : [],
      created_at: r.created_at, vector_score: r.score,
    }));
    return rerank(withScore, { query, queryTags: tagsFromQuery(query), priorityTag }).slice(0, k);
  }

  function tagsFromQuery(query) {
    // Very basic keyword → tag heuristic; real impl can use an embedding classifier
    const words = (query || '').toLowerCase().split(/\s+/);
    const known = ['db', 'auth', 'deploy', 'release', 'bug', 'preference'];
    return known.filter(k => words.includes(k));
  }

  return { store, recall };
}

module.exports = { createScopedMemory };
```

- [ ] **Step 2: Post-task hook**

In `server/execution/task-finalizer.js` on success, for tasks with `auto_extract_memory: true` in metadata (default true for agent-assigned tasks if a domain opts in):

```js
const extractorEnabled = meta.auto_extract_memory !== false;
if (extractorEnabled) {
  const { extractMemories } = require('../memory/memory-extractor');
  const scoped = defaultContainer.get('scopedMemory');
  const provider = providerRegistry.getProviderInstance('codex');
  const conversation = [
    { role: 'user', content: task.task_description },
    { role: 'assistant', content: typeof finalOutput === 'string' ? finalOutput : JSON.stringify(finalOutput) },
  ];
  // Fire-and-forget to avoid blocking finalization
  (async () => {
    try {
      const result = await extractMemories({
        callModel: async ({ prompt }) => {
          const out = await provider.runPrompt({ prompt, format: 'json', max_tokens: 1000 });
          return typeof out === 'string' ? JSON.parse(out) : out;
        },
        conversation,
      });
      for (const mem of (result.memories || [])) {
        await scoped.store({
          userId: task.user_id, agentId: task.agent_id,
          workflowId: task.workflow_id, runId: taskId,
        }, mem.content, mem.tags || []);
      }
      if (result.memories.length > 0) addTaskTag(taskId, `memories:${result.memories.length}`);
    } catch (err) {
      logger.warn('memory extraction failed', { taskId, err: err.message });
    }
  })();
}
```

- [ ] **Step 3: MCP tool + container**

```js
recall_memory: {
  description: 'Semantic search over archival memory with scope + relevance inference.',
  inputSchema: {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string' },
      user_id: { type: 'string' },
      workflow_id: { type: 'string' },
      agent_id: { type: 'string' },
      k: { type: 'integer', default: 5 },
    },
  },
},
```

Handler:

```js
case 'recall_memory': {
  const scoped = defaultContainer.get('scopedMemory');
  return { results: await scoped.recall({
    userId: args.user_id, agentId: args.agent_id, workflowId: args.workflow_id,
  }, args.query, args.k || 5) };
}
```

Container:

```js
container.factory('scopedMemory', (c) => {
  const { createScopedMemory } = require('./memory/scoped-memory');
  const { rerank } = require('./memory/relevance-reranker');
  return createScopedMemory({ archivalMemory: c.get('archivalMemory'), rerank });
});
```

`await_restart`. Smoke: run 3 tasks in a workflow that establish "we use Postgres" as part of the conversation. Submit a 4th task that calls `recall_memory({query:'what database did we pick'})` and confirm the Postgres memory surfaces.

Commit: `feat(memory): auto-extraction on task completion + scoped/reranked recall`.
