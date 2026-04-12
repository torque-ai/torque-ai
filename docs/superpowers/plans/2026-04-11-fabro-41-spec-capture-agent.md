# Fabro #41: Spec Capture Agent (GPT Pilot)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `spec-capture` workflow stage that turns a free-form user idea into a structured, reviewed spec document before any code generation runs. The agent inspects the initial brief, asks clarifying questions, drafts a spec, shows it to the user, and iterates until approval. Then downstream factory stages (architect, builder) consume the approved spec. Inspired by GPT Pilot's Spec Writer.

**Architecture:** Builds on Plan 30 (signals/queries/updates) for human approval. A new MCP tool `start_spec_capture(brief)` creates a workflow with a `spec-capture` task that runs an interactive agent loop. The agent emits `clarifying_question` events; the operator answers via `workflow_signal({name:'answer_question', value:{q_id, text}})`. When the agent has enough information, it produces a draft spec, and the operator approves via `workflow_update({name:'approve_spec'})`. Approved specs are stored in `specs/` as Markdown with structured frontmatter so later stages can read them.

**Tech Stack:** Node.js, existing provider registry. Builds on plans 26 (crew), 27 (state), 30 (signals/queries).

---

## File Structure

**New files:**
- `server/spec-capture/spec-capture-agent.js` — main loop
- `server/spec-capture/spec-template.js` — output schema for specs
- `server/spec-capture/question-tracker.js` — pending questions/answers
- `server/tests/spec-capture-agent.test.js`
- `server/tests/question-tracker.test.js`
- `dashboard/src/views/SpecCapture.jsx` — Q&A UI
- `docs/spec-capture.md`

**Modified files:**
- `server/handlers/mcp-tools.js` — `start_spec_capture` tool
- `server/tool-defs/`

---

## Task 1: Question tracker

- [ ] **Step 1: Tests**

Create `server/tests/question-tracker.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach } = require('vitest');
const { createQuestionTracker } = require('../spec-capture/question-tracker');

describe('questionTracker', () => {
  let tracker;
  beforeEach(() => { tracker = createQuestionTracker(); });

  it('ask returns a question_id', () => {
    const id = tracker.ask('What database?');
    expect(id).toMatch(/^q_/);
  });

  it('answer attaches a response to the question', () => {
    const id = tracker.ask('Stack?');
    tracker.answer(id, 'Node.js + Postgres');
    const q = tracker.get(id);
    expect(q.answer).toBe('Node.js + Postgres');
    expect(q.answered).toBe(true);
  });

  it('listPending returns only unanswered questions', () => {
    const a = tracker.ask('q1');
    const b = tracker.ask('q2');
    tracker.answer(a, 'a1');
    const pending = tracker.listPending();
    expect(pending.map(q => q.question_id)).toEqual([b]);
  });

  it('allAnswered returns true when no pending', () => {
    const a = tracker.ask('q1');
    expect(tracker.allAnswered()).toBe(false);
    tracker.answer(a, 'x');
    expect(tracker.allAnswered()).toBe(true);
  });

  it('answer is idempotent — re-answering replaces', () => {
    const id = tracker.ask('q');
    tracker.answer(id, 'first');
    tracker.answer(id, 'second');
    expect(tracker.get(id).answer).toBe('second');
  });
});
```

- [ ] **Step 2: Implement**

Create `server/spec-capture/question-tracker.js`:

```js
'use strict';
const { randomUUID } = require('crypto');

function createQuestionTracker(initial = []) {
  const questions = new Map();
  for (const q of initial) {
    questions.set(q.question_id, { ...q });
  }

  function ask(text) {
    const id = `q_${randomUUID().slice(0, 8)}`;
    questions.set(id, { question_id: id, text, asked_at: new Date().toISOString(), answered: false, answer: null });
    return id;
  }

  function answer(questionId, text) {
    const q = questions.get(questionId);
    if (!q) throw new Error(`Unknown question: ${questionId}`);
    q.answer = text;
    q.answered = true;
    q.answered_at = new Date().toISOString();
  }

  function get(questionId) { return questions.get(questionId) || null; }
  function listAll() { return Array.from(questions.values()); }
  function listPending() { return listAll().filter(q => !q.answered); }
  function allAnswered() { return listPending().length === 0; }

  return { ask, answer, get, listAll, listPending, allAnswered };
}

module.exports = { createQuestionTracker };
```

Run tests → PASS. Commit: `feat(spec-capture): question tracker`.

---

## Task 2: Spec template + agent loop

- [ ] **Step 1: Template module**

Create `server/spec-capture/spec-template.js`:

```js
'use strict';

const SPEC_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['title', 'goal', 'in_scope', 'out_of_scope', 'success_criteria', 'open_questions'],
  properties: {
    title: { type: 'string' },
    goal: { type: 'string', description: 'One-paragraph statement of what we are building and why.' },
    in_scope: { type: 'array', items: { type: 'string' } },
    out_of_scope: { type: 'array', items: { type: 'string' } },
    constraints: { type: 'array', items: { type: 'string' } },
    success_criteria: { type: 'array', items: { type: 'string' } },
    open_questions: { type: 'array', items: { type: 'string' }, description: 'Empty when ready for approval.' },
  },
};

function renderSpecMarkdown(spec) {
  return `---
title: ${JSON.stringify(spec.title)}
status: draft
generated_by: spec-capture
generated_at: ${new Date().toISOString()}
---

# ${spec.title}

## Goal
${spec.goal}

## In scope
${(spec.in_scope || []).map(s => `- ${s}`).join('\n')}

## Out of scope
${(spec.out_of_scope || []).map(s => `- ${s}`).join('\n')}

## Constraints
${(spec.constraints || []).map(s => `- ${s}`).join('\n')}

## Success criteria
${(spec.success_criteria || []).map(s => `- ${s}`).join('\n')}

## Open questions
${(spec.open_questions || []).map(s => `- ${s}`).join('\n')}
`;
}

module.exports = { SPEC_OUTPUT_SCHEMA, renderSpecMarkdown };
```

- [ ] **Step 2: Agent loop tests**

Create `server/tests/spec-capture-agent.test.js`:

```js
'use strict';
const { describe, it, expect, vi } = require('vitest');
const { runSpecCapture } = require('../spec-capture/spec-capture-agent');

describe('runSpecCapture', () => {
  it('first round: calls model with brief, asks clarifying questions', async () => {
    const callModel = vi.fn(async () => ({
      questions: ['Which database?', 'Self-hosted or cloud?'],
      draft: null,
      ready_for_approval: false,
    }));
    const tracker = await runSpecCapture({
      brief: 'Build a task tracker',
      callModel,
      maxRounds: 1,
      waitForAnswer: async () => 'unanswered', // never answered, agent returns
    });
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(tracker.questions.listPending()).toHaveLength(2);
  });

  it('produces a draft spec when ready_for_approval', async () => {
    let round = 0;
    const callModel = vi.fn(async () => {
      round++;
      if (round === 1) return { questions: ['?'], draft: null, ready_for_approval: false };
      return { questions: [], draft: { title: 'Tracker', goal: '...', in_scope: ['x'], out_of_scope: [], success_criteria: ['y'], open_questions: [] }, ready_for_approval: true };
    });
    const result = await runSpecCapture({
      brief: 'Task tracker',
      callModel,
      maxRounds: 5,
      waitForAnswer: async (q) => 'Postgres',
    });
    expect(result.spec.title).toBe('Tracker');
    expect(result.ready_for_approval).toBe(true);
  });

  it('stops at maxRounds even if not ready', async () => {
    const callModel = vi.fn(async () => ({ questions: ['more?'], draft: null, ready_for_approval: false }));
    const result = await runSpecCapture({
      brief: 'X',
      callModel,
      maxRounds: 3,
      waitForAnswer: async () => 'maybe',
    });
    expect(callModel).toHaveBeenCalledTimes(3);
    expect(result.terminated_by).toBe('max_rounds');
  });
});
```

- [ ] **Step 3: Implement agent**

Create `server/spec-capture/spec-capture-agent.js`:

```js
'use strict';
const { createQuestionTracker } = require('./question-tracker');
const { SPEC_OUTPUT_SCHEMA } = require('./spec-template');

async function runSpecCapture({ brief, callModel, waitForAnswer, maxRounds = 6 }) {
  const tracker = createQuestionTracker();
  let lastDraft = null;

  for (let round = 0; round < maxRounds; round++) {
    const history = tracker.listAll().map(q => ({ q: q.text, a: q.answer || '<unanswered>' }));
    const result = await callModel({
      brief,
      qa_history: history,
      pending_question_count: tracker.listPending().length,
      output_schema: SPEC_OUTPUT_SCHEMA,
    });

    if (Array.isArray(result.questions) && result.questions.length > 0) {
      const newQids = result.questions.map(q => tracker.ask(q));
      // Wait for answers (operator-driven; in tests, waitForAnswer returns synchronously)
      for (const qid of newQids) {
        const ans = await waitForAnswer(qid);
        if (ans !== 'unanswered') tracker.answer(qid, ans);
      }
    }

    if (result.draft) lastDraft = result.draft;
    if (result.ready_for_approval && result.draft) {
      return {
        spec: result.draft,
        questions: tracker,
        ready_for_approval: true,
        rounds: round + 1,
        terminated_by: 'ready_for_approval',
      };
    }
  }

  return {
    spec: lastDraft,
    questions: tracker,
    ready_for_approval: false,
    rounds: maxRounds,
    terminated_by: 'max_rounds',
  };
}

module.exports = { runSpecCapture };
```

Run tests → PASS. Commit: `feat(spec-capture): agent loop with question/answer + draft spec`.

---

## Task 3: MCP tool wiring

- [ ] **Step 1: Tool def**

In `server/tool-defs/`:

```js
start_spec_capture: {
  description: 'Start a spec-capture workflow that turns a free-form brief into a structured spec via Q&A. Returns a workflow_id; submit answers via workflow_signal and approve via workflow_update.',
  inputSchema: {
    type: 'object',
    required: ['brief'],
    properties: {
      brief: { type: 'string', description: 'Free-form description of what to build.' },
      provider: { type: 'string', default: 'codex' },
      max_rounds: { type: 'integer', default: 6, minimum: 1, maximum: 20 },
      output_path: { type: 'string', description: 'Path to write the approved spec markdown file. Defaults to specs/<title-slug>.md' },
    },
  },
},
```

- [ ] **Step 2: Handler**

In `server/handlers/mcp-tools.js`:

```js
case 'start_spec_capture': {
  const { runSpecCapture } = require('../spec-capture/spec-capture-agent');
  const { renderSpecMarkdown } = require('../spec-capture/spec-template');
  const provider = providerRegistry.getProviderInstance(args.provider || 'codex');

  const result = await runSpecCapture({
    brief: args.brief,
    maxRounds: args.max_rounds || 6,
    callModel: async ({ brief, qa_history, output_schema }) => {
      const prompt = buildSpecPrompt({ brief, qa_history, schema: output_schema });
      const out = await provider.runPrompt({ prompt, format: 'json', max_tokens: 4000 });
      return typeof out === 'string' ? JSON.parse(out) : out;
    },
    waitForAnswer: async (questionId) => {
      // Block until operator signals an answer
      return await waitForSignalAnswer(questionId);
    },
  });

  if (result.ready_for_approval && result.spec) {
    const md = renderSpecMarkdown(result.spec);
    const slug = result.spec.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
    const path = args.output_path || `specs/${slug}.md`;
    require('fs').writeFileSync(path, md);
    return { ok: true, spec_path: path, rounds: result.rounds };
  }

  return { ok: false, terminated_by: result.terminated_by, draft: result.spec, pending_questions: result.questions.listPending() };
}

function buildSpecPrompt({ brief, qa_history, schema }) {
  return `You are a spec writer. Convert the following user brief into a structured spec.

Brief:
${brief}

Q&A so far:
${qa_history.map((h, i) => `Q${i + 1}: ${h.q}\nA${i + 1}: ${h.a}`).join('\n\n')}

Output a JSON object with this shape:
- questions: string[] (NEW clarifying questions; empty if you have enough information)
- draft: object matching the schema below (null if you still need answers)
- ready_for_approval: boolean (true ONLY when draft is complete and there are no critical unknowns)

Spec schema:
${JSON.stringify(schema, null, 2)}

Respond with ONLY the JSON object.`;
}
```

(Implement `waitForSignalAnswer` against the existing event bus / signal pipeline from Plan 30.)

Commit: `feat(spec-capture): start_spec_capture MCP tool`.

---

## Task 4: Dashboard Q&A panel

- [ ] **Step 1: REST**

In `server/api/routes/spec-capture.js`:

```js
router.get('/:workflow_id/questions', (req, res) => {
  // Read pending questions from the workflow's question tracker (stored in workflow state via Plan 27)
  const ws = defaultContainer.get('workflowState');
  const state = ws.getState(req.params.workflow_id);
  res.json({ questions: state.questions || [] });
});

router.post('/:workflow_id/answer', express.json(), (req, res) => {
  const ctrl = defaultContainer.get('workflowControl');
  const r = ctrl.signal(req.params.workflow_id, 'answer_question', { question_id: req.body.question_id, text: req.body.text });
  res.json(r);
});

router.post('/:workflow_id/approve', express.json(), async (req, res) => {
  const ctrl = defaultContainer.get('workflowControl');
  const r = await ctrl.update(req.params.workflow_id, 'approve_spec', true);
  res.json(r);
});
```

- [ ] **Step 2: Dashboard view**

Create `dashboard/src/views/SpecCapture.jsx`: shows the brief, list of pending questions with answer textareas, current draft (rendered Markdown), and an "Approve and write spec" button.

`await_restart`. Smoke: `start_spec_capture({brief: 'Build a recipe app'})`, watch the dashboard, answer 2 questions, approve. Confirm `specs/recipe-app.md` exists with the structured frontmatter.

Commit: `feat(spec-capture): dashboard Q&A + REST surface`.
