# Factory Dependency Resolver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `missing_dep` classification and a pluggable dependency-resolver that installs the package, updates the project's manifest, and commits on the feature branch, so factory verify failures caused by missing packages recover instead of stalling.

**Architecture:** New module `server/factory/dep-resolver/` with a registry, a Python adapter (regex detection + LLM module→package mapping), an escalation helper (one-shot retry via the project's `reasoning` routing category), and a `resolve()` orchestrator. Integrates into `reviewVerifyFailure` as a 5th classification path, and into `executeVerifyStage` as a new branch that submits a Codex resolver task, awaits, re-runs verify, and handles cascade (cap 3) + resolver failures (escalation → pause).

**Tech Stack:** Node.js, vitest with threads pool (per `server/vitest.config.js`), existing factory helpers (`submitFactoryInternalTask`, `handleAwaitTask`, `factoryHealth.updateProject`, `factoryIntake.updateWorkItem`, `safeLogDecision`), existing trust-level gate flow.

**Spec:** [docs/superpowers/specs/2026-04-19-factory-dep-resolver-design.md](../specs/2026-04-19-factory-dep-resolver-design.md)

---

## File Structure

### New

- `server/factory/dep-resolver/index.js` — orchestrator. Exports `resolve({ classification, project, worktree, workItem, instance, options }) → { outcome, reverifyNeeded, reason }`.
- `server/factory/dep-resolver/registry.js` — adapter registration + dispatch by `manager`. Exports `registerAdapter(name, adapter)`, `getAdapter(name)`, `listManagers()`, `detect(errorOutput) → { detected, adapter, ...adapterResult } | null`.
- `server/factory/dep-resolver/escalation.js` — LLM escalation helper. Exports `escalate({ project, workItem, originalError, resolverError, resolverPrompt, manifestExcerpt }) → { action: 'retry'|'pause', revisedPrompt?, reason }`.
- `server/factory/dep-resolver/adapters/python.js` — Python adapter. Exports `createPythonAdapter() → { manager: 'python', detect, mapModuleToPackage, buildResolverPrompt, validateManifestUpdate }`.
- `server/tests/dep-resolver-registry.test.js` — unit tests for registry dispatch + empty-registry fallthrough.
- `server/tests/dep-resolver-python.test.js` — unit tests for every Python regex pattern, LLM mapping, buildResolverPrompt, validateManifestUpdate.
- `server/tests/dep-resolver-escalation.test.js` — LLM returns retry / pause / invalid-json / provider-down.
- `server/tests/dep-resolver-orchestrator.test.js` — `resolve()` unit tests: happy path, cascade counter increment, kill switch.
- `server/tests/factory-dep-resolver-integration.test.js` — 7 scenarios end-to-end through `executeVerifyStage`.

### Modified

- `server/factory/verify-review.js`
  - Around line 184 (`async function reviewVerifyFailure({...})`): add `missing_dep` classification branch between env-failure detection and intersection analysis.
- `server/factory/loop-controller.js`
  - Around line 4742 (where `verifyReview.reviewVerifyFailure(...)` is called inside `executeVerifyStage`): branch on `review.classification === 'missing_dep'` → invoke resolver → re-verify or escalation → pause.
- `server/tests/verify-review.test.js`
  - Extend with 3 tests for the new `missing_dep` classification (adapter detects + LLM maps → returns missing_dep; LLM low confidence → falls through to ambiguous; no adapter matches → existing classifier continues).

No DB migrations. State lives in `factory_projects.config_json.dep_resolver` and `config_json.dep_resolve_cycle_count`. No new routes.

---

## Task 1: dep-resolver module skeleton

**Files:**
- Create: `server/factory/dep-resolver/index.js`
- Create: `server/factory/dep-resolver/registry.js`
- Create: `server/factory/dep-resolver/adapters/python.js`
- Create: `server/factory/dep-resolver/escalation.js`
- Create: `server/tests/dep-resolver-registry.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/tests/dep-resolver-registry.test.js`:

```js
'use strict';

describe('dep-resolver module exports', () => {
  it('exports registry + adapters + escalation + orchestrator stubs with expected shapes', () => {
    const registry = require('../factory/dep-resolver/registry');
    expect(typeof registry.registerAdapter).toBe('function');
    expect(typeof registry.getAdapter).toBe('function');
    expect(typeof registry.listManagers).toBe('function');
    expect(typeof registry.detect).toBe('function');
    expect(typeof registry.clearAdaptersForTests).toBe('function');

    const { createPythonAdapter } = require('../factory/dep-resolver/adapters/python');
    expect(typeof createPythonAdapter).toBe('function');
    const adapter = createPythonAdapter();
    expect(adapter.manager).toBe('python');
    expect(typeof adapter.detect).toBe('function');
    expect(typeof adapter.buildResolverPrompt).toBe('function');
    expect(typeof adapter.validateManifestUpdate).toBe('function');
    expect(typeof adapter.mapModuleToPackage).toBe('function');

    const escalation = require('../factory/dep-resolver/escalation');
    expect(typeof escalation.escalate).toBe('function');

    const orchestrator = require('../factory/dep-resolver/index');
    expect(typeof orchestrator.resolve).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/dep-resolver-registry.test.js`
Expected: FAIL with "Cannot find module '../factory/dep-resolver/registry'".

- [ ] **Step 3: Write minimal skeletons**

Create `server/factory/dep-resolver/registry.js`:

```js
'use strict';

const adapters = new Map();

function registerAdapter(name, adapter) {
  if (!name || typeof name !== 'string') throw new Error('registerAdapter requires a string name');
  if (!adapter || typeof adapter.detect !== 'function') throw new Error('adapter must have a detect() function');
  adapters.set(name, adapter);
}

function getAdapter(name) {
  return adapters.get(name) || null;
}

function listManagers() {
  return Array.from(adapters.keys());
}

function detect(_errorOutput) {
  return null;
}

function clearAdaptersForTests() {
  adapters.clear();
}

module.exports = {
  registerAdapter,
  getAdapter,
  listManagers,
  detect,
  clearAdaptersForTests,
};
```

Create `server/factory/dep-resolver/adapters/python.js`:

```js
'use strict';

function createPythonAdapter() {
  return {
    manager: 'python',
    detect(_errorOutput) { return { detected: false }; },
    async mapModuleToPackage(_opts) { return { package_name: null, confidence: 'low' }; },
    buildResolverPrompt(_opts) { return ''; },
    validateManifestUpdate(_worktreePath, _expectedPackage) { return { valid: false, reason: 'stub' }; },
  };
}

module.exports = { createPythonAdapter };
```

Create `server/factory/dep-resolver/escalation.js`:

```js
'use strict';

async function escalate(_opts) {
  return { action: 'pause', reason: 'escalation stub' };
}

module.exports = { escalate };
```

Create `server/factory/dep-resolver/index.js`:

```js
'use strict';

async function resolve(_opts) {
  return { outcome: 'unhandled', reverifyNeeded: false, reason: 'stub' };
}

module.exports = { resolve };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run tests/dep-resolver-registry.test.js`
Expected: PASS (1/1).

- [ ] **Step 5: Commit**

```bash
git add server/factory/dep-resolver server/tests/dep-resolver-registry.test.js
git commit -m "feat(factory): dep-resolver module skeleton"
```

---

## Task 2: Python adapter — regex detection

**Files:**
- Modify: `server/factory/dep-resolver/adapters/python.js` (`detect`)
- Create: `server/tests/dep-resolver-python.test.js`

- [ ] **Step 1: Write the failing tests**

Create `server/tests/dep-resolver-python.test.js`:

```js
'use strict';

const { createPythonAdapter } = require('../factory/dep-resolver/adapters/python');

describe('python adapter detect()', () => {
  const adapter = createPythonAdapter();

  it('detects ModuleNotFoundError with single-quoted module name', () => {
    const r = adapter.detect(`
      Traceback (most recent call last):
        File "tests/test_foo.py", line 3, in <module>
          import opencv
      ModuleNotFoundError: No module named 'opencv'
    `);
    expect(r.detected).toBe(true);
    expect(r.manager).toBe('python');
    expect(r.module_name).toBe('opencv');
    expect(r.signals).toContain('ModuleNotFoundError');
  });

  it('detects ModuleNotFoundError with double-quoted module name', () => {
    const r = adapter.detect(`ModuleNotFoundError: No module named "scikit"`);
    expect(r.detected).toBe(true);
    expect(r.module_name).toBe('scikit');
  });

  it('detects dotted module names', () => {
    const r = adapter.detect(`ModuleNotFoundError: No module named 'foo.bar.baz'`);
    expect(r.detected).toBe(true);
    expect(r.module_name).toBe('foo.bar.baz');
  });

  it('detects ImportError cannot-import-name form', () => {
    const r = adapter.detect(`ImportError: cannot import name 'Thing' from 'pkg'`);
    expect(r.detected).toBe(true);
    expect(r.signals).toContain('ImportError');
    expect(r.module_name).toBe('pkg');
  });

  it('detects Python 2 style "No module named X" without quotes', () => {
    const r = adapter.detect(`ImportError: No module named yaml`);
    expect(r.detected).toBe(true);
    expect(r.module_name).toBe('yaml');
  });

  it('returns detected=false on output with no dep miss', () => {
    const r = adapter.detect(`FAILED tests/foo.py::test_bar - AssertionError: expected 1 got 2`);
    expect(r.detected).toBe(false);
  });

  it('returns detected=false on empty output', () => {
    expect(adapter.detect('').detected).toBe(false);
    expect(adapter.detect(null).detected).toBe(false);
    expect(adapter.detect(undefined).detected).toBe(false);
  });

  it('prefers the first match when multiple missing modules appear', () => {
    const r = adapter.detect(`
      ModuleNotFoundError: No module named 'first'
      ModuleNotFoundError: No module named 'second'
    `);
    expect(r.detected).toBe(true);
    expect(r.module_name).toBe('first');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/dep-resolver-python.test.js`
Expected: FAIL on all 8 new tests (stub returns `{detected: false}`).

- [ ] **Step 3: Implement `detect()` in the Python adapter**

Replace the stub in `server/factory/dep-resolver/adapters/python.js`:

```js
'use strict';

const PYTHON_MISS_PATTERNS = [
  { re: /ModuleNotFoundError: No module named ['"]([\w.]+)['"]/, signal: 'ModuleNotFoundError' },
  { re: /ImportError: cannot import name ['"]([\w.]+)['"] from ['"]([\w.]+)['"]/, signal: 'ImportError', groupIndex: 2 },
  { re: /ImportError: No module named ([\w.]+)/, signal: 'ImportError' },
];

function detect(errorOutput) {
  if (typeof errorOutput !== 'string' || errorOutput.length === 0) {
    return { detected: false };
  }
  for (const { re, signal, groupIndex } of PYTHON_MISS_PATTERNS) {
    const m = errorOutput.match(re);
    if (m) {
      const moduleName = m[groupIndex || 1];
      return {
        detected: true,
        manager: 'python',
        module_name: moduleName,
        signals: [signal],
      };
    }
  }
  return { detected: false };
}

function createPythonAdapter() {
  return {
    manager: 'python',
    detect,
    async mapModuleToPackage(_opts) { return { package_name: null, confidence: 'low' }; },
    buildResolverPrompt(_opts) { return ''; },
    validateManifestUpdate(_worktreePath, _expectedPackage) { return { valid: false, reason: 'stub' }; },
  };
}

module.exports = { createPythonAdapter, PYTHON_MISS_PATTERNS };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/dep-resolver-python.test.js`
Expected: PASS (8/8).

- [ ] **Step 5: Commit**

```bash
git add server/factory/dep-resolver/adapters/python.js server/tests/dep-resolver-python.test.js
git commit -m "feat(factory): python dep-resolver regex detection"
```

---

## Task 3: Python adapter — LLM module→package mapping

**Files:**
- Modify: `server/factory/dep-resolver/adapters/python.js` (`mapModuleToPackage`)
- Modify: `server/tests/dep-resolver-python.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/dep-resolver-python.test.js`:

```js
const path = require('node:path');
const adapterModulePath = path.resolve(__dirname, '../factory/dep-resolver/adapters/python.js');

describe('python adapter mapModuleToPackage()', () => {
  const savedCache = new Map();

  function installMocks({ submit, await: awaitFn, task }) {
    [
      { path: require.resolve('../factory/internal-task-submit'), exports: { submitFactoryInternalTask: submit } },
      { path: require.resolve('../handlers/workflow/await'), exports: { handleAwaitTask: awaitFn } },
      { path: require.resolve('../db/task-core'), exports: { getTask: task } },
    ].forEach(({ path, exports }) => {
      savedCache.set(path, require.cache[path]);
      require.cache[path] = { id: path, filename: path, loaded: true, exports, children: [], paths: [] };
    });
    delete require.cache[adapterModulePath];
  }

  afterEach(() => {
    for (const [p, cached] of savedCache) {
      if (cached) require.cache[p] = cached;
      else delete require.cache[p];
    }
    savedCache.clear();
    delete require.cache[adapterModulePath];
  });

  it('returns {package_name: opencv-python, confidence: high} for cv2 when LLM answers', async () => {
    installMocks({
      submit: vi.fn().mockResolvedValue({ task_id: 'm1' }),
      await: vi.fn().mockResolvedValue({ status: 'completed' }),
      task: vi.fn().mockReturnValue({
        status: 'completed',
        output: '{"package_name":"opencv-python","confidence":"high"}',
      }),
    });
    const { createPythonAdapter } = require('../factory/dep-resolver/adapters/python');
    const adapter = createPythonAdapter();
    const r = await adapter.mapModuleToPackage({
      module_name: 'cv2',
      error_output: "ModuleNotFoundError: No module named 'cv2'",
      manifest_excerpt: '[project]\nname = "bitsy"',
      project: { id: 'p', path: '/tmp/p' },
      workItem: { id: 1 },
    });
    expect(r.package_name).toBe('opencv-python');
    expect(r.confidence).toBe('high');
  });

  it('returns {package_name: null, confidence: low} when LLM returns low confidence', async () => {
    installMocks({
      submit: vi.fn().mockResolvedValue({ task_id: 'm2' }),
      await: vi.fn().mockResolvedValue({ status: 'completed' }),
      task: vi.fn().mockReturnValue({
        status: 'completed',
        output: '{"package_name":null,"confidence":"low"}',
      }),
    });
    const { createPythonAdapter } = require('../factory/dep-resolver/adapters/python');
    const r = await createPythonAdapter().mapModuleToPackage({
      module_name: 'unknown_thing',
      error_output: 'x',
      manifest_excerpt: '',
      project: { id: 'p', path: '/tmp/p' },
      workItem: { id: 1 },
    });
    expect(r.package_name).toBeNull();
    expect(r.confidence).toBe('low');
  });

  it('returns low confidence when submit throws', async () => {
    installMocks({
      submit: vi.fn().mockRejectedValue(new Error('provider down')),
      await: vi.fn(),
      task: vi.fn(),
    });
    const { createPythonAdapter } = require('../factory/dep-resolver/adapters/python');
    const r = await createPythonAdapter().mapModuleToPackage({
      module_name: 'cv2',
      error_output: 'x',
      manifest_excerpt: '',
      project: { id: 'p', path: '/tmp/p' },
      workItem: { id: 1 },
    });
    expect(r.package_name).toBeNull();
    expect(r.confidence).toBe('low');
  });

  it('returns low confidence when output is unparseable', async () => {
    installMocks({
      submit: vi.fn().mockResolvedValue({ task_id: 'm3' }),
      await: vi.fn().mockResolvedValue({ status: 'completed' }),
      task: vi.fn().mockReturnValue({ status: 'completed', output: 'not json' }),
    });
    const { createPythonAdapter } = require('../factory/dep-resolver/adapters/python');
    const r = await createPythonAdapter().mapModuleToPackage({
      module_name: 'cv2',
      error_output: 'x',
      manifest_excerpt: '',
      project: { id: 'p', path: '/tmp/p' },
      workItem: { id: 1 },
    });
    expect(r.package_name).toBeNull();
    expect(r.confidence).toBe('low');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/dep-resolver-python.test.js`
Expected: FAIL on 4 new tests (stub returns null/low).

- [ ] **Step 3: Implement `mapModuleToPackage`**

Replace the stub in `server/factory/dep-resolver/adapters/python.js`:

```js
const MAP_LLM_TIMEOUT_MS = 60_000;

async function mapModuleToPackage({ module_name, error_output, manifest_excerpt, project, workItem, timeoutMs = MAP_LLM_TIMEOUT_MS }) {
  const { submitFactoryInternalTask } = require('../../internal-task-submit');
  const { handleAwaitTask } = require('../../../handlers/workflow/await');
  const taskCore = require('../../../db/task-core');

  const prompt = buildMappingPrompt({ module_name, error_output, manifest_excerpt });
  let taskId;
  try {
    const submission = await submitFactoryInternalTask({
      task: prompt,
      working_directory: project?.path || process.cwd(),
      kind: 'reasoning',
      project_id: project?.id,
      work_item_id: workItem?.id,
      timeout_minutes: Math.max(1, Math.floor(timeoutMs / 60_000)),
    });
    taskId = submission?.task_id || null;
  } catch (_e) {
    return { package_name: null, confidence: 'low' };
  }
  if (!taskId) return { package_name: null, confidence: 'low' };

  try {
    await handleAwaitTask({ task_id: taskId, timeout_minutes: Math.max(1, Math.floor(timeoutMs / 60_000)), heartbeat_minutes: 0 });
  } catch (_e) {
    return { package_name: null, confidence: 'low' };
  }
  const task = taskCore.getTask(taskId);
  if (!task || task.status !== 'completed') return { package_name: null, confidence: 'low' };

  const raw = String(task.output || '').trim();
  if (!raw) return { package_name: null, confidence: 'low' };
  try {
    const jsonMatch = raw.match(/\{[\s\S]*?\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(raw);
    const pkg = typeof parsed.package_name === 'string' && parsed.package_name.trim().length > 0
      ? parsed.package_name.trim()
      : null;
    const conf = parsed.confidence === 'high' || parsed.confidence === 'medium' ? parsed.confidence : 'low';
    if (!pkg) return { package_name: null, confidence: 'low' };
    return { package_name: pkg, confidence: conf };
  } catch (_e) {
    void _e;
    return { package_name: null, confidence: 'low' };
  }
}

function buildMappingPrompt({ module_name, error_output, manifest_excerpt }) {
  return `You are helping a software factory recover from a missing-dependency verify failure in a Python project.

The verify step failed because the following module could not be imported: \`${module_name}\`.

Relevant error output:
${(error_output || '').slice(0, 4000)}

Relevant manifest excerpt (truncated):
${(manifest_excerpt || '(none)').slice(0, 4000)}

Return ONLY valid JSON matching this shape:
{"package_name":"<PyPI package name or null>","confidence":"high"|"medium"|"low"}

- "high"   — you are confident which PyPI package installs this module (e.g. \`cv2\` → \`opencv-python\`).
- "medium" — best guess but not certain.
- "low"    — unclear; the factory should treat this as unresolvable.
`;
}

function createPythonAdapter() {
  return {
    manager: 'python',
    detect,
    mapModuleToPackage,
    buildResolverPrompt(_opts) { return ''; },
    validateManifestUpdate(_worktreePath, _expectedPackage) { return { valid: false, reason: 'stub' }; },
  };
}

module.exports = { createPythonAdapter, PYTHON_MISS_PATTERNS, MAP_LLM_TIMEOUT_MS };
```

Keep `detect` + `PYTHON_MISS_PATTERNS` from Task 2 at the top of the file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/dep-resolver-python.test.js`
Expected: PASS (12/12: 8 detect + 4 mapping).

- [ ] **Step 5: Commit**

```bash
git add server/factory/dep-resolver/adapters/python.js server/tests/dep-resolver-python.test.js
git commit -m "feat(factory): python dep-resolver LLM module→package mapping"
```

---

## Task 4: Python adapter — buildResolverPrompt + validateManifestUpdate

**Files:**
- Modify: `server/factory/dep-resolver/adapters/python.js` (`buildResolverPrompt`, `validateManifestUpdate`)
- Modify: `server/tests/dep-resolver-python.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/dep-resolver-python.test.js`:

```js
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

describe('python adapter buildResolverPrompt()', () => {
  it('includes package name, manager, worktree path, and install/commit instructions', () => {
    const adapter = createPythonAdapter();
    const prompt = adapter.buildResolverPrompt({
      package_name: 'opencv-python',
      project: { id: 'p', path: '/tmp/p', name: 'bitsy' },
      worktree: { path: '/tmp/p/.worktrees/feat-factory-79' },
      workItem: { id: 79, title: 'Add scoring' },
      error_output: 'ModuleNotFoundError: No module named cv2',
    });
    expect(prompt).toContain('opencv-python');
    expect(prompt).toContain('/tmp/p/.worktrees/feat-factory-79');
    expect(prompt).toContain('pyproject.toml');
    expect(prompt).toContain('requirements.txt');
    expect(prompt).toContain('lock');
    expect(prompt).toContain('Commit');
  });
});

describe('python adapter validateManifestUpdate()', () => {
  let tmpRepo;
  beforeEach(() => {
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-resolver-validate-'));
    execFileSync('git', ['init', '-q'], { cwd: tmpRepo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpRepo });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: tmpRepo });
    fs.writeFileSync(path.join(tmpRepo, 'README.md'), 'x\n');
    execFileSync('git', ['add', 'README.md'], { cwd: tmpRepo });
    execFileSync('git', ['commit', '-m', 'init', '-q'], { cwd: tmpRepo });
  });

  afterEach(() => {
    try { fs.rmSync(tmpRepo, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('returns valid=true when last commit adds expected package to pyproject.toml', () => {
    fs.writeFileSync(path.join(tmpRepo, 'pyproject.toml'),
      '[project]\nname = "demo"\ndependencies = ["opencv-python"]\n');
    execFileSync('git', ['add', 'pyproject.toml'], { cwd: tmpRepo });
    execFileSync('git', ['commit', '-m', 'deps: add opencv-python', '-q'], { cwd: tmpRepo });

    const adapter = createPythonAdapter();
    const r = adapter.validateManifestUpdate(tmpRepo, 'opencv-python');
    expect(r.valid).toBe(true);
  });

  it('returns valid=true when package appears in requirements.txt', () => {
    fs.writeFileSync(path.join(tmpRepo, 'requirements.txt'), 'opencv-python==4.9.0\n');
    execFileSync('git', ['add', 'requirements.txt'], { cwd: tmpRepo });
    execFileSync('git', ['commit', '-m', 'deps: add opencv-python', '-q'], { cwd: tmpRepo });

    const r = createPythonAdapter().validateManifestUpdate(tmpRepo, 'opencv-python');
    expect(r.valid).toBe(true);
  });

  it('returns valid=false when package is not in any known manifest', () => {
    fs.writeFileSync(path.join(tmpRepo, 'pyproject.toml'), '[project]\nname = "demo"\n');
    execFileSync('git', ['add', 'pyproject.toml'], { cwd: tmpRepo });
    execFileSync('git', ['commit', '-m', 'chore: init pyproject', '-q'], { cwd: tmpRepo });

    const r = createPythonAdapter().validateManifestUpdate(tmpRepo, 'opencv-python');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/not found/i);
  });

  it('returns valid=false when worktree path does not exist', () => {
    const r = createPythonAdapter().validateManifestUpdate('/nonexistent-path', 'opencv-python');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/(does not exist|enoent)/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/dep-resolver-python.test.js`
Expected: FAIL on 5 new tests (stubs).

- [ ] **Step 3: Implement `buildResolverPrompt` + `validateManifestUpdate`**

In `server/factory/dep-resolver/adapters/python.js`, replace the two stubs:

```js
const fsPromises = require('node:fs').promises;
const fsSync = require('node:fs');
const nodePath = require('node:path');

function buildResolverPrompt({ package_name, project, worktree, workItem, error_output }) {
  const worktreePath = worktree?.path || project?.path || '';
  return `The verify step failed with a missing Python dependency.

Detected missing package: \`${package_name}\` (manager: python).

Error output:
${(error_output || '').slice(0, 2000)}

Your job:
1. Identify the project's Python dependency manifest at ${worktreePath}. Check in order: pyproject.toml, requirements.txt, requirements-dev.txt, setup.py, setup.cfg.
2. Add \`${package_name}\` to the appropriate section — runtime deps if imported by non-test code, dev/test deps if only tests use it. Respect existing version-pinning conventions.
3. Run the project's install command (pip install / poetry add / uv pip install / whichever matches the project's toolchain).
4. If a lock file exists (poetry.lock / uv.lock / Pipfile.lock), regenerate it.
5. Commit with a conventional message like \`deps: add ${package_name}\` on the current branch.
6. Do NOT modify application code. Do NOT run the test suite.

Context: worktree at ${worktreePath}, work item ${workItem?.id || '?'}: "${workItem?.title || ''}".
After making the edits, stop.
`;
}

const MANIFEST_CANDIDATES = ['pyproject.toml', 'requirements.txt', 'requirements-dev.txt', 'setup.py', 'setup.cfg'];

function validateManifestUpdate(worktreePath, expectedPackage) {
  if (!worktreePath || !fsSync.existsSync(worktreePath)) {
    return { valid: false, reason: `worktree path does not exist: ${worktreePath}` };
  }
  const needle = String(expectedPackage || '').trim();
  if (!needle) return { valid: false, reason: 'empty expected package name' };
  const normalized = needle.toLowerCase();
  for (const candidate of MANIFEST_CANDIDATES) {
    const p = nodePath.join(worktreePath, candidate);
    if (!fsSync.existsSync(p)) continue;
    try {
      const content = fsSync.readFileSync(p, 'utf8').toLowerCase();
      if (content.includes(normalized)) {
        return { valid: true, manifest: candidate };
      }
    } catch (_e) {
      void _e;
    }
  }
  return { valid: false, reason: `package ${needle} not found in any known manifest` };
}

function createPythonAdapter() {
  return {
    manager: 'python',
    detect,
    mapModuleToPackage,
    buildResolverPrompt,
    validateManifestUpdate,
  };
}

module.exports = { createPythonAdapter, PYTHON_MISS_PATTERNS, MAP_LLM_TIMEOUT_MS, MANIFEST_CANDIDATES };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/dep-resolver-python.test.js`
Expected: PASS (17/17).

- [ ] **Step 5: Commit**

```bash
git add server/factory/dep-resolver/adapters/python.js server/tests/dep-resolver-python.test.js
git commit -m "feat(factory): python dep-resolver prompt + manifest validation"
```

---

## Task 5: Registry — dispatch + default Python registration

**Files:**
- Modify: `server/factory/dep-resolver/registry.js` (`detect`)
- Modify: `server/tests/dep-resolver-registry.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/dep-resolver-registry.test.js`:

```js
describe('registry.detect()', () => {
  const registry = require('../factory/dep-resolver/registry');

  beforeEach(() => { registry.clearAdaptersForTests(); });
  afterEach(() => { registry.clearAdaptersForTests(); });

  it('returns null when no adapter matches', () => {
    registry.registerAdapter('python', { detect: () => ({ detected: false }) });
    const r = registry.detect('FAILED tests/foo.py::test_bar - assertion');
    expect(r).toBeNull();
  });

  it('returns the first adapter that matches along with its detect result', () => {
    const pythonAdapter = {
      manager: 'python',
      detect: () => ({ detected: true, module_name: 'cv2', manager: 'python', signals: ['ModuleNotFoundError'] }),
    };
    const npmAdapter = {
      manager: 'npm',
      detect: () => ({ detected: false }),
    };
    registry.registerAdapter('python', pythonAdapter);
    registry.registerAdapter('npm', npmAdapter);

    const r = registry.detect("ModuleNotFoundError: No module named 'cv2'");
    expect(r).not.toBeNull();
    expect(r.manager).toBe('python');
    expect(r.module_name).toBe('cv2');
    expect(r.adapter).toBe(pythonAdapter);
  });

  it('returns null when registry is empty', () => {
    const r = registry.detect('any output');
    expect(r).toBeNull();
  });

  it('registerAdapter rejects entries without detect()', () => {
    expect(() => registry.registerAdapter('x', {})).toThrow(/detect/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/dep-resolver-registry.test.js`
Expected: FAIL on 3 new tests (stub always returns null from detect).

- [ ] **Step 3: Implement registry dispatch**

Replace `detect` in `server/factory/dep-resolver/registry.js`:

```js
function detect(errorOutput) {
  if (typeof errorOutput !== 'string' || errorOutput.length === 0) return null;
  for (const adapter of adapters.values()) {
    let result;
    try {
      result = adapter.detect(errorOutput);
    } catch (_e) {
      continue;
    }
    if (result && result.detected === true) {
      return { adapter, ...result };
    }
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/dep-resolver-registry.test.js`
Expected: PASS on all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add server/factory/dep-resolver/registry.js server/tests/dep-resolver-registry.test.js
git commit -m "feat(factory): dep-resolver registry dispatch"
```

---

## Task 6: Escalation helper

**Files:**
- Modify: `server/factory/dep-resolver/escalation.js`
- Create: `server/tests/dep-resolver-escalation.test.js`

- [ ] **Step 1: Write the failing tests**

Create `server/tests/dep-resolver-escalation.test.js`:

```js
'use strict';

const path = require('node:path');
const modulePath = path.resolve(__dirname, '../factory/dep-resolver/escalation.js');

describe('escalation.escalate()', () => {
  const savedCache = new Map();

  function installMocks({ submit, await: awaitFn, task }) {
    [
      { path: require.resolve('../factory/internal-task-submit'), exports: { submitFactoryInternalTask: submit } },
      { path: require.resolve('../handlers/workflow/await'), exports: { handleAwaitTask: awaitFn } },
      { path: require.resolve('../db/task-core'), exports: { getTask: task } },
    ].forEach(({ path, exports }) => {
      savedCache.set(path, require.cache[path]);
      require.cache[path] = { id: path, filename: path, loaded: true, exports, children: [], paths: [] };
    });
    delete require.cache[modulePath];
  }

  afterEach(() => {
    for (const [p, cached] of savedCache) {
      if (cached) require.cache[p] = cached;
      else delete require.cache[p];
    }
    savedCache.clear();
    delete require.cache[modulePath];
  });

  const baseArgs = {
    project: { id: 'p', path: '/tmp/p' },
    workItem: { id: 1, title: 't' },
    originalError: 'ModuleNotFoundError: No module named cv2',
    resolverError: 'ERROR: Could not find a version that satisfies the requirement cv2',
    resolverPrompt: 'Add opencv...',
    manifestExcerpt: '[project]\nname="x"',
  };

  it('returns {action:"retry", revisedPrompt} when LLM says retry with a new prompt', async () => {
    installMocks({
      submit: vi.fn().mockResolvedValue({ task_id: 'e1' }),
      await: vi.fn().mockResolvedValue({ status: 'completed' }),
      task: vi.fn().mockReturnValue({
        status: 'completed',
        output: '{"action":"retry","revised_prompt":"Install `opencv-python` not `cv2`","reason":"wrong name"}',
      }),
    });
    const { escalate } = require('../factory/dep-resolver/escalation');
    const r = await escalate(baseArgs);
    expect(r.action).toBe('retry');
    expect(r.revisedPrompt).toContain('opencv-python');
    expect(r.reason).toBe('wrong name');
  });

  it('returns {action:"pause"} when LLM says pause', async () => {
    installMocks({
      submit: vi.fn().mockResolvedValue({ task_id: 'e2' }),
      await: vi.fn().mockResolvedValue({ status: 'completed' }),
      task: vi.fn().mockReturnValue({
        status: 'completed',
        output: '{"action":"pause","revised_prompt":null,"reason":"private registry unreachable"}',
      }),
    });
    const { escalate } = require('../factory/dep-resolver/escalation');
    const r = await escalate(baseArgs);
    expect(r.action).toBe('pause');
    expect(r.reason).toContain('private registry');
  });

  it('fail-opens to pause when submit throws', async () => {
    installMocks({
      submit: vi.fn().mockRejectedValue(new Error('provider down')),
      await: vi.fn(),
      task: vi.fn(),
    });
    const { escalate } = require('../factory/dep-resolver/escalation');
    const r = await escalate(baseArgs);
    expect(r.action).toBe('pause');
    expect(r.reason).toMatch(/escalation_llm_unavailable/);
  });

  it('fail-opens to pause when output is unparseable', async () => {
    installMocks({
      submit: vi.fn().mockResolvedValue({ task_id: 'e3' }),
      await: vi.fn().mockResolvedValue({ status: 'completed' }),
      task: vi.fn().mockReturnValue({ status: 'completed', output: 'not json' }),
    });
    const { escalate } = require('../factory/dep-resolver/escalation');
    const r = await escalate(baseArgs);
    expect(r.action).toBe('pause');
    expect(r.reason).toMatch(/escalation_llm_unavailable/);
  });

  it('fail-opens to pause when action is neither retry nor pause', async () => {
    installMocks({
      submit: vi.fn().mockResolvedValue({ task_id: 'e4' }),
      await: vi.fn().mockResolvedValue({ status: 'completed' }),
      task: vi.fn().mockReturnValue({ status: 'completed', output: '{"action":"maybe","reason":"?"}' }),
    });
    const { escalate } = require('../factory/dep-resolver/escalation');
    const r = await escalate(baseArgs);
    expect(r.action).toBe('pause');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/dep-resolver-escalation.test.js`
Expected: FAIL on 5 new tests (stub always returns pause with reason='escalation stub').

- [ ] **Step 3: Implement escalation**

Replace `server/factory/dep-resolver/escalation.js`:

```js
'use strict';

const ESCALATION_TIMEOUT_MS = 90_000;

async function escalate({ project, workItem, originalError, resolverError, resolverPrompt, manifestExcerpt, timeoutMs = ESCALATION_TIMEOUT_MS }) {
  const { submitFactoryInternalTask } = require('../internal-task-submit');
  const { handleAwaitTask } = require('../../handlers/workflow/await');
  const taskCore = require('../../db/task-core');

  const prompt = buildEscalationPrompt({ originalError, resolverError, resolverPrompt, manifestExcerpt });
  let taskId;
  try {
    const submission = await submitFactoryInternalTask({
      task: prompt,
      working_directory: project?.path || process.cwd(),
      kind: 'reasoning',
      project_id: project?.id,
      work_item_id: workItem?.id,
      timeout_minutes: Math.max(1, Math.floor(timeoutMs / 60_000)),
    });
    taskId = submission?.task_id || null;
  } catch (_e) {
    return { action: 'pause', reason: 'escalation_llm_unavailable: submit_threw' };
  }
  if (!taskId) return { action: 'pause', reason: 'escalation_llm_unavailable: no_task_id' };

  try {
    await handleAwaitTask({ task_id: taskId, timeout_minutes: Math.max(1, Math.floor(timeoutMs / 60_000)), heartbeat_minutes: 0 });
  } catch (_e) {
    return { action: 'pause', reason: 'escalation_llm_unavailable: await_threw' };
  }
  const task = taskCore.getTask(taskId);
  if (!task || task.status !== 'completed') {
    return { action: 'pause', reason: 'escalation_llm_unavailable: task_not_completed' };
  }

  const raw = String(task.output || '').trim();
  if (!raw) return { action: 'pause', reason: 'escalation_llm_unavailable: empty_output' };
  try {
    const jsonMatch = raw.match(/\{[\s\S]*?\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(raw);
    const action = parsed.action === 'retry' ? 'retry' : parsed.action === 'pause' ? 'pause' : null;
    if (!action) return { action: 'pause', reason: 'escalation_llm_unavailable: invalid_action' };
    const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : '';
    if (action === 'retry') {
      const revised = typeof parsed.revised_prompt === 'string' ? parsed.revised_prompt.trim() : '';
      if (!revised) return { action: 'pause', reason: 'escalation_llm_unavailable: retry_without_prompt' };
      return { action: 'retry', revisedPrompt: revised, reason: reason || 'llm_retry' };
    }
    return { action: 'pause', reason: reason || 'llm_pause' };
  } catch (_e) {
    void _e;
    return { action: 'pause', reason: 'escalation_llm_unavailable: unparseable_json' };
  }
}

function buildEscalationPrompt({ originalError, resolverError, resolverPrompt, manifestExcerpt }) {
  return `A software factory tried to resolve a missing dependency but the resolver task failed.

Original verify error:
${(originalError || '').slice(0, 3000)}

Resolver task the factory submitted:
${(resolverPrompt || '').slice(0, 2000)}

Resolver task's error output:
${(resolverError || '').slice(0, 3000)}

Relevant manifest excerpt:
${(manifestExcerpt || '(none)').slice(0, 2000)}

Decide whether the factory should retry resolution with corrected instructions or pause for operator attention.

Return ONLY valid JSON:
{"action":"retry"|"pause","revised_prompt":"<new resolver instructions>"|null,"reason":"<one-sentence diagnostic>"}

- "retry" — you can identify a concrete correction (wrong package name, alternate install command, need uv instead of pip, etc.) that would make the resolver succeed. Provide the revised resolver prompt.
- "pause" — the issue is not resolvable without operator context (private registry, genuine version conflict, environment mismatch).
`;
}

module.exports = { escalate, ESCALATION_TIMEOUT_MS };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/dep-resolver-escalation.test.js`
Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add server/factory/dep-resolver/escalation.js server/tests/dep-resolver-escalation.test.js
git commit -m "feat(factory): dep-resolver escalation helper"
```

---

## Task 7: Main `resolve()` orchestrator

**Files:**
- Modify: `server/factory/dep-resolver/index.js`
- Create: `server/tests/dep-resolver-orchestrator.test.js`

**Context:** `resolve()` is the single entry point executeVerifyStage calls. It takes the classification from verify-review plus worktree/project/workItem context, submits the Codex resolver task via `submitFactoryInternalTask({ kind: 'targeted_file_edit' })`, awaits completion, runs `adapter.validateManifestUpdate`, and returns a structured outcome so the caller can decide to re-verify, escalate, or pause.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/dep-resolver-orchestrator.test.js`:

```js
'use strict';

const path = require('node:path');
const modulePath = path.resolve(__dirname, '../factory/dep-resolver/index.js');

describe('dep-resolver resolve()', () => {
  const savedCache = new Map();

  function installMocks({ submit, await: awaitFn, task }) {
    [
      { path: require.resolve('../factory/internal-task-submit'), exports: { submitFactoryInternalTask: submit } },
      { path: require.resolve('../handlers/workflow/await'), exports: { handleAwaitTask: awaitFn } },
      { path: require.resolve('../db/task-core'), exports: { getTask: task } },
    ].forEach(({ path, exports }) => {
      savedCache.set(path, require.cache[path]);
      require.cache[path] = { id: path, filename: path, loaded: true, exports, children: [], paths: [] };
    });
    delete require.cache[modulePath];
  }

  afterEach(() => {
    for (const [p, cached] of savedCache) {
      if (cached) require.cache[p] = cached;
      else delete require.cache[p];
    }
    savedCache.clear();
    delete require.cache[modulePath];
  });

  const baseArgs = () => ({
    classification: {
      classification: 'missing_dep',
      manager: 'python',
      package_name: 'opencv-python',
      module_name: 'cv2',
    },
    project: { id: 'p', path: '/tmp/p' },
    worktree: { path: '/tmp/p/.worktrees/feat-factory-79' },
    workItem: { id: 79, title: 'Add scoring' },
    instance: { id: 'i1', batch_id: 'b1' },
    adapter: {
      manager: 'python',
      buildResolverPrompt: () => 'Install opencv-python and commit.',
      validateManifestUpdate: () => ({ valid: true, manifest: 'pyproject.toml' }),
    },
    options: {},
  });

  it('returns outcome=resolved when resolver task completes and validation passes', async () => {
    installMocks({
      submit: vi.fn().mockResolvedValue({ task_id: 'r1' }),
      await: vi.fn().mockResolvedValue({ status: 'completed' }),
      task: vi.fn().mockReturnValue({ status: 'completed', output: 'done' }),
    });
    const { resolve } = require('../factory/dep-resolver/index');
    const r = await resolve(baseArgs());
    expect(r.outcome).toBe('resolved');
    expect(r.reverifyNeeded).toBe(true);
    expect(r.taskId).toBe('r1');
    expect(r.package).toBe('opencv-python');
  });

  it('returns outcome=resolver_task_failed when submit throws', async () => {
    installMocks({
      submit: vi.fn().mockRejectedValue(new Error('boom')),
      await: vi.fn(),
      task: vi.fn(),
    });
    const { resolve } = require('../factory/dep-resolver/index');
    const r = await resolve(baseArgs());
    expect(r.outcome).toBe('resolver_task_failed');
    expect(r.reverifyNeeded).toBe(false);
    expect(r.reason).toMatch(/submit_threw/);
  });

  it('returns outcome=validation_failed when validator rejects the commit', async () => {
    installMocks({
      submit: vi.fn().mockResolvedValue({ task_id: 'r2' }),
      await: vi.fn().mockResolvedValue({ status: 'completed' }),
      task: vi.fn().mockReturnValue({ status: 'completed', output: 'done' }),
    });
    const args = baseArgs();
    args.adapter.validateManifestUpdate = () => ({ valid: false, reason: 'not found in any manifest' });
    const { resolve } = require('../factory/dep-resolver/index');
    const r = await resolve(args);
    expect(r.outcome).toBe('validation_failed');
    expect(r.reason).toContain('not found');
  });

  it('returns outcome=resolver_task_failed when task completed but status!=completed', async () => {
    installMocks({
      submit: vi.fn().mockResolvedValue({ task_id: 'r3' }),
      await: vi.fn().mockResolvedValue({ status: 'timeout' }),
      task: vi.fn().mockReturnValue({ status: 'failed', output: 'pip: could not resolve' }),
    });
    const { resolve } = require('../factory/dep-resolver/index');
    const r = await resolve(baseArgs());
    expect(r.outcome).toBe('resolver_task_failed');
    expect(r.reason).toMatch(/status/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/dep-resolver-orchestrator.test.js`
Expected: FAIL on 4 tests (stub returns `{outcome: 'unhandled'}`).

- [ ] **Step 3: Implement `resolve()`**

Replace `server/factory/dep-resolver/index.js`:

```js
'use strict';

const RESOLVER_TIMEOUT_MS = 10 * 60 * 1000;

async function resolve({ classification, project, worktree, workItem, instance, adapter, options = {} }) {
  if (!classification || classification.classification !== 'missing_dep') {
    return { outcome: 'unhandled', reverifyNeeded: false, reason: 'not_a_missing_dep_classification' };
  }
  if (!adapter || typeof adapter.buildResolverPrompt !== 'function' || typeof adapter.validateManifestUpdate !== 'function') {
    return { outcome: 'unhandled', reverifyNeeded: false, reason: 'adapter_missing_required_methods' };
  }

  const { submitFactoryInternalTask } = require('../internal-task-submit');
  const { handleAwaitTask } = require('../../handlers/workflow/await');
  const taskCore = require('../../db/task-core');

  const prompt = options.revisedPrompt && options.revisedPrompt.trim().length > 0
    ? options.revisedPrompt
    : adapter.buildResolverPrompt({
        package_name: classification.package_name,
        project,
        worktree,
        workItem,
        error_output: classification.error_output || '',
      });

  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : RESOLVER_TIMEOUT_MS;

  const tags = [
    `factory:work_item_id=${workItem?.id || ''}`,
    `factory:batch_id=${instance?.batch_id || ''}`,
    `factory:dep_resolve=${classification.package_name}`,
    'factory:dep_resolve=true',
  ];

  let taskId;
  try {
    const submission = await submitFactoryInternalTask({
      task: prompt,
      working_directory: worktree?.path || project?.path || process.cwd(),
      kind: 'targeted_file_edit',
      project_id: project?.id,
      work_item_id: workItem?.id,
      timeout_minutes: Math.max(1, Math.floor(timeoutMs / 60_000)),
      tags,
    });
    taskId = submission?.task_id || null;
  } catch (err) {
    return {
      outcome: 'resolver_task_failed',
      reverifyNeeded: false,
      reason: `submit_threw: ${err?.message || err}`,
      package: classification.package_name,
      manager: classification.manager,
    };
  }
  if (!taskId) {
    return {
      outcome: 'resolver_task_failed',
      reverifyNeeded: false,
      reason: 'no_task_id',
      package: classification.package_name,
      manager: classification.manager,
    };
  }

  try {
    await handleAwaitTask({ task_id: taskId, timeout_minutes: Math.max(1, Math.floor(timeoutMs / 60_000)), heartbeat_minutes: 0 });
  } catch (err) {
    return {
      outcome: 'resolver_task_failed',
      reverifyNeeded: false,
      reason: `await_threw: ${err?.message || err}`,
      taskId,
      package: classification.package_name,
      manager: classification.manager,
    };
  }
  const task = taskCore.getTask(taskId);
  if (!task || task.status !== 'completed') {
    return {
      outcome: 'resolver_task_failed',
      reverifyNeeded: false,
      reason: `task_status=${task?.status || 'missing'}`,
      taskId,
      resolverError: task?.output || '',
      package: classification.package_name,
      manager: classification.manager,
    };
  }

  let validation;
  try {
    validation = await adapter.validateManifestUpdate(worktree?.path || project?.path, classification.package_name);
  } catch (err) {
    validation = { valid: false, reason: `validate_threw: ${err?.message || err}` };
  }
  if (!validation || !validation.valid) {
    return {
      outcome: 'validation_failed',
      reverifyNeeded: false,
      reason: validation?.reason || 'validation_rejected',
      taskId,
      package: classification.package_name,
      manager: classification.manager,
    };
  }

  return {
    outcome: 'resolved',
    reverifyNeeded: true,
    taskId,
    package: classification.package_name,
    manager: classification.manager,
    manifest: validation.manifest || null,
  };
}

module.exports = { resolve, RESOLVER_TIMEOUT_MS };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/dep-resolver-orchestrator.test.js`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add server/factory/dep-resolver/index.js server/tests/dep-resolver-orchestrator.test.js
git commit -m "feat(factory): dep-resolver orchestrator"
```

---

## Task 8: Extend verify-review with `missing_dep` classification

**Files:**
- Modify: `server/factory/verify-review.js` (`reviewVerifyFailure`)
- Modify: `server/tests/verify-review.test.js`

**Context:** After env-failure detection (existing) and before intersection analysis (existing), call the dep-resolver registry. If an adapter detects a miss, call `adapter.mapModuleToPackage` to resolve module→package. If confidence is high/medium, return `{classification: 'missing_dep', manager, package_name, ...}`. Otherwise fall through to existing logic.

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/verify-review.test.js`:

```js
const depRegistryPath = require.resolve('../factory/dep-resolver/registry');
const pythonAdapterPath = require.resolve('../factory/dep-resolver/adapters/python');

describe('reviewVerifyFailure — missing_dep classification', () => {
  const savedCache = new Map();

  function installAdapterMocks({ detectResult, mapResult }) {
    const stubRegistry = {
      detect: vi.fn().mockReturnValue(detectResult),
      clearAdaptersForTests: vi.fn(),
      registerAdapter: vi.fn(),
      getAdapter: vi.fn(),
      listManagers: vi.fn().mockReturnValue([]),
    };
    const stubAdapter = {
      manager: detectResult?.manager || 'python',
      mapModuleToPackage: vi.fn().mockResolvedValue(mapResult),
    };
    if (detectResult?.detected) {
      stubRegistry.detect.mockReturnValue({ adapter: stubAdapter, ...detectResult });
    }
    [
      { path: depRegistryPath, exports: stubRegistry },
      { path: pythonAdapterPath, exports: { createPythonAdapter: () => stubAdapter } },
    ].forEach(({ path, exports }) => {
      savedCache.set(path, require.cache[path]);
      require.cache[path] = { id: path, filename: path, loaded: true, exports, children: [], paths: [] };
    });
    delete require.cache[require.resolve('../factory/verify-review')];
    return { stubRegistry, stubAdapter };
  }

  afterEach(() => {
    for (const [p, cached] of savedCache) {
      if (cached) require.cache[p] = cached;
      else delete require.cache[p];
    }
    savedCache.clear();
    delete require.cache[require.resolve('../factory/verify-review')];
  });

  it('returns missing_dep when adapter detects + LLM maps with high confidence', async () => {
    installAdapterMocks({
      detectResult: { detected: true, manager: 'python', module_name: 'cv2', signals: ['ModuleNotFoundError'] },
      mapResult: { package_name: 'opencv-python', confidence: 'high' },
    });
    const { reviewVerifyFailure } = require('../factory/verify-review');
    const r = await reviewVerifyFailure({
      verifyOutput: { exitCode: 1, stdout: "ModuleNotFoundError: No module named 'cv2'", stderr: '', timedOut: false },
      workingDirectory: '/tmp/p',
      worktreeBranch: 'feat/x',
      mergeBase: 'main',
      workItem: { id: 1, title: 'w', description: 'd' },
      project: { id: 'p', path: '/tmp/p' },
    });
    expect(r.classification).toBe('missing_dep');
    expect(r.manager).toBe('python');
    expect(r.package_name).toBe('opencv-python');
    expect(r.module_name).toBe('cv2');
  });

  it('falls through to existing classification when detection fires but LLM confidence is low', async () => {
    installAdapterMocks({
      detectResult: { detected: true, manager: 'python', module_name: 'weird', signals: ['ModuleNotFoundError'] },
      mapResult: { package_name: null, confidence: 'low' },
    });
    const { reviewVerifyFailure } = require('../factory/verify-review');
    const r = await reviewVerifyFailure({
      verifyOutput: { exitCode: 1, stdout: "ModuleNotFoundError: No module named 'weird'", stderr: '', timedOut: false },
      workingDirectory: '/tmp/p',
      worktreeBranch: 'feat/x',
      mergeBase: 'main',
      workItem: { id: 1, title: 'w' },
      project: { id: 'p', path: '/tmp/p' },
    });
    expect(r.classification).not.toBe('missing_dep');
  });

  it('falls through to existing classification when no adapter detects', async () => {
    installAdapterMocks({
      detectResult: null,
      mapResult: null,
    });
    const { reviewVerifyFailure } = require('../factory/verify-review');
    const r = await reviewVerifyFailure({
      verifyOutput: { exitCode: 1, stdout: 'FAILED tests/foo.py::test_bar', stderr: '', timedOut: false },
      workingDirectory: '/tmp/p',
      worktreeBranch: 'feat/x',
      mergeBase: 'main',
      workItem: { id: 1, title: 'w' },
      project: { id: 'p', path: '/tmp/p' },
    });
    expect(r.classification).not.toBe('missing_dep');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/verify-review.test.js`
Expected: FAIL on 3 new tests.

- [ ] **Step 3: Wire the missing_dep branch into reviewVerifyFailure**

In `server/factory/verify-review.js`, inside `reviewVerifyFailure` after the `detectEnvironmentFailure` early return and before the `parseFailingTests` call, insert:

```js
  // Missing-dependency classification: adapters detect common patterns
  // (ModuleNotFoundError, Cannot find module, etc.), LLM maps module→package.
  try {
    const combined = String(verifyOutput?.stdout || '') + '\n' + String(verifyOutput?.stderr || '');
    const registry = require('./dep-resolver/registry');
    const hit = registry.detect(combined);
    if (hit && hit.adapter && typeof hit.adapter.mapModuleToPackage === 'function') {
      const mapping = await hit.adapter.mapModuleToPackage({
        module_name: hit.module_name,
        error_output: combined,
        manifest_excerpt: '',
        project,
        workItem,
      });
      if (mapping && mapping.package_name && (mapping.confidence === 'high' || mapping.confidence === 'medium')) {
        return {
          classification: 'missing_dep',
          confidence: mapping.confidence,
          manager: hit.manager,
          module_name: hit.module_name,
          package_name: mapping.package_name,
          error_output: combined,
          modifiedFiles: [],
          failingTests: [],
          intersection: [],
          environmentSignals: [],
          llmVerdict: null,
          llmCritique: null,
          suggestedRejectReason: null,
        };
      }
    }
  } catch (_depErr) {
    // dep-resolver failures must not block the existing classifier path
    void _depErr;
  }
```

Also ensure the Python adapter is registered on first require. At the top of `server/factory/verify-review.js`, add:

```js
// Register built-in dep-resolver adapters on module load. Idempotent —
// the registry holds a Map keyed by manager name.
(function registerBuiltinDepAdapters() {
  try {
    const registry = require('./dep-resolver/registry');
    const { createPythonAdapter } = require('./dep-resolver/adapters/python');
    if (!registry.getAdapter('python')) {
      registry.registerAdapter('python', createPythonAdapter());
    }
  } catch (_e) { void _e; }
})();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/verify-review.test.js`
Expected: PASS on all tests in the file (existing 30 + 3 new = 33).

- [ ] **Step 5: Commit**

```bash
git add server/factory/verify-review.js server/tests/verify-review.test.js
git commit -m "feat(factory): verify-review missing_dep classification path"
```

---

## Task 9: executeVerifyStage wiring — resolver invocation + cascade counter

**Files:**
- Modify: `server/factory/loop-controller.js` (around line 4742 where `verifyReview.reviewVerifyFailure` is called inside `executeVerifyStage`)

**Context:** After the classifier returns, if `review.classification === 'missing_dep'`, call `depResolver.resolve()`. On `outcome: 'resolved'` → increment cascade counter, check cap, loop back into the verify-retry path so the next iteration re-runs `worktreeRunner.verify()`. On `outcome: 'resolver_task_failed'` or `'validation_failed'` → call `escalation.escalate()`. On escalation retry → call `resolve()` once more with `options.revisedPrompt`; a second failure pauses. On escalation pause → update project config_json, pause.

The existing classifier integration at line 4742 currently branches on `baseline_broken` / `environment_failure` (pause) and `task_caused` / `ambiguous` (fall through to retry). We add a new branch BEFORE those, matching `missing_dep`.

- [ ] **Step 1: Write the failing tests (deferred to Task 11 integration tests — skip this step)**

Unit-testing this integration in isolation requires mocking too much of loop-controller. The real validation is Task 11's 7-scenario e2e suite. Mark this step complete and proceed.

- [ ] **Step 2: Implement the wiring in `executeVerifyStage`**

In `server/factory/loop-controller.js`, find the block around line 4742 (`review = await verifyReview.reviewVerifyFailure({ ... })`). After the classifier returns and BEFORE the existing `if (review && review.classification === 'baseline_broken' || ...)` branch, insert:

```js
        // missing_dep branch: submit a Codex resolver task, await, re-verify.
        // Cap cascade at 3 per batch. On resolver failure, escalate once; on
        // escalation pause, treat as baseline_broken and pause the project.
        if (review && review.classification === 'missing_dep') {
          const depResolver = require('./dep-resolver/index');
          const escalationHelper = require('./dep-resolver/escalation');
          const registry = require('./dep-resolver/registry');
          const adapter = registry.getAdapter(review.manager);
          if (!adapter) {
            // Manager disappeared between classify and resolve; fall through
            // as ambiguous so the normal retry path can try.
            safeLogDecision({
              project_id,
              stage: LOOP_STATES.VERIFY,
              action: 'dep_resolver_no_adapter',
              reasoning: `Missing dep detected (manager=${review.manager}) but no adapter is registered; falling through to retry.`,
              outcome: { work_item_id: instance?.work_item_id || null, manager: review.manager },
              confidence: 1,
              batch_id,
            });
          } else {
            // Check cascade cap + kill switch.
            const currentProject = factoryHealth.getProject(project_id);
            const cfg = currentProject?.config_json ? JSON.parse(currentProject.config_json) : {};
            const enabled = cfg?.dep_resolver?.enabled !== false; // default on
            const cap = Number.isFinite(cfg?.dep_resolver?.cascade_cap) ? cfg.dep_resolver.cascade_cap : 3;
            const count = Number.isFinite(cfg?.dep_resolve_cycle_count) ? cfg.dep_resolve_cycle_count : 0;

            if (!enabled) {
              safeLogDecision({
                project_id,
                stage: LOOP_STATES.VERIFY,
                action: 'dep_resolver_disabled',
                reasoning: 'Missing dep detected but dep_resolver.enabled=false; falling through to existing retry.',
                outcome: { work_item_id: instance?.work_item_id || null, package: review.package_name },
                confidence: 1,
                batch_id,
              });
            } else if (count >= cap) {
              // Cascade exhausted — pause as baseline_broken.
              factoryIntake.updateWorkItem(instance.work_item_id, {
                status: 'rejected',
                reject_reason: `dep_cascade_exhausted: ${count} resolutions attempted, next missing dep is ${review.package_name}`,
              });
              cfg.baseline_broken_since = new Date().toISOString();
              cfg.baseline_broken_reason = 'dep_cascade_exhausted';
              cfg.baseline_broken_evidence = { last_package: review.package_name, cycle_count: count };
              cfg.baseline_broken_probe_attempts = 0;
              cfg.baseline_broken_tick_count = 0;
              factoryHealth.updateProject(project_id, { status: 'paused', config_json: JSON.stringify(cfg) });
              safeLogDecision({
                project_id,
                stage: LOOP_STATES.VERIFY,
                action: 'dep_resolver_cascade_exhausted',
                reasoning: `Reached ${count} dep resolutions this batch; pausing project.`,
                outcome: { work_item_id: instance?.work_item_id || null, package: review.package_name, cycle_count: count },
                confidence: 1,
                batch_id,
              });
              return { status: 'rejected', reason: 'dep_cascade_exhausted' };
            } else {
              // Run the resolver.
              safeLogDecision({
                project_id,
                stage: LOOP_STATES.VERIFY,
                action: 'dep_resolver_detected',
                reasoning: `Missing dep detected: ${review.package_name} (manager=${review.manager})`,
                outcome: { work_item_id: instance?.work_item_id || null, manager: review.manager, package: review.package_name, module: review.module_name },
                confidence: 1,
                batch_id,
              });

              let resolveResult = await depResolver.resolve({
                classification: review,
                project,
                worktree: worktreeRecord,
                workItem: instance?.work_item_id ? factoryIntake.getWorkItem(instance.work_item_id) : null,
                instance,
                adapter,
                options: {},
              });

              safeLogDecision({
                project_id,
                stage: LOOP_STATES.VERIFY,
                action: resolveResult.outcome === 'resolved' ? 'dep_resolver_task_completed' : 'dep_resolver_validation_failed',
                reasoning: `Resolver outcome: ${resolveResult.outcome} (${resolveResult.reason || 'ok'})`,
                outcome: { work_item_id: instance?.work_item_id || null, ...resolveResult },
                confidence: 1,
                batch_id,
              });

              // On resolver failure, escalate once.
              if (resolveResult.outcome !== 'resolved') {
                const escalationResult = await escalationHelper.escalate({
                  project,
                  workItem: instance?.work_item_id ? factoryIntake.getWorkItem(instance.work_item_id) : null,
                  originalError: review.error_output || '',
                  resolverError: resolveResult.resolverError || resolveResult.reason || '',
                  resolverPrompt: adapter.buildResolverPrompt({
                    package_name: review.package_name,
                    project,
                    worktree: worktreeRecord,
                    workItem: instance?.work_item_id ? factoryIntake.getWorkItem(instance.work_item_id) : null,
                    error_output: review.error_output || '',
                  }),
                  manifestExcerpt: '',
                });
                safeLogDecision({
                  project_id,
                  stage: LOOP_STATES.VERIFY,
                  action: 'dep_resolver_escalated',
                  reasoning: `Escalation verdict: ${escalationResult.action} (${escalationResult.reason})`,
                  outcome: { work_item_id: instance?.work_item_id || null, ...escalationResult },
                  confidence: 1,
                  batch_id,
                });
                if (escalationResult.action === 'retry') {
                  resolveResult = await depResolver.resolve({
                    classification: review,
                    project,
                    worktree: worktreeRecord,
                    workItem: instance?.work_item_id ? factoryIntake.getWorkItem(instance.work_item_id) : null,
                    instance,
                    adapter,
                    options: { revisedPrompt: escalationResult.revisedPrompt },
                  });
                  safeLogDecision({
                    project_id,
                    stage: LOOP_STATES.VERIFY,
                    action: 'dep_resolver_escalation_retry',
                    reasoning: `Retry resolver outcome: ${resolveResult.outcome} (${resolveResult.reason || 'ok'})`,
                    outcome: { work_item_id: instance?.work_item_id || null, ...resolveResult },
                    confidence: 1,
                    batch_id,
                  });
                }
                // If still not resolved (either escalation pause or retry failed), pause project.
                if (resolveResult.outcome !== 'resolved') {
                  factoryIntake.updateWorkItem(instance.work_item_id, {
                    status: 'rejected',
                    reject_reason: `dep_resolver_unresolvable: ${escalationResult.reason || resolveResult.reason || 'unknown'}`,
                  });
                  cfg.baseline_broken_since = new Date().toISOString();
                  cfg.baseline_broken_reason = 'dep_resolver_unresolvable';
                  cfg.baseline_broken_evidence = { package: review.package_name, escalation_reason: escalationResult.reason, resolver_reason: resolveResult.reason };
                  cfg.baseline_broken_probe_attempts = 0;
                  cfg.baseline_broken_tick_count = 0;
                  factoryHealth.updateProject(project_id, { status: 'paused', config_json: JSON.stringify(cfg) });
                  safeLogDecision({
                    project_id,
                    stage: LOOP_STATES.VERIFY,
                    action: 'dep_resolver_escalation_pause',
                    reasoning: `Pausing project: ${escalationResult.reason || resolveResult.reason}`,
                    outcome: { work_item_id: instance?.work_item_id || null, package: review.package_name, escalation: escalationResult, resolver: resolveResult },
                    confidence: 1,
                    batch_id,
                  });
                  return { status: 'rejected', reason: 'dep_resolver_unresolvable' };
                }
              }

              // Success path: bump counter, mark for re-verify. Continue
              // the outer verify while-loop.
              cfg.dep_resolve_cycle_count = count + 1;
              if (!Array.isArray(cfg.dep_resolve_history)) cfg.dep_resolve_history = [];
              cfg.dep_resolve_history.push({
                ts: new Date().toISOString(),
                batch_id,
                package: review.package_name,
                manager: review.manager,
                outcome: 'resolved',
                task_id: resolveResult.taskId || null,
              });
              // Cap history at 20 entries
              if (cfg.dep_resolve_history.length > 20) cfg.dep_resolve_history = cfg.dep_resolve_history.slice(-20);
              factoryHealth.updateProject(project_id, { config_json: JSON.stringify(cfg) });

              safeLogDecision({
                project_id,
                stage: LOOP_STATES.VERIFY,
                action: 'dep_resolver_reverify_passed',
                reasoning: `Dep ${review.package_name} resolved; re-running verify (cycle ${count + 1}/${cap}).`,
                outcome: { work_item_id: instance?.work_item_id || null, package: review.package_name, cycle_count: count + 1 },
                confidence: 1,
                batch_id,
              });

              // Clear `review` so the next loop iteration re-enters the
              // classifier on the fresh verify output.
              review = null;
              continue;
            }
          }
        }
```

Note the `continue;` at the end of the success path — this re-enters the `while (true)` verify-retry loop so the next `worktreeRunner.verify({...})` call picks up the committed manifest change.

Also, BEFORE the verify while-loop (alongside the existing `let review = null;`), reset the cycle counter at the start of a fresh verify stage:

```js
    // Reset the cascade counter when EXECUTE transitions into VERIFY for a
    // fresh batch. Persisting the counter across stages lets consecutive
    // missing_dep cycles within ONE verify stage add up, without leaking
    // into the next batch.
    try {
      const freshProject = factoryHealth.getProject(project_id);
      const freshCfg = freshProject?.config_json ? JSON.parse(freshProject.config_json) : {};
      if (freshCfg.dep_resolve_cycle_count) {
        freshCfg.dep_resolve_cycle_count = 0;
        factoryHealth.updateProject(project_id, { config_json: JSON.stringify(freshCfg) });
      }
    } catch (_e) { void _e; }
```

- [ ] **Step 3: Quick sanity run of existing verify-review tests**

Run: `cd server && npx vitest run tests/verify-review.test.js tests/factory-verify-review-integration.test.js`
Expected: all passing (we haven't broken existing classification paths).

- [ ] **Step 4: Commit**

```bash
git add server/factory/loop-controller.js
git commit -m "feat(factory): wire dep-resolver into executeVerifyStage"
```

---

## Task 10: Trust-level gating (pending_approval on supervised/guided)

**Files:**
- Modify: `server/factory/loop-controller.js` (inside the `missing_dep` branch added in Task 9)

**Context:** When `project.trust_level` is `supervised` or `guided`, the resolver must NOT auto-submit — it emits a `pending_approval` decision and returns a pause status that the operator resolves via the existing gate flow (`approve_factory_gate` / `reject_factory_gate`). Matches how other supervised-trust actions gate.

- [ ] **Step 1: Add the trust check at the top of the `missing_dep` branch**

In the `missing_dep` branch added in Task 9, BEFORE the `// Check cascade cap + kill switch.` block, insert:

```js
            const gatedTrust = project.trust_level === 'supervised' || project.trust_level === 'guided';
            if (gatedTrust) {
              safeLogDecision({
                project_id,
                stage: LOOP_STATES.VERIFY,
                action: 'dep_resolver_pending_approval',
                reasoning: `Missing dep ${review.package_name} (${review.manager}) detected. Trust level ${project.trust_level} requires operator approval before installing.`,
                outcome: {
                  work_item_id: instance?.work_item_id || null,
                  manager: review.manager,
                  package: review.package_name,
                  proposed_action: 'dep_resolve',
                },
                confidence: 1,
                batch_id,
              });
              return {
                status: 'paused',
                reason: 'dep_resolver_pending_approval',
                next_state: LOOP_STATES.PAUSED,
                paused_at_stage: LOOP_STATES.VERIFY,
              };
            }
```

- [ ] **Step 2: Quick sanity run**

Run: `cd server && npx vitest run tests/verify-review.test.js tests/factory-verify-review-integration.test.js`
Expected: all passing.

- [ ] **Step 3: Commit**

```bash
git add server/factory/loop-controller.js
git commit -m "feat(factory): dep-resolver trust-level gating"
```

---

## Task 11: Integration e2e tests (7 scenarios)

**Files:**
- Create: `server/tests/factory-dep-resolver-integration.test.js`

**Context:** Seven end-to-end scenarios driving `executeVerifyStage` through the resolver paths. Uses the same DB-seed harness pattern as `factory-verify-review-integration.test.js`: `setupTestDb` + inject mocks via `vi.spyOn` on the resolver + escalation + verify runners.

- [ ] **Step 1: Write the e2e test file**

Create `server/tests/factory-dep-resolver-integration.test.js`:

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setupTestDb, teardownTestDb } = require('./vitest-setup');

function seedProjectItemAndWorktree(db, { trust = 'autonomous', cfgOverrides = {} } = {}) {
  const tempPath = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-e2e-'));
  const projectId = 'proj-dep-e2e';
  const cfg = { verify_command: 'python -m pytest tests/', ...cfgOverrides };
  db.prepare(`INSERT INTO factory_projects (id, name, path, trust_level, status, config_json, created_at, updated_at)
              VALUES (?, 'DepE2E', ?, ?, 'running', ?, datetime('now'), datetime('now'))`)
    .run(projectId, tempPath, trust, JSON.stringify(cfg));
  const { lastInsertRowid: workItemId } = db.prepare(
    `INSERT INTO factory_work_items (project_id, source, title, description, priority, status, origin_json, created_at, updated_at)
     VALUES (?, 'architect', 'dep item', 'd', 50, 'executing', ?, datetime('now'), datetime('now'))`
  ).run(projectId, JSON.stringify({ plan_path: path.join(tempPath, 'plan.md') }));
  const batchId = `factory-${projectId}-${workItemId}`;
  db.prepare(
    `INSERT INTO factory_worktrees (project_id, work_item_id, batch_id, branch, base_branch, worktree_path, vc_worktree_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'main', ?, 'vcid1', 'active', datetime('now'), datetime('now'))`
  ).run(projectId, workItemId, batchId, `feat/factory-${workItemId}`, path.join(tempPath, '.worktrees', 'feat-dep'));
  return { projectId, workItemId, batchId, tempPath };
}

describe('executeVerifyStage + dep-resolver integration', () => {
  let db;
  beforeEach(() => { ({ db } = setupTestDb('dep-resolver-e2e')); });
  afterEach(() => { teardownTestDb(); vi.restoreAllMocks(); });

  function mockResolverAndVerify({ verifyOutputs, resolveOutputs = [], escalateOutput = null, reviewOutputs }) {
    const loopController = require('../factory/loop-controller');
    const verifyReview = require('../factory/verify-review');
    const depResolver = require('../factory/dep-resolver/index');
    const escalation = require('../factory/dep-resolver/escalation');

    const verify = vi.fn();
    for (const out of verifyOutputs) verify.mockResolvedValueOnce(out);
    vi.spyOn(loopController, 'setWorktreeRunnerForTests').mockImplementation(() => {});
    if (typeof loopController.setWorktreeRunnerForTests === 'function') {
      loopController.setWorktreeRunnerForTests({ verify });
    }

    const reviewSpy = vi.spyOn(verifyReview, 'reviewVerifyFailure');
    for (const r of reviewOutputs) reviewSpy.mockResolvedValueOnce(r);

    const resolveSpy = vi.spyOn(depResolver, 'resolve');
    for (const r of resolveOutputs) resolveSpy.mockResolvedValueOnce(r);

    let escalateSpy = null;
    if (escalateOutput) {
      escalateSpy = vi.spyOn(escalation, 'escalate').mockResolvedValue(escalateOutput);
    }

    return { verify, reviewSpy, resolveSpy, escalateSpy };
  }

  it('Scenario 1 (happy path): resolved then re-verify passes', async () => {
    const loopController = require('../factory/loop-controller');
    const { projectId, workItemId, batchId } = seedProjectItemAndWorktree(db);
    mockResolverAndVerify({
      verifyOutputs: [
        { passed: false, exitCode: 1, stdout: "ModuleNotFoundError: No module named 'cv2'", stderr: '', output: '...', durationMs: 100, timedOut: false },
        { passed: true, exitCode: 0, stdout: 'PASS', stderr: '', output: 'PASS', durationMs: 50, timedOut: false },
      ],
      reviewOutputs: [
        { classification: 'missing_dep', manager: 'python', package_name: 'opencv-python', module_name: 'cv2', error_output: "ModuleNotFoundError: No module named 'cv2'" },
      ],
      resolveOutputs: [
        { outcome: 'resolved', reverifyNeeded: true, taskId: 'r1', package: 'opencv-python', manager: 'python', manifest: 'pyproject.toml' },
      ],
    });
    const r = await loopController.executeVerifyStage(projectId, batchId, { id: 'inst-1', project_id: projectId, batch_id: batchId, work_item_id: workItemId });
    expect(r.status).toBe('passed');
    const project = db.prepare('SELECT status, config_json FROM factory_projects WHERE id = ?').get(projectId);
    expect(project.status).toBe('running');
    const cfg = JSON.parse(project.config_json);
    expect(cfg.dep_resolve_history).toHaveLength(1);
    expect(cfg.dep_resolve_history[0].package).toBe('opencv-python');
  });

  it('Scenario 2 (cascade cap): 3 resolves, 4th missing_dep → pause', async () => {
    const loopController = require('../factory/loop-controller');
    const { projectId, workItemId, batchId } = seedProjectItemAndWorktree(db, { cfgOverrides: { verify_command: 'x' } });
    const fail = (pkg) => ({ passed: false, exitCode: 1, stdout: `ModuleNotFoundError: No module named '${pkg}'`, stderr: '', output: '', durationMs: 1, timedOut: false });
    const rev = (pkg) => ({ classification: 'missing_dep', manager: 'python', package_name: pkg + '-pkg', module_name: pkg, error_output: '' });
    mockResolverAndVerify({
      verifyOutputs: [fail('a'), fail('b'), fail('c'), fail('d')],
      reviewOutputs: [rev('a'), rev('b'), rev('c'), rev('d')],
      resolveOutputs: [
        { outcome: 'resolved', reverifyNeeded: true, taskId: 'r1', package: 'a-pkg', manager: 'python' },
        { outcome: 'resolved', reverifyNeeded: true, taskId: 'r2', package: 'b-pkg', manager: 'python' },
        { outcome: 'resolved', reverifyNeeded: true, taskId: 'r3', package: 'c-pkg', manager: 'python' },
      ],
    });
    const r = await loopController.executeVerifyStage(projectId, batchId, { id: 'inst-2', project_id: projectId, batch_id: batchId, work_item_id: workItemId });
    expect(r.status).toBe('rejected');
    expect(r.reason).toBe('dep_cascade_exhausted');
    const project = db.prepare('SELECT status, config_json FROM factory_projects WHERE id = ?').get(projectId);
    expect(project.status).toBe('paused');
    const cfg = JSON.parse(project.config_json);
    expect(cfg.baseline_broken_reason).toBe('dep_cascade_exhausted');
  });

  it('Scenario 3 (resolver fails → escalation retry → pass)', async () => {
    const loopController = require('../factory/loop-controller');
    const { projectId, workItemId, batchId } = seedProjectItemAndWorktree(db);
    mockResolverAndVerify({
      verifyOutputs: [
        { passed: false, exitCode: 1, stdout: "ModuleNotFoundError: No module named 'sklearn'", stderr: '', output: '', durationMs: 1, timedOut: false },
        { passed: true, exitCode: 0, stdout: 'PASS', stderr: '', output: '', durationMs: 50, timedOut: false },
      ],
      reviewOutputs: [
        { classification: 'missing_dep', manager: 'python', package_name: 'sklearn-wrong', module_name: 'sklearn', error_output: '' },
      ],
      resolveOutputs: [
        { outcome: 'resolver_task_failed', reverifyNeeded: false, reason: 'could not find package sklearn-wrong on PyPI' },
        { outcome: 'resolved', reverifyNeeded: true, taskId: 'r-retry', package: 'scikit-learn', manager: 'python' },
      ],
      escalateOutput: { action: 'retry', revisedPrompt: 'Install scikit-learn (not sklearn)', reason: 'correct_package_name' },
    });
    const r = await loopController.executeVerifyStage(projectId, batchId, { id: 'inst-3', project_id: projectId, batch_id: batchId, work_item_id: workItemId });
    expect(r.status).toBe('passed');
  });

  it('Scenario 4 (resolver fails → escalation pause)', async () => {
    const loopController = require('../factory/loop-controller');
    const { projectId, workItemId, batchId } = seedProjectItemAndWorktree(db);
    mockResolverAndVerify({
      verifyOutputs: [
        { passed: false, exitCode: 1, stdout: "ModuleNotFoundError: No module named 'internal_lib'", stderr: '', output: '', durationMs: 1, timedOut: false },
      ],
      reviewOutputs: [
        { classification: 'missing_dep', manager: 'python', package_name: 'internal-lib', module_name: 'internal_lib', error_output: '' },
      ],
      resolveOutputs: [
        { outcome: 'resolver_task_failed', reverifyNeeded: false, reason: '404 on PyPI' },
      ],
      escalateOutput: { action: 'pause', reason: 'appears to be a private/internal package' },
    });
    const r = await loopController.executeVerifyStage(projectId, batchId, { id: 'inst-4', project_id: projectId, batch_id: batchId, work_item_id: workItemId });
    expect(r.status).toBe('rejected');
    expect(r.reason).toBe('dep_resolver_unresolvable');
    const project = db.prepare('SELECT status, config_json FROM factory_projects WHERE id = ?').get(projectId);
    expect(project.status).toBe('paused');
    const cfg = JSON.parse(project.config_json);
    expect(cfg.baseline_broken_reason).toBe('dep_resolver_unresolvable');
  });

  it('Scenario 5 (supervised trust): emits pending_approval, does not auto-submit', async () => {
    const loopController = require('../factory/loop-controller');
    const { projectId, workItemId, batchId } = seedProjectItemAndWorktree(db, { trust: 'supervised' });
    const { resolveSpy } = mockResolverAndVerify({
      verifyOutputs: [
        { passed: false, exitCode: 1, stdout: "ModuleNotFoundError: No module named 'cv2'", stderr: '', output: '', durationMs: 1, timedOut: false },
      ],
      reviewOutputs: [
        { classification: 'missing_dep', manager: 'python', package_name: 'opencv-python', module_name: 'cv2', error_output: '' },
      ],
      resolveOutputs: [],
    });
    const r = await loopController.executeVerifyStage(projectId, batchId, { id: 'inst-5', project_id: projectId, batch_id: batchId, work_item_id: workItemId });
    expect(r.status).toBe('paused');
    expect(r.reason).toBe('dep_resolver_pending_approval');
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it('Scenario 6 (kill switch): dep_resolver.enabled=false → falls through, no resolver call', async () => {
    const loopController = require('../factory/loop-controller');
    const { projectId, workItemId, batchId } = seedProjectItemAndWorktree(db, { cfgOverrides: { dep_resolver: { enabled: false }, verify_command: 'x' } });
    const { resolveSpy } = mockResolverAndVerify({
      verifyOutputs: [
        { passed: false, exitCode: 1, stdout: "ModuleNotFoundError: No module named 'cv2'", stderr: '', output: '', durationMs: 1, timedOut: false },
        { passed: false, exitCode: 1, stdout: '', stderr: '', output: '', durationMs: 1, timedOut: false },
        { passed: false, exitCode: 1, stdout: '', stderr: '', output: '', durationMs: 1, timedOut: false },
        { passed: false, exitCode: 1, stdout: '', stderr: '', output: '', durationMs: 1, timedOut: false },
      ],
      reviewOutputs: [
        { classification: 'missing_dep', manager: 'python', package_name: 'opencv-python', module_name: 'cv2', error_output: '' },
        { classification: 'task_caused', confidence: 'high', modifiedFiles: [], failingTests: [], intersection: [], environmentSignals: [], llmVerdict: null, llmCritique: null, suggestedRejectReason: null },
        { classification: 'task_caused', confidence: 'high', modifiedFiles: [], failingTests: [], intersection: [], environmentSignals: [], llmVerdict: null, llmCritique: null, suggestedRejectReason: null },
        { classification: 'task_caused', confidence: 'high', modifiedFiles: [], failingTests: [], intersection: [], environmentSignals: [], llmVerdict: null, llmCritique: null, suggestedRejectReason: null },
      ],
    });
    await loopController.executeVerifyStage(projectId, batchId, { id: 'inst-6', project_id: projectId, batch_id: batchId, work_item_id: workItemId });
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it('Scenario 7 (escalation LLM unavailable): pause with escalation_llm_unavailable reason', async () => {
    const loopController = require('../factory/loop-controller');
    const { projectId, workItemId, batchId } = seedProjectItemAndWorktree(db);
    mockResolverAndVerify({
      verifyOutputs: [
        { passed: false, exitCode: 1, stdout: "ModuleNotFoundError: No module named 'x'", stderr: '', output: '', durationMs: 1, timedOut: false },
      ],
      reviewOutputs: [
        { classification: 'missing_dep', manager: 'python', package_name: 'x-pkg', module_name: 'x', error_output: '' },
      ],
      resolveOutputs: [
        { outcome: 'resolver_task_failed', reverifyNeeded: false, reason: 'pip error' },
      ],
      escalateOutput: { action: 'pause', reason: 'escalation_llm_unavailable: submit_threw' },
    });
    const r = await loopController.executeVerifyStage(projectId, batchId, { id: 'inst-7', project_id: projectId, batch_id: batchId, work_item_id: workItemId });
    expect(r.status).toBe('rejected');
    expect(r.reason).toBe('dep_resolver_unresolvable');
    const project = db.prepare('SELECT config_json FROM factory_projects WHERE id = ?').get(projectId);
    const cfg = JSON.parse(project.config_json);
    expect(cfg.baseline_broken_evidence.escalation_reason).toMatch(/escalation_llm_unavailable/);
  });
});
```

- [ ] **Step 2: Run tests (expect most to pass; investigate failures)**

Run: `cd server && npx vitest run tests/factory-dep-resolver-integration.test.js --reporter=default`
Expected: 7/7 pass. If some fail:
- If they fail on harness shape (e.g., `setWorktreeRunnerForTests` missing), mirror the pattern from `factory-verify-review-integration.test.js` — it resolved the same kind of issue for the earlier feature.
- If resolver/escalation spies don't intercept because the loop-controller required them before the spy was installed, add a `delete require.cache[require.resolve('../factory/dep-resolver/index')]` before the spy install, matching the require-cache shim used in plan-quality-gate-integration-shims.test.js.

- [ ] **Step 3: Run the full resolver suite to confirm no regressions**

Run: `cd server && npx vitest run tests/dep-resolver-registry.test.js tests/dep-resolver-python.test.js tests/dep-resolver-escalation.test.js tests/dep-resolver-orchestrator.test.js tests/verify-review.test.js tests/factory-dep-resolver-integration.test.js`
Expected: all passing.

- [ ] **Step 4: Commit**

```bash
git add server/tests/factory-dep-resolver-integration.test.js
git commit -m "test(factory): dep-resolver integration e2e suite"
```

---

## Task 12: Documentation — CLAUDE.md decision actions table

**Files:**
- Modify: `CLAUDE.md` (the "Auto-Recovery Decision Actions" table — add the new dep_resolver_* actions)

- [ ] **Step 1: Append to the decision actions table**

In `CLAUDE.md`, find the table under `### Auto-Recovery Decision Actions` (around the end of the "Factory Auto-Pilot" section). Add these rows at the bottom of the table:

```md
| `dep_resolver_detected` | verify | `reviewVerifyFailure` returned `missing_dep` with high/medium confidence | Missing-package classification; resolver about to fire |
| `dep_resolver_task_submitted` | verify | Factory submitted Codex resolver task | Resolver in flight |
| `dep_resolver_task_completed` | verify | Codex resolver task completed + manifest validated | Ready to re-verify |
| `dep_resolver_validation_failed` | verify | Codex claimed done but `validateManifestUpdate` disagreed | Treated as resolver failure; escalation may fire |
| `dep_resolver_escalated` | verify | Resolver failed; escalation LLM called | One-shot fallback in flight |
| `dep_resolver_escalation_retry` | verify | Escalation LLM returned `retry`; new resolver task with revised prompt | Last-chance resolution |
| `dep_resolver_escalation_pause` | verify | Escalation LLM returned `pause`, or escalation itself failed | Project pausing; baseline_broken_reason = dep_resolver_unresolvable |
| `dep_resolver_reverify_passed` | verify | Resolution succeeded; verify command re-ran and passed (or cascade continuing) | Factory advancing to LEARN (or next dep resolution) |
| `dep_resolver_cascade_exhausted` | verify | 3 dep resolutions done, 4th missing_dep detected | Pausing project with baseline_broken_reason = dep_cascade_exhausted |
| `dep_resolver_disabled` | verify | Missing dep detected but `config_json.dep_resolver.enabled === false` | Falling through to existing classifier; no resolver involvement |
| `dep_resolver_pending_approval` | verify | Missing dep detected on supervised/guided trust project | Operator must approve before install |
| `dep_resolver_no_adapter` | verify | Manager field unknown to registry (should not happen in v1) | Falling through to existing retry |
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): add dep_resolver decision actions to recovery table"
```

---

## Self-Review Checklist (for the implementer)

After completing all tasks:

1. **Spec coverage check**
   - [ ] Detection flow (Task 2, 3, 5, 8) — regex + LLM mapping + registry dispatch + wired into classifier
   - [ ] Resolver action (Task 4, 7, 9) — prompt building, orchestrator, wired into executeVerifyStage
   - [ ] Cascade cap (Task 9) — counter in `dep_resolve_cycle_count`, capped at 3, pause as baseline_broken
   - [ ] Escalation (Task 6, 9) — one-shot LLM fallback, retry OR pause
   - [ ] Trust-level gating (Task 10) — supervised/guided → pending_approval, no auto-submit
   - [ ] Kill switch (Task 9) — `dep_resolver.enabled === false` falls through
   - [ ] Decision log actions (Task 12) — all 12 documented
   - [ ] Plugin architecture (Task 1, 5) — registry + adapter interface, Python as first concrete adapter
2. **Placeholder scan**
   - [ ] No "TBD"/"TODO" in production code
   - [ ] No "add appropriate error handling" without concrete code
   - [ ] All test bodies are complete (no `// write tests here`)
3. **Type/signature consistency**
   - [ ] Adapter interface identical across `python.js` export and what `registry.detect` + `depResolver.resolve` consume
   - [ ] `classification.package_name` / `classification.manager` / `classification.module_name` match across verify-review, resolver, and executeVerifyStage
   - [ ] `resolve()` outcome strings (`resolved` / `resolver_task_failed` / `validation_failed` / `unhandled`) used consistently
   - [ ] Decision-log action names match between CLAUDE.md table and `safeLogDecision` calls
4. **Lint coverage**
   - [ ] No hardcoded provider names in dep-resolver/ — routing goes through `kind: 'reasoning'` and `kind: 'targeted_file_edit'`
   - [ ] No `spawnSync` in new code (factory lint rule)
   - [ ] All LLM JSON parsing uses non-greedy regex (`/\{[\s\S]*?\}/`) matching yesterday's plan-quality-gate fix
