# Fabro #76: CodeAgent — Code-as-Action (smolagents)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a new task kind `kind: code_agent` where the agent's **action language is executable code** (sandboxed JavaScript or Python), not JSON tool calls. Each turn: think → emit a code snippet that may call TORQUE tools and use intermediate variables → execute in sandbox → observe output → repeat until `final_answer()` is called. Inspired by smolagents' `CodeAgent`.

**Architecture:** A `code-agent-runtime.js` runs a ReAct-style loop. The agent is prompted to output Python (or JS) in a fenced block; the runtime parses, executes in Plan 75 sandbox, and captures both stdout and the return value of `final_answer()`. TORQUE tools are exposed inside the sandbox as callable functions (a generated stub file imported into the code context). Each step is a `step_event` in Plan 29 journal so the full chain is replayable and observable.

**Tech Stack:** Node.js, Plan 75 sandbox, existing provider dispatch. Builds on plans 26 (crew), 29 (journal), 43 (inline system task), 75 (sandbox).

---

## File Structure

**New files:**
- `server/code-agent/code-agent-runtime.js`
- `server/code-agent/tool-stub-generator.js` — emits `tools.py` / `tools.js` stubs
- `server/code-agent/code-extractor.js` — pulls code block from LLM response
- `server/tests/code-extractor.test.js`
- `server/tests/code-agent-runtime.test.js`

**Modified files:**
- `server/execution/task-startup.js` — branch on `kind: code_agent`
- `server/tool-defs/workflow-defs.js` — extend kind enum

---

## Task 1: Code extractor

- [ ] **Step 1: Tests**

Create `server/tests/code-extractor.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { extractCode } = require('../code-agent/code-extractor');

describe('extractCode', () => {
  it('pulls fenced python block', () => {
    const out = extractCode('I will check:\n```python\nprint("hello")\n```\nDone.', { language: 'python' });
    expect(out).toBe('print("hello")');
  });

  it('pulls fenced javascript block', () => {
    const out = extractCode('Here:\n```javascript\nconsole.log(1)\n```', { language: 'javascript' });
    expect(out).toBe('console.log(1)');
  });

  it('accepts alternate fence hints (js for javascript, py for python)', () => {
    expect(extractCode('```js\nx\n```', { language: 'javascript' })).toBe('x');
    expect(extractCode('```py\ny\n```', { language: 'python' })).toBe('y');
  });

  it('returns null when no fenced block matches', () => {
    expect(extractCode('just prose', { language: 'python' })).toBeNull();
  });

  it('returns the FIRST block when multiple are present', () => {
    const out = extractCode('```python\none\n```\n```python\ntwo\n```', { language: 'python' });
    expect(out).toBe('one');
  });

  it('tolerates unfenced code when allowUnfenced=true', () => {
    const out = extractCode('x = 1\nprint(x)', { language: 'python', allowUnfenced: true });
    expect(out).toMatch(/print\(x\)/);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/code-agent/code-extractor.js`:

```js
'use strict';

const LANG_ALIASES = {
  python: ['python', 'py'],
  javascript: ['javascript', 'js', 'typescript', 'ts'],
};

function extractCode(text, { language = 'python', allowUnfenced = false } = {}) {
  const fences = LANG_ALIASES[language] || [language];
  for (const fence of fences) {
    const re = new RegExp('```' + fence + '\\s*\\n([\\s\\S]*?)\\n```', 'i');
    const m = text.match(re);
    if (m) return m[1].trim();
  }
  // Generic fenced block (no language hint)
  const generic = text.match(/```\s*\n([\s\S]*?)\n```/);
  if (generic) return generic[1].trim();
  if (allowUnfenced) return text.trim();
  return null;
}

module.exports = { extractCode };
```

Run tests → PASS. Commit: `feat(code-agent): extractor pulls fenced code from LLM response`.

---

## Task 2: Tool stub generator

- [ ] **Step 1: Implement**

Create `server/code-agent/tool-stub-generator.js`:

```js
'use strict';

// Given a list of tool descriptors, emit a stub file the agent can import inside
// the sandbox. Each stub forwards to an HTTP endpoint on the host TORQUE.
function generatePythonStub({ tools, bridgeUrl }) {
  const lines = [
    'import json, urllib.request',
    '',
    `_BRIDGE = "${bridgeUrl}"`,
    '',
    'def _call(name, args):',
    '    req = urllib.request.Request(_BRIDGE + "/call/" + name,',
    '        data=json.dumps(args).encode(),',
    '        headers={"Content-Type": "application/json"})',
    '    with urllib.request.urlopen(req) as resp:',
    '        return json.loads(resp.read())',
    '',
    'def final_answer(value):',
    '    return _call("__final_answer__", {"value": value})',
    '',
  ];
  for (const t of tools) {
    const sig = (t.inputSchema?.required || []).join(', ');
    lines.push(`def ${t.name}(**kwargs):`);
    lines.push(`    """${(t.description || '').replace(/"/g, '\\"')}"""`);
    lines.push(`    return _call("${t.name}", kwargs)`);
    lines.push('');
  }
  return lines.join('\n');
}

function generateJsStub({ tools, bridgeUrl }) {
  const lines = [
    `const BRIDGE = ${JSON.stringify(bridgeUrl)};`,
    'async function _call(name, args) {',
    '  const res = await fetch(BRIDGE + "/call/" + name, {',
    '    method: "POST", headers: { "Content-Type": "application/json" },',
    '    body: JSON.stringify(args),',
    '  });',
    '  return res.json();',
    '}',
    'async function final_answer(value) { return _call("__final_answer__", { value }); }',
    '',
  ];
  for (const t of tools) {
    lines.push(`async function ${t.name}(args) { return _call(${JSON.stringify(t.name)}, args); }`);
  }
  lines.push('module.exports = { ' + tools.map(t => t.name).join(', ') + ', final_answer };');
  return lines.join('\n');
}

module.exports = { generatePythonStub, generateJsStub };
```

Commit: `feat(code-agent): tool stub generator for Python + JS`.

---

## Task 3: Runtime

- [ ] **Step 1: Tests**

Create `server/tests/code-agent-runtime.test.js`:

```js
'use strict';
const { describe, it, expect, vi } = require('vitest');
const { runCodeAgent } = require('../code-agent/code-agent-runtime');

describe('runCodeAgent', () => {
  it('completes on first turn when agent calls final_answer', async () => {
    const callModel = vi.fn(async () => '```python\nfinal_answer("done")\n```');
    const runInSandbox = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0, finalAnswer: 'done' }));
    const r = await runCodeAgent({
      task: 'say done',
      callModel, runInSandbox, tools: [], language: 'python',
      maxSteps: 5,
    });
    expect(r.final_answer).toBe('done');
    expect(r.steps).toHaveLength(1);
  });

  it('iterates: step output feeds next prompt', async () => {
    let step = 0;
    const callModel = vi.fn(async ({ observations }) => {
      step++;
      if (step === 1) return '```python\nx = 40; print(x)\n```';
      return '```python\nfinal_answer(x + 2)\n```';
    });
    const runInSandbox = vi.fn(async (code) => {
      if (code.includes('final_answer')) return { stdout: '', finalAnswer: 42, exitCode: 0 };
      return { stdout: '40\n', exitCode: 0 };
    });
    const r = await runCodeAgent({
      task: 'math', callModel, runInSandbox, tools: [], language: 'python', maxSteps: 5,
    });
    expect(r.final_answer).toBe(42);
    expect(r.steps).toHaveLength(2);
    // Second model call saw step-1 stdout
    expect(callModel.mock.calls[1][0].observations).toContain('40');
  });

  it('stops at maxSteps even without final_answer', async () => {
    const callModel = vi.fn(async () => '```python\nprint("still going")\n```');
    const runInSandbox = vi.fn(async () => ({ stdout: 'still going\n', exitCode: 0 }));
    const r = await runCodeAgent({
      task: 'x', callModel, runInSandbox, tools: [], language: 'python', maxSteps: 3,
    });
    expect(r.steps).toHaveLength(3);
    expect(r.terminated_by).toBe('max_steps');
  });

  it('captures sandbox errors as observations + retries', async () => {
    let step = 0;
    const callModel = vi.fn(async ({ observations }) => {
      step++;
      if (step === 1) return '```python\nbroken(\n```';
      return '```python\nfinal_answer("ok")\n```';
    });
    const runInSandbox = vi.fn(async (code) => {
      if (code.includes('broken')) return { stdout: '', stderr: 'SyntaxError: invalid syntax', exitCode: 1 };
      return { finalAnswer: 'ok', exitCode: 0 };
    });
    const r = await runCodeAgent({
      task: 'x', callModel, runInSandbox, tools: [], language: 'python', maxSteps: 5,
    });
    expect(r.final_answer).toBe('ok');
    // Second prompt includes the error observation
    expect(callModel.mock.calls[1][0].observations).toMatch(/SyntaxError/);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/code-agent/code-agent-runtime.js`:

```js
'use strict';
const { extractCode } = require('./code-extractor');

const SYSTEM_PROMPT_PYTHON = `You are a CodeAgent. Your action language is Python code.

On each turn, output a single fenced python block that:
- May set intermediate variables
- May call available tools (imported as Python functions)
- Prints results you want to reason about on subsequent turns

When you have a final answer, call final_answer(value).

Tools available (already imported):
{{tools}}

Previous step observations:
{{observations}}

Task:
{{task}}`;

async function runCodeAgent({ task, callModel, runInSandbox, tools = [], language = 'python', maxSteps = 6, logger = console }) {
  const steps = [];
  let observations = '';
  let finalAnswer = null;

  const toolList = tools.map(t => `- ${t.name}(${(t.inputSchema?.required || []).join(', ')}): ${t.description || ''}`).join('\n') || '(none)';

  for (let i = 0; i < maxSteps; i++) {
    const prompt = SYSTEM_PROMPT_PYTHON
      .replace('{{tools}}', toolList)
      .replace('{{observations}}', observations || '(none yet)')
      .replace('{{task}}', task);
    const response = await callModel({ prompt, observations, step: i + 1 });
    const code = extractCode(response, { language });
    if (!code) {
      steps.push({ step: i + 1, response, error: 'no code extracted' });
      observations = 'error: your previous response had no valid fenced code block. Output exactly one fenced block.';
      continue;
    }
    const result = await runInSandbox(code, { step: i + 1 });
    steps.push({ step: i + 1, code, result });
    if (result.finalAnswer !== undefined) {
      finalAnswer = result.finalAnswer;
      return { final_answer: finalAnswer, steps, terminated_by: 'final_answer', total_steps: steps.length };
    }
    observations = [result.stdout, result.stderr].filter(Boolean).join('\n').trim().slice(0, 4000);
    if (result.exitCode !== 0 && !observations) observations = `error exit code ${result.exitCode}`;
  }

  return { final_answer: finalAnswer, steps, terminated_by: 'max_steps', total_steps: steps.length };
}

module.exports = { runCodeAgent };
```

Run tests → PASS. Commit: `feat(code-agent): ReAct loop over sandboxed code execution`.

---

## Task 4: Wire into task runtime

- [ ] **Step 1: Extend kind enum + tool def**

In `server/tool-defs/workflow-defs.js` extend `kind` to include `code_agent`. Add:

```js
code_agent: {
  type: 'object',
  description: 'Config for kind=code_agent. Agent writes code as its action language.',
  properties: {
    language: { type: 'string', enum: ['python', 'javascript'], default: 'python' },
    tools: { type: 'array', items: { type: 'string' }, description: 'MCP tool names to expose inside the sandbox.' },
    max_steps: { type: 'integer', default: 6 },
    sandbox: { type: 'object', description: 'Sandbox config (Plan 75).' },
  },
},
```

- [ ] **Step 2: Branch in task-startup**

```js
if (taskMeta.kind === 'code_agent') {
  const { runCodeAgent } = require('../code-agent/code-agent-runtime');
  const { generatePythonStub, generateJsStub } = require('../code-agent/tool-stub-generator');
  const cfg = taskMeta.code_agent || {};
  const sandboxMgr = defaultContainer.get('sandboxManager');
  const sandbox = await sandboxMgr.create({ ...(cfg.sandbox || { backend: 'local-process' }) });

  // Install tool stub in sandbox
  const exposedTools = resolveTools(cfg.tools || []);
  const stub = cfg.language === 'javascript'
    ? generateJsStub({ tools: exposedTools, bridgeUrl: toolBridgeUrl() })
    : generatePythonStub({ tools: exposedTools, bridgeUrl: toolBridgeUrl() });
  await sandboxMgr.writeFile(sandbox.sandboxId, cfg.language === 'javascript' ? 'tools.js' : 'tools.py', stub);

  const provider = defaultContainer.get('providerRegistry').getProviderInstance(task.provider);
  const result = await runCodeAgent({
    task: task.task_description,
    tools: exposedTools,
    language: cfg.language || 'python',
    maxSteps: cfg.max_steps || 6,
    callModel: async ({ prompt }) => provider.runPrompt({ prompt, max_tokens: 2000 }),
    runInSandbox: async (code) => {
      const preamble = cfg.language === 'javascript' ? 'const { ' + exposedTools.map(t => t.name).join(', ') + ', final_answer } = require("./tools.js");\n' : 'from tools import *\n';
      await sandboxMgr.writeFile(sandbox.sandboxId, cfg.language === 'javascript' ? 'step.js' : 'step.py', preamble + code);
      return await sandboxMgr.runCommand(sandbox.sandboxId, {
        cmd: cfg.language === 'javascript' ? 'node' : 'python',
        args: [cfg.language === 'javascript' ? 'step.js' : 'step.py'],
        timeoutMs: 30000,
      });
    },
  });
  await sandboxMgr.destroy(sandbox.sandboxId);
  // Persist + journal each step
  for (const step of result.steps) {
    defaultContainer.get('journalWriter').write({
      workflowId: task.workflow_id, taskId,
      type: 'code_agent_step', payload: { step: step.step, code: step.code, stdout: step.result?.stdout?.slice(0, 500) },
    });
  }
  db.prepare(`UPDATE tasks SET status = 'completed', output = ?, completed_at = datetime('now') WHERE task_id = ?`)
    .run(JSON.stringify(result, null, 2), taskId);
  return { codeAgent: true };
}
```

Add `code_agent_step` to `VALID_EVENT_TYPES`.

`await_restart`. Smoke: submit a task with `kind: code_agent`, `language: python`, prompt "compute sum of primes below 100, then final_answer the result". Confirm agent iterates and returns the right number.

Commit: `feat(code-agent): kind=code_agent wired through task runtime + sandbox + journal`.
