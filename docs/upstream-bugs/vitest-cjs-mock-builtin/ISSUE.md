# GitHub Issue Body

**Ready to paste into <https://github.com/vitest-dev/vitest/issues/new>.**

---

## Title

`vi.mock('child_process', factory) does not intercept require() in CJS test files (4.1.4)`

## Body

### Describe the bug

In a CommonJS test file (one that uses `require()` / `module.exports` and no top-level `import`), `vi.mock('node built-in', factory)` registers the factory but `require('<that built-in>')` in the module under test still returns the real Node module. The factory never runs. Mocks for user modules appear to work; only Node built-ins are affected.

### Reproduction

Self-contained repro — four files totalling ~40 lines:

**`package.json`**
```json
{
  "name": "vi-mock-cjs-repro",
  "type": "commonjs",
  "devDependencies": { "vitest": "^4.1.4" }
}
```

**`vitest.config.js`**
```js
const { defineConfig } = require('vitest/config');
module.exports = defineConfig({
  test: { globals: true, include: ['src/**/*.test.js'], pool: 'threads' },
});
```

**`src/util.js`**
```js
'use strict';
const { execFileSync } = require('child_process');
let user = '';
try { user = execFileSync('git', ['config', 'user.name'], { encoding: 'utf8' }).trim(); } catch {}
module.exports = { user };
```

**`src/util.test.js`**
```js
'use strict';
const _config = { name: '' };
vi.mock('child_process', () => ({
  execFileSync: (cmd, args) => {
    if (cmd === 'git' && Array.isArray(args) && args[1] === 'user.name') return _config.name + '\n';
    return '';
  },
}));
function load() {
  delete require.cache[require.resolve('./util')];
  return require('./util');
}
describe('vi.mock child_process in CJS', () => {
  it('trivial', () => { expect(1).toBe(1); });
  it('user should be Alice', () => {
    _config.name = 'Alice';
    expect(load().user).toBe('Alice');
  });
  it('user should be Bob', () => {
    _config.name = 'Bob';
    expect(load().user).toBe('Bob');
  });
});
```

Run: `npm install && npx vitest run`.

### Expected

`Tests 3 passed (3)`.

### Actual

```
Test Files  1 failed (1)
      Tests  2 failed | 1 passed (3)
```

The trivial test passes. The two mock-dependent tests fail with `Received: "<real git user.name from the dev's machine>"` — proof the mock factory never ran.

### Environment

- vitest: **4.1.4** (also `vitest@latest` — npm registry `dist-tags.latest = "4.1.4"`)
- Node: 22.x
- OS: Windows 11, Git Bash (also reproduces under `cmd.exe`)
- pool: `threads` (also reproduces under the default and under `forks`)

### Additional symptoms

When a test file contains three mock-dependent `it()` blocks of which the mock is silently not firing, we observed vitest's test *discovery* quietly dropping one of the blocks — the summary reports 22 tests when the file contains 23 `it()` definitions, and `vitest list` omits it. Adding a trailing dummy `it()` makes the missing one reappear. We suspect this is a downstream artifact of the mock not activating during the collection pass.

### Things we tried (none work)

- Async factory with `importOriginal()`
- `vi.hoisted()` for the shared state
- `vi.doMock` inside `beforeEach`
- Wrapping the `require('child_process')` destructure in a lazy factory
- Moving the 3rd `it()` to a dedicated test file (not even discovered then — `vitest list` doesn't see it)

### Workaround

Direct module-object mutation — `require('child_process')` once at test-file load, save the real function, overwrite the property in `beforeEach`, restore in `afterEach`. Works because `require()` of a built-in returns the same module singleton every time. Verbose but reliable.

### Why it matters

Large projects using CJS (legacy codebases, projects not ready to migrate) have no clean way to mock Node built-ins. The fall-through to the real binary often means tests actually shell out, touch the real filesystem, read real git config, etc.

---

## Filing checklist (for the human)

- [ ] Verified `npm install && npx vitest run` in `repro/` reproduces
- [ ] Have a GitHub account
- [ ] Either: attach `repro/` as a zipped tarball, OR create a public gist and link it
- [ ] Paste this body at <https://github.com/vitest-dev/vitest/issues/new>
- [ ] Link back to this issue in `docs/upstream-bugs/vitest-cjs-mock-builtin/README.md` so future TORQUE contributors see progress
