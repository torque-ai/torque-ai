# vitest 4.1.4 — `vi.mock` does not intercept `require()` of Node built-ins in CJS test files

## Summary

In a CommonJS test file (one using `require()` / `module.exports` / no top-level `import`), `vi.mock('child_process', factory)` registers the mock but `require('child_process')` still returns the real Node module. Every subsequent call to `cp.execFileSync(...)` invokes the real binary instead of the mock factory's stub.

Observed on: **vitest 4.1.4, Node 22.x, Windows (Git Bash) + `pool: 'threads'`**. Also reproduces under the vitest default pool.

This bit us while writing tests for a module that reads `git config user.name` via `execFileSync` at module-load time. The mock never fired; `GIT_USER_NAME` always came from the real git config. Larger effect observed: a third `it()` block in the test file got silently dropped from vitest's test discovery (the file was reported as containing 22 tests when it contained 23), which we suspect is a downstream artifact of the mock not activating during the collection pass.

Working around it requires direct module mutation (`childProcess.execFileSync = mockedFn` before each test, restore after), which is verbose and easy to get wrong.

## Repro

Four files under `repro/`:

- `package.json` — `"type": "commonjs"`, devDep `vitest@^4.0.0`
- `vitest.config.js` — minimal config
- `src/util.js` — the code under test; reads `execFileSync` at top level
- `src/util.test.js` — asserts the mock intercepts; expects `util.user === 'Alice'` / `'Bob'`

### Reproduce

```bash
cd repro
npm install
npx vitest run
```

### Expected

3 passing tests. The mock's `execFileSync` returns `_config.name` for `git config user.name`, so `util.user` equals whatever the test set before requiring.

### Actual (observed)

```
Test Files  1 failed (1)
      Tests  2 failed | 1 passed (3)
```

The trivial test passes. The two mock-dependent tests fail with `Received: "<real git user.name>"` — proof the mock was never activated.

## Notes / non-reproducers

- **ESM test files (`"type": "module"`, `import`)** — likely work correctly; we didn't need to verify because our codebase is CJS.
- **Mocking a user module** (not a Node built-in) in CJS — unverified; the test specifically needs a Node built-in.
- **Async factories with `importOriginal`** — same failure shape. Irrelevant whether the factory is sync or async.
- **`vi.hoisted` helper** — does not help; the factory registers, just isn't consulted by `require()`.
- **`vi.doMock` inside `beforeEach`** — same failure. Does not activate in time for the top-level require.

## Workaround

Direct module mutation — `require('child_process')` once at test-file load, save the real function, overwrite the property in `beforeEach`, restore in `afterEach`. Works because `require()` of a built-in returns the same module object instance every time, so overwrites are seen by all callers.

See: `server/tests/pii-guard.test.js` in this repo (`_realExecFileSync` pattern, commit `f8f11a4e`).

## To file upstream

Copy `repro/` to a scratch dir, verify repro with `npm install && npx vitest run`, then open an issue at <https://github.com/vitest-dev/vitest/issues> with:

- **Title:** `vi.mock('child_process', ...) does not intercept require() in CommonJS test files (4.1.4)`
- **Body:** the content of this README above the "To file upstream" heading
- **Reproducer:** attach `repro/` as a zip or link to a gist
