# Local Ollama Agentic Loop Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make local Ollama (qwen3-coder:30b) reliably complete agentic-loop-driven EXECUTE-stage tasks by composing five small-model robustness fixes on the existing agentic loop.

**Architecture:** No new modules. Five coordinated changes land in their natural layers — `ollama-tools.js` (allowlist + suggestion-aware rejection), `ollama-agentic.js` (relaxed early-stop + first-iter validator), `execution.js` (few-shot in system prompt). Frontier-model behavior is preserved because each lever is either (a) lenience that benefits all models or (b) gated on conditions frontier models don't trigger.

**Tech Stack:** Node.js, vitest, no new dependencies. Worktree: `.worktrees/feat-ollama-agentic-robustness/` on branch `feat/ollama-agentic-robustness`.

**Spec:** `docs/superpowers/specs/2026-04-27-ollama-agentic-loop-robustness-design.md`

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `server/providers/ollama-tools.js` | Tool dispatch + allowlist enforcement | Add `ALWAYS_ALLOWED_READONLY` set inside `isCommandAllowed`; rewrite `run_command` rejection branch to attach suggestion + `_allowlist_rejection` marker |
| `server/providers/ollama-agentic.js` | Outer agentic iteration loop | Relax consecutive-error threshold 2→3 and skip on `_allowlist_rejection`; insert first-iteration validator + corrective reprompt before empty-content retry |
| `server/providers/execution.js` | Build agentic system prompt | Append few-shot example block before "Working directory:" line in `buildAgenticSystemPrompt` |
| `server/tests/ollama-tools-security.test.js` | Allowlist + rejection tests | Extend with PS-cmdlet allowance, suggestion strings, `_allowlist_rejection` marker assertions |
| `server/tests/agentic-execution-fixes.test.js` | Agentic loop behavior | Extend with new threshold (3 not 2), allowlist-rejection skip, first-iter validator scenarios |
| `server/tests/build-agentic-system-prompt.test.js` *(new)* | System prompt content | Assertions on few-shot block presence + structure |

No DB schema changes. No config defaults changed. No new modules.

---

## Pre-flight

- [ ] **Step 0: Verify worktree state**

Run: `git -C .worktrees/feat-ollama-agentic-robustness rev-parse --abbrev-ref HEAD`
Expected: `feat/ollama-agentic-robustness`

If not, the worktree is wrong — stop and re-create with `scripts/worktree-create.sh ollama-agentic-robustness`.

- [ ] **Step 0b: Confirm spec is committed or stash uncommitted spec**

Run: `git -C .worktrees/feat-ollama-agentic-robustness status --short docs/superpowers/specs/`
If the spec file shows as `??` or `M`, commit it first:

```bash
cd .worktrees/feat-ollama-agentic-robustness
git add docs/superpowers/specs/2026-04-27-ollama-agentic-loop-robustness-design.md docs/superpowers/plans/2026-04-27-ollama-agentic-loop-robustness.md
git commit -m "docs(ollama-agentic): spec + plan for small-model robustness pass"
```

All subsequent commits assume CWD is the worktree root.

---

## Task 1: Fix #2A — Always-allowed read-only commands

**Files:**
- Modify: `server/providers/ollama-tools.js` — `isCommandAllowed` function (~line 614-637)
- Test: `server/tests/ollama-tools-security.test.js` (extend)

**Why:** Today task 45659863 made productive progress for 7 iterations, then `run_command Get-Content` was rejected (followed by `powershell -Command "Get-Content..."` also rejected) and the loop bailed. These read-only inspection commands are safe regardless of the configured allowlist — they should be unconditionally permitted just like `rm -rf /` is unconditionally blocked.

**Approach:** Mirror the existing `ALWAYS_BLOCKED` pattern with an `ALWAYS_ALLOWED_READONLY` set inside `isCommandAllowed`. Match by leading token (case-insensitive) so `Get-Content foo.ps1` is allowed but `Get-Content foo | Set-Content bar` is still rejected by the existing shell-metachar guard (pipe `|`).

- [ ] **Step 1.1: Write failing tests**

Append to `server/tests/ollama-tools-security.test.js` before the closing `});`:

```javascript
  it('always allows Get-Content even when allowlist excludes it', () => {
    const executor = createToolExecutor(process.cwd(), {
      commandMode: 'allowlist',
      commandAllowlist: ['npm *'], // explicitly does not include Get-Content
    });
    const result = executor.execute('run_command', { command: 'Get-Content package.json' });
    expect(result.result).not.toContain('not in allowlist');
  });

  it('always allows Get-ChildItem with no flags', () => {
    const executor = createToolExecutor(process.cwd(), {
      commandMode: 'allowlist',
      commandAllowlist: ['npm *'],
    });
    const result = executor.execute('run_command', { command: 'Get-ChildItem' });
    expect(result.result).not.toContain('not in allowlist');
  });

  it('always allows Select-String pattern over a path', () => {
    const executor = createToolExecutor(process.cwd(), {
      commandMode: 'allowlist',
      commandAllowlist: ['npm *'],
    });
    const result = executor.execute('run_command', { command: 'Select-String -Pattern foo package.json' });
    expect(result.result).not.toContain('not in allowlist');
  });

  it('always allows Measure-Object', () => {
    const executor = createToolExecutor(process.cwd(), {
      commandMode: 'allowlist',
      commandAllowlist: ['npm *'],
    });
    const result = executor.execute('run_command', { command: 'Measure-Object' });
    expect(result.result).not.toContain('not in allowlist');
  });

  it('match is case-insensitive (get-content lowercase still allowed)', () => {
    const executor = createToolExecutor(process.cwd(), {
      commandMode: 'allowlist',
      commandAllowlist: ['npm *'],
    });
    const result = executor.execute('run_command', { command: 'get-content package.json' });
    expect(result.result).not.toContain('not in allowlist');
  });

  it('still blocks dangerous cmdlets (Remove-Item) even though they share Get-* prefix family', () => {
    const executor = createToolExecutor('/tmp/test-dir', {
      commandMode: 'allowlist',
      commandAllowlist: ['npm *'],
    });
    const result = executor.execute('run_command', { command: 'Remove-Item foo.txt' });
    expect(result.error).toBe(true);
    expect(result.result).toContain('not in allowlist');
  });

  it('still blocks Get-Content when piped (shell metachar guard fires)', () => {
    const executor = createToolExecutor('/tmp/test-dir', {
      commandMode: 'allowlist',
      commandAllowlist: ['*'],
    });
    const result = executor.execute('run_command', { command: 'Get-Content foo | Set-Content bar' });
    expect(result.error).toBe(true);
  });
```

- [ ] **Step 1.2: Run tests — verify they fail**

Run: `torque-remote npx vitest run server/tests/ollama-tools-security.test.js`
Expected: 7 new tests fail (current code rejects Get-Content etc. because they don't match `npm *`).

- [ ] **Step 1.3: Implement always-allowed set**

In `server/providers/ollama-tools.js`, replace the body of `isCommandAllowed` (function starts at ~line 614). Old:

```javascript
function isCommandAllowed(command, allowlist) {
  // ALWAYS check dangerous commands regardless of allowlist mode
  const ALWAYS_BLOCKED = ['rm -rf /', 'mkfs', 'dd if=', ':(){', 'fork bomb'];
  const cmdLower = command.toLowerCase();
  if (ALWAYS_BLOCKED.some(b => cmdLower.includes(b))) {
    return false;
  }
  // Reject dangerous shell chaining operators to prevent command injection.
  // Blocks: ; (chain), | (pipe), & (background/AND), ` (backtick subshell),
  // >> (append redirect). Allows: quotes, (), $, {} in arguments (needed for
  // node -e "...", dotnet test --filter "...", etc.)
  if (/[;|&`]|>\s*>/.test(command)) {
    return false;
  }
  for (const pattern of allowlist) {
    if (pattern === '*') return true;
    // Convert the simple glob to a regex:
    // Escape regex special chars except *, then replace * with .*
    const escaped = pattern.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*');
    const regex = new RegExp(`^${escaped}$`);
    if (regex.test(command)) return true;
  }
  return false;
}
```

New (block-injected after the metachar guard, before the per-pattern loop):

```javascript
function isCommandAllowed(command, allowlist) {
  // ALWAYS check dangerous commands regardless of allowlist mode
  const ALWAYS_BLOCKED = ['rm -rf /', 'mkfs', 'dd if=', ':(){', 'fork bomb'];
  const cmdLower = command.toLowerCase();
  if (ALWAYS_BLOCKED.some(b => cmdLower.includes(b))) {
    return false;
  }
  // Reject dangerous shell chaining operators to prevent command injection.
  // Blocks: ; (chain), | (pipe), & (background/AND), ` (backtick subshell),
  // >> (append redirect). Allows: quotes, (), $, {} in arguments (needed for
  // node -e "...", dotnet test --filter "...", etc.)
  if (/[;|&`]|>\s*>/.test(command)) {
    return false;
  }
  // ALWAYS allow safe read-only inspection commands regardless of the
  // configured allowlist. These are read-only by design and the shell-
  // metachar guard above already rejects pipelines/redirects, so any
  // composition that could mutate state is already blocked.
  // Match by leading token (the cmdlet/binary name), case-insensitive.
  const ALWAYS_ALLOWED_READONLY = new Set([
    'get-content',
    'get-childitem',
    'gci',
    'dir',
    'ls',
    'select-string',
    'measure-object',
  ]);
  const leadingToken = command.trim().split(/\s+/)[0].toLowerCase();
  if (ALWAYS_ALLOWED_READONLY.has(leadingToken)) {
    return true;
  }
  for (const pattern of allowlist) {
    if (pattern === '*') return true;
    // Convert the simple glob to a regex:
    // Escape regex special chars except *, then replace * with .*
    const escaped = pattern.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*');
    const regex = new RegExp(`^${escaped}$`);
    if (regex.test(command)) return true;
  }
  return false;
}
```

- [ ] **Step 1.4: Run tests — verify they pass**

Run: `torque-remote npx vitest run server/tests/ollama-tools-security.test.js`
Expected: All tests pass (7 new + all existing).

- [ ] **Step 1.5: Commit**

```bash
git add server/providers/ollama-tools.js server/tests/ollama-tools-security.test.js
git commit -m "feat(ollama-tools): always allow safe read-only PS cmdlets in run_command"
```

---

## Task 2: Fix #2B — Suggestion-aware rejection error + `_allowlist_rejection` marker

**Files:**
- Modify: `server/providers/ollama-tools.js` — `run_command` allowlist branch (~line 1189-1198)
- Test: `server/tests/ollama-tools-security.test.js` (extend)

**Why:** When the allowlist DOES reject (e.g., `cat foo.txt`, `find . -name`), the model gets a useless "not in allowlist" error and re-tries the same idea with different syntax. Telling it which built-in tool to use instead unblocks recovery in one step. The `_allowlist_rejection` marker is the wire signal that Fix #3 reads to suppress the consecutive-error counter.

- [ ] **Step 2.1: Write failing tests**

Append to `server/tests/ollama-tools-security.test.js` before the closing `});`:

```javascript
  it('rejection of cat suggests read_file', () => {
    const executor = createToolExecutor('/tmp/test-dir', {
      commandMode: 'allowlist',
      commandAllowlist: ['npm *'],
    });
    const result = executor.execute('run_command', { command: 'cat foo.txt' });
    expect(result.error).toBe(true);
    expect(result.result).toContain('use read_file');
    expect(result._allowlist_rejection).toBe(true);
  });

  it('rejection of head suggests read_file with end_line', () => {
    const executor = createToolExecutor('/tmp/test-dir', {
      commandMode: 'allowlist',
      commandAllowlist: ['npm *'],
    });
    const result = executor.execute('run_command', { command: 'head -n 20 foo.txt' });
    expect(result.error).toBe(true);
    expect(result.result).toContain('end_line');
    expect(result._allowlist_rejection).toBe(true);
  });

  it('rejection of tail suggests read_file with start_line', () => {
    const executor = createToolExecutor('/tmp/test-dir', {
      commandMode: 'allowlist',
      commandAllowlist: ['npm *'],
    });
    const result = executor.execute('run_command', { command: 'tail -n 20 foo.txt' });
    expect(result.error).toBe(true);
    expect(result.result).toContain('start_line');
    expect(result._allowlist_rejection).toBe(true);
  });

  it('rejection of find suggests search_files', () => {
    const executor = createToolExecutor('/tmp/test-dir', {
      commandMode: 'allowlist',
      commandAllowlist: ['npm *'],
    });
    const result = executor.execute('run_command', { command: 'find . -name foo' });
    expect(result.error).toBe(true);
    expect(result.result).toContain('use search_files');
    expect(result._allowlist_rejection).toBe(true);
  });

  it('rejection of grep suggests search_files', () => {
    const executor = createToolExecutor('/tmp/test-dir', {
      commandMode: 'allowlist',
      commandAllowlist: ['npm *'],
    });
    const result = executor.execute('run_command', { command: 'grep -r foo .' });
    expect(result.error).toBe(true);
    expect(result.result).toContain('use search_files');
    expect(result._allowlist_rejection).toBe(true);
  });

  it('rejection of unknown destructive command sets marker but no specific suggestion', () => {
    const executor = createToolExecutor('/tmp/test-dir', {
      commandMode: 'allowlist',
      commandAllowlist: ['npm *'],
    });
    const result = executor.execute('run_command', { command: 'somethingweird --flag' });
    expect(result.error).toBe(true);
    expect(result.result).toContain('not in allowlist');
    expect(result.result).not.toContain(' — use ');
    expect(result._allowlist_rejection).toBe(true);
  });

  it('rejection marker is set on every allowlist-rejection (rm -rf included)', () => {
    const executor = createToolExecutor('/tmp/test-dir', {
      commandMode: 'allowlist',
      commandAllowlist: ['npm *'],
    });
    const result = executor.execute('run_command', { command: 'rm -rf node_modules' });
    expect(result.error).toBe(true);
    expect(result._allowlist_rejection).toBe(true);
  });

  it('successful command does not have _allowlist_rejection marker', () => {
    const executor = createToolExecutor(process.cwd(), {
      commandMode: 'allowlist',
      commandAllowlist: ['node *'],
    });
    const result = executor.execute('run_command', { command: 'node --version' });
    expect(result._allowlist_rejection).toBeUndefined();
  });
```

- [ ] **Step 2.2: Run tests — verify they fail**

Run: `torque-remote npx vitest run server/tests/ollama-tools-security.test.js`
Expected: 8 new tests fail (current code returns no marker and no suggestions).

- [ ] **Step 2.3: Implement suggestion-aware rejection**

In `server/providers/ollama-tools.js`, find the `run_command` case (~line 1189-1198). Replace:

```javascript
        case 'run_command': {
          // Validate against allowlist if in allowlist mode
          if (commandMode === 'allowlist') {
            if (!isCommandAllowed(args.command, commandAllowlist)) {
              return {
                result: `Error: Command not in allowlist: ${args.command}`,
                error: true,
              };
            }
          }
```

With:

```javascript
        case 'run_command': {
          // Validate against allowlist if in allowlist mode
          if (commandMode === 'allowlist') {
            if (!isCommandAllowed(args.command, commandAllowlist)) {
              // Suggest the built-in tool when one matches the rejected command's
              // intent. Helps the model recover in one step instead of retrying
              // the same idea with different shell syntax.
              const leadingToken = args.command.trim().split(/\s+/)[0].toLowerCase();
              const SUGGESTIONS = {
                'cat': 'use read_file({path}) instead',
                'get-content': 'use read_file({path}) instead',
                'head': 'use read_file({path, end_line: N}) instead',
                'tail': 'use read_file({path, start_line: -N}) instead',
                'ls': 'use list_directory({path}) instead',
                'dir': 'use list_directory({path}) instead',
                'get-childitem': 'use list_directory({path}) instead',
                'find': 'use search_files({pattern, path}) instead',
                'grep': 'use search_files({pattern, path}) instead',
                'select-string': 'use search_files({pattern, path}) instead',
                'rg': 'use search_files({pattern, path}) instead',
              };
              const hint = SUGGESTIONS[leadingToken] ? ` — ${SUGGESTIONS[leadingToken]}` : '';
              return {
                result: `Error: Command not in allowlist: ${args.command}${hint}`,
                error: true,
                _allowlist_rejection: true,
              };
            }
          }
```

- [ ] **Step 2.4: Run tests — verify they pass**

Run: `torque-remote npx vitest run server/tests/ollama-tools-security.test.js`
Expected: All tests pass (8 new + all from Task 1 + originals).

- [ ] **Step 2.5: Commit**

```bash
git add server/providers/ollama-tools.js server/tests/ollama-tools-security.test.js
git commit -m "feat(ollama-tools): suggest built-in tool on allowlist rejection + add _allowlist_rejection marker"
```

---

## Task 3: Fix #3 — Relaxed consecutive-error early-stop + skip on allowlist marker

**Files:**
- Modify: `server/providers/ollama-agentic.js` — consecutive-error tracking block (~line 622-666)
- Test: `server/tests/agentic-execution-fixes.test.js` (extend)

**Why:** The current loop bails after 2 same-tool errors across separate iterations. With Fix #2A landing many fewer rejections, the residual rejections that DO occur should be treated as routing hints (no penalty), and genuine errors get one more retry budget (3 instead of 2). Together this gives the model meaningful headroom to recover before being cut off mid-task.

There are two sub-changes inside the same code block:
1. Skip the increment when `execResult._allowlist_rejection === true`. Treat it like a success — reset `lastErrorToolName` and `consecutiveErrorCount`.
2. Bump threshold: `consecutiveErrorCount >= 2` → `>= 3`.

- [ ] **Step 3.1: Locate the existing same-tool-consecutive-errors test**

Run: `grep -n "consecutive errors from read_file after" server/tests/agentic-execution-fixes.test.js`

Read the test around line 1397 to understand the existing fixture pattern (mock adapter that yields a sequence of tool calls with errors). The new tests for Task 3 should follow the same pattern.

- [ ] **Step 3.2: Write failing tests**

Find the existing `it('fails read-only openrouter reports when the agentic loop stops for consecutive tool errors', ...)` test in `server/tests/agentic-execution-fixes.test.js` (around line 1397). Update the existing test for the new threshold (it currently expects "after 2 iterations" — update fixture to produce 3 errors and assert "after 3 iterations" wording).

In the SAME test file, in the SAME describe block, add a new `describe('Fix #3 — relaxed early-stop and allowlist-rejection skip', ...)` with these cases. Each case mocks the agentic loop's adapter to return a controlled sequence of tool_calls and verifies the early-stop trigger / non-trigger.

```javascript
describe('Fix #3 — relaxed early-stop and allowlist-rejection skip', () => {
  // Reuse the harness from the existing 'consecutive tool errors' describe. The
  // pattern is: prepare a mock adapter that yields N tool_calls in sequence,
  // configure the toolExecutor to return errors for selected calls, run runAgenticLoop,
  // then assert on stopReason / finalOutput / iterations actually run.

  it('does NOT trigger early-stop on 2 same-tool real errors (was the threshold before)', async () => {
    // Adapter yields 3 iterations:
    //   iter 0: read_file('a.js')   — toolExecutor returns ENOENT error
    //   iter 1: read_file('b.js')   — toolExecutor returns ENOENT error
    //   iter 2: read_file('c.js')   — toolExecutor returns success ("file content")
    //   iter 3: model returns final summary with no tool_calls
    // Expectation: loop runs all 4 iterations; stopReason is NOT 'consecutive_tool_errors'.
    // (Implementation: see Task 3.4 for harness pattern.)
    expect(true).toBe(false); // placeholder fail; replaced in Step 3.4
  });

  it('DOES trigger early-stop on 3 same-tool real errors', async () => {
    // Adapter yields 3 iterations of read_file errors. Expectation:
    //   stopReason === 'consecutive_tool_errors'
    //   finalOutput contains 'consecutive errors from read_file'
    expect(true).toBe(false); // placeholder fail; replaced in Step 3.4
  });

  it('skips the counter when error has _allowlist_rejection marker', async () => {
    // Adapter yields 5 iterations:
    //   iter 0: run_command('cat foo')  — toolExecutor returns _allowlist_rejection: true
    //   iter 1: run_command('head foo') — toolExecutor returns _allowlist_rejection: true
    //   iter 2: run_command('ls')       — toolExecutor returns _allowlist_rejection: true (or success: same outcome — no early-stop)
    //   iter 3: read_file('a.js')        — success
    //   iter 4: model returns final summary
    // Expectation: stopReason is NOT 'consecutive_tool_errors'.
    expect(true).toBe(false); // placeholder fail; replaced in Step 3.4
  });

  it('mix: real error + allowlist rejection + same-tool real error counts as 2, not 3', async () => {
    // Adapter yields:
    //   iter 0: read_file('a.js') — ENOENT (counter=1)
    //   iter 1: run_command('cat foo') — _allowlist_rejection (counter resets/skipped)
    //   iter 2: read_file('b.js') — ENOENT (counter=1, NOT 2, because the allowlist-rejection reset the tracking)
    //   iter 3: read_file('c.js') — ENOENT (counter=2)
    //   iter 4: model done
    // Expectation: stopReason is NOT 'consecutive_tool_errors'.
    expect(true).toBe(false); // placeholder fail; replaced in Step 3.4
  });

  it('different-tool error breaks the consecutive count', async () => {
    // Adapter yields:
    //   iter 0: read_file('a.js')      — error
    //   iter 1: list_directory('foo')  — error (different tool, counter resets to 1)
    //   iter 2: read_file('b.js')      — error (counter=1; lastErrorToolName changed)
    //   iter 3: model done
    // Expectation: stopReason is NOT 'consecutive_tool_errors'.
    expect(true).toBe(false); // placeholder fail; replaced in Step 3.4
  });
});
```

- [ ] **Step 3.3: Run tests — verify they fail**

Run: `torque-remote npx vitest run server/tests/agentic-execution-fixes.test.js -t "Fix #3"`
Expected: Placeholder failures (the tests intentionally throw `expect(true).toBe(false)` until Step 3.4 fills them in).

- [ ] **Step 3.4: Fill in test bodies using the existing consecutive-tool-errors harness**

Read the existing `it('fails read-only openrouter reports when the agentic loop stops for consecutive tool errors', ...)` test starting at line 1397 of `server/tests/agentic-execution-fixes.test.js`. Copy its setup (mock adapter, mock executor, runAgenticLoop call) into each placeholder test from Step 3.2. The differences per test:

- **Test 1** (2 errors → no stop): Mock executor returns `{ result: 'ENOENT', error: true }` for the first 2 `read_file` calls and `{ result: 'file content' }` for the 3rd. Mock adapter yields tool_calls for 3 iterations then a final summary. Assert: result.stopReason !== 'consecutive_tool_errors' AND result.finalOutput contains the summary.

- **Test 2** (3 errors → stop): Mock executor returns errors for all 3 `read_file` calls. Mock adapter yields 3 iterations of read_file. Assert: result.stopReason === 'consecutive_tool_errors' AND result.finalOutput contains 'consecutive errors from read_file'.

- **Test 3** (allowlist marker → skip): Mock executor returns `{ result: 'Error: Command not in allowlist: cat foo', error: true, _allowlist_rejection: true }` for iter 0/1/2, then success for iter 3 read_file. Mock adapter yields 5 iterations. Assert: result.stopReason !== 'consecutive_tool_errors'.

- **Test 4** (mix): Sequence executor outputs as documented in the test comment. Assert: result.stopReason !== 'consecutive_tool_errors'.

- **Test 5** (different tool resets): Sequence as documented. Assert: result.stopReason !== 'consecutive_tool_errors'.

Replace the `expect(true).toBe(false)` placeholders with the assertions above.

- [ ] **Step 3.5: Run tests — verify they STILL fail (because logic isn't changed yet)**

Run: `torque-remote npx vitest run server/tests/agentic-execution-fixes.test.js -t "Fix #3"`
Expected: Tests 1, 3, 4 fail because the loop bails at count 2 (current behavior). Tests 2, 5 may already pass coincidentally — that's fine.

Also update the EXISTING line-1397 test to expect threshold 3:

```javascript
// In the existing 'fails read-only openrouter reports when the agentic loop stops for consecutive tool errors' test:
//   - Update the mock adapter to yield 3 errors instead of 2.
//   - Update the assertion `output: 'Task stopped: consecutive errors from read_file after 2 iterations.'`
//     to: `output: 'Task stopped: consecutive errors from read_file after 3 iterations.'`
//   - Search the same test file for any other 'after 2 iterations' string and update.
```

Run: `grep -n "after 2 iterations" server/tests/agentic-execution-fixes.test.js`
Expected: Find each occurrence and update to `after 3 iterations` AFTER updating the mock adapter to produce 3 errors.

- [ ] **Step 3.6: Implement the fix in `ollama-agentic.js`**

Open `server/providers/ollama-agentic.js`. Find the consecutive-error tracking block (~line 622-666). Replace:

```javascript
      if (error) {
        if (lastErrorToolName === tc.name && lastErrorIteration < iterations) {
          consecutiveErrorCount++;
          if (consecutiveErrorCount >= 2) {
            // Add the error result first, then stop
            if (promptInjectedTools) {
              messages.push({ role: 'user', content: `[TOOL_RESULTS][{"call":{"name":"${tc.name}"},"output":${JSON.stringify(resultStr)}}][/TOOL_RESULTS]`, _wasError: true });
            } else {
              messages.push({ role: 'tool', content: resultStr, ...(tc.id ? { tool_call_id: tc.id } : {}), _wasError: true });
            }
            finalOutput = `Task stopped: consecutive errors from ${tc.name} after ${iterations + 1} iterations.`;
            logger.warn(`[Agentic] Consecutive errors from ${tc.name} — stopping`);

            // Log the failing tool call
            toolLog.push(buildToolLogEntry(iterations + 1, tc, resultStr, true, durationMs));
            if (onToolCall) onToolCall(tc.name, tc.arguments, execResult);
            totalOutputChars += resultStr.length;

            // Push placeholder results for unexecuted tool calls to maintain valid conversation
            for (let j = tcIdx + 1; j < toolCalls.length; j++) {
              if (promptInjectedTools) {
                messages.push({ role: 'user', content: `[TOOL_RESULTS][{"call":{"name":"${toolCalls[j].name}"},"output":"[skipped — early stop]"}][/TOOL_RESULTS]` });
              } else {
                messages.push({ role: 'tool', content: '[skipped — early stop]', ...(toolCalls[j].id ? { tool_call_id: toolCalls[j].id } : {}) });
              }
            }
            // Signal outer loop to stop
            stopReason = 'consecutive_tool_errors';
            earlyStop = true;
            break;
          }
        } else {
          consecutiveErrorCount = 1;
          lastErrorToolName = tc.name;
          lastErrorIteration = iterations;
        }
      } else {
        // Reset error tracking on success
        lastErrorToolName = null;
        consecutiveErrorCount = 0;
        // Track successful writes for read-only spin detection
        if (!READ_ONLY_TOOLS.has(tc.name)) {
          hasSuccessfulWrite = true;
        }
      }
```

With:

```javascript
      if (error) {
        if (execResult._allowlist_rejection) {
          // Allowlist rejections are routing hints (the model can read the
          // suggestion and switch to the right built-in tool) — not real
          // errors. Reset tracking like a success so the model isn't cut off
          // while pivoting between rejected variants.
          lastErrorToolName = null;
          consecutiveErrorCount = 0;
          logger.info(`[Agentic] allowlist rejection (suppressed from consecutive-error counter): ${tc.name}`);
        } else if (lastErrorToolName === tc.name && lastErrorIteration < iterations) {
          consecutiveErrorCount++;
          if (consecutiveErrorCount >= 3) {
            // Add the error result first, then stop
            if (promptInjectedTools) {
              messages.push({ role: 'user', content: `[TOOL_RESULTS][{"call":{"name":"${tc.name}"},"output":${JSON.stringify(resultStr)}}][/TOOL_RESULTS]`, _wasError: true });
            } else {
              messages.push({ role: 'tool', content: resultStr, ...(tc.id ? { tool_call_id: tc.id } : {}), _wasError: true });
            }
            finalOutput = `Task stopped: consecutive errors from ${tc.name} after ${iterations + 1} iterations.`;
            logger.warn(`[Agentic] Consecutive errors from ${tc.name} — stopping`);

            // Log the failing tool call
            toolLog.push(buildToolLogEntry(iterations + 1, tc, resultStr, true, durationMs));
            if (onToolCall) onToolCall(tc.name, tc.arguments, execResult);
            totalOutputChars += resultStr.length;

            // Push placeholder results for unexecuted tool calls to maintain valid conversation
            for (let j = tcIdx + 1; j < toolCalls.length; j++) {
              if (promptInjectedTools) {
                messages.push({ role: 'user', content: `[TOOL_RESULTS][{"call":{"name":"${toolCalls[j].name}"},"output":"[skipped — early stop]"}][/TOOL_RESULTS]` });
              } else {
                messages.push({ role: 'tool', content: '[skipped — early stop]', ...(toolCalls[j].id ? { tool_call_id: toolCalls[j].id } : {}) });
              }
            }
            // Signal outer loop to stop
            stopReason = 'consecutive_tool_errors';
            earlyStop = true;
            break;
          }
        } else {
          consecutiveErrorCount = 1;
          lastErrorToolName = tc.name;
          lastErrorIteration = iterations;
        }
      } else {
        // Reset error tracking on success
        lastErrorToolName = null;
        consecutiveErrorCount = 0;
        // Track successful writes for read-only spin detection
        if (!READ_ONLY_TOOLS.has(tc.name)) {
          hasSuccessfulWrite = true;
        }
      }
```

Two changes: (a) new `if (execResult._allowlist_rejection)` branch at the top of the error block, (b) threshold `>= 2` → `>= 3`.

- [ ] **Step 3.7: Run tests — verify they pass**

Run: `torque-remote npx vitest run server/tests/agentic-execution-fixes.test.js`
Expected: All Fix #3 tests pass + the updated existing 'consecutive errors after 3 iterations' test passes.

- [ ] **Step 3.8: Commit**

```bash
git add server/providers/ollama-agentic.js server/tests/agentic-execution-fixes.test.js
git commit -m "feat(ollama-agentic): bump consecutive-error threshold 2→3 and skip allowlist rejections"
```

---

## Task 4: Fix #1A — Few-shot example in agentic system prompt

**Files:**
- Modify: `server/providers/execution.js` — `buildAgenticSystemPrompt` (~line 413-442)
- Test: `server/tests/build-agentic-system-prompt.test.js` *(new)*

**Why:** qwen3-coder:30b ignores declarative rules ("TOOL CALLS ARE THE ONLY WAY TO MAKE PROGRESS") and replies with markdown code blocks instead. A demonstrated example of the correct first-response shape changes the conditional probability that the model emits a tool_call vs. prose. Adds ~150 tokens.

- [ ] **Step 4.1: Write failing test (new file)**

Create `server/tests/build-agentic-system-prompt.test.js`:

```javascript
'use strict';

const { describe, it, expect } = require('vitest');
const path = require('path');

// buildAgenticSystemPrompt is module-private; we test through the export shim.
// Add a temporary export if not already exported.
const execution = require('../providers/execution');
const { buildAgenticSystemPrompt } = execution;

describe('buildAgenticSystemPrompt', () => {
  it('exports buildAgenticSystemPrompt for testing', () => {
    expect(typeof buildAgenticSystemPrompt).toBe('function');
  });

  it('contains the existing CRITICAL rule about tool calls', () => {
    const out = buildAgenticSystemPrompt('BASE.', '/tmp/wd');
    expect(out).toContain('TOOL CALLS ARE THE ONLY WAY TO MAKE PROGRESS');
  });

  it('contains the few-shot example block', () => {
    const out = buildAgenticSystemPrompt('BASE.', '/tmp/wd');
    expect(out).toContain('EXAMPLE — correct first response shape');
    expect(out).toContain('"name": "read_file"');
    expect(out).toContain('"name": "edit_file"');
  });

  it('few-shot calls out the prose anti-pattern explicitly', () => {
    const out = buildAgenticSystemPrompt('BASE.', '/tmp/wd');
    expect(out).toContain('DO NOT respond with text saying');
  });

  it('working directory still appears at the end', () => {
    const out = buildAgenticSystemPrompt('BASE.', '/tmp/specific-wd-xyz');
    const idx = out.indexOf('Working directory: /tmp/specific-wd-xyz');
    expect(idx).toBeGreaterThan(-1);
    // It should be at the very end (last ~80 chars).
    expect(out.length - idx).toBeLessThan(80);
  });

  it('basePrompt is preserved at the start', () => {
    const out = buildAgenticSystemPrompt('CUSTOM_BASE_HEADER.', '/tmp/wd');
    expect(out.startsWith('CUSTOM_BASE_HEADER.')).toBe(true);
  });

  it('platform rule still appears (Windows or POSIX flavor)', () => {
    const out = buildAgenticSystemPrompt('BASE.', '/tmp/wd');
    expect(out).toMatch(/PLATFORM:/);
  });
});
```

- [ ] **Step 4.2: Run test — verify it fails**

Run: `torque-remote npx vitest run server/tests/build-agentic-system-prompt.test.js`
Expected: First test fails with `typeof buildAgenticSystemPrompt === 'undefined'` (it's not exported), or downstream tests fail because the few-shot block doesn't exist yet.

- [ ] **Step 4.3: Export `buildAgenticSystemPrompt` from execution.js**

In `server/providers/execution.js`, find the `module.exports = ...` block at the bottom and add `buildAgenticSystemPrompt` to the exported keys.

Run: `grep -n "^module.exports" server/providers/execution.js`
Read 5 lines around it. Add `buildAgenticSystemPrompt,` to the exported object (alphabetic order if the file follows that convention, otherwise at the end).

- [ ] **Step 4.4: Implement few-shot block**

In `server/providers/execution.js`, find `buildAgenticSystemPrompt` (~line 413). Find the closing template-literal at line 441: `Working directory: ${workingDir}\``.

Replace the entire `return basePrompt + \`...\`;` body. The new body adds the EXAMPLE block before the working-directory line:

```javascript
function buildAgenticSystemPrompt(basePrompt, workingDir) {
  const platformRule = process.platform === 'win32'
    ? 'PLATFORM: WINDOWS. NEVER use Unix commands (ls, find, wc, grep, cat, tail, head, sed, awk, chmod). Use PowerShell (dir/Get-ChildItem, Select-String, Get-Content, Select-Object) or — preferably — the provided tools (list_directory, search_files, read_file) which work on all platforms.'
    : 'PLATFORM: Linux/macOS. Bash commands available via run_command, but prefer the provided tools (list_directory, search_files, read_file) when they fit.';

  return basePrompt + `

You are an autonomous coding agent with tool access. Complete the task using ONLY the provided tools.

CRITICAL — TOOL CALLS ARE THE ONLY WAY TO MAKE PROGRESS.
Your first response MUST invoke a tool. Use the structured tool-call mechanism the API gives you (a real tool_calls field, or the JSON-array tool-call format if your model uses prompt-injected tools). Do NOT type the words "read_file" or "search_files" inside the message body — that is text, not a tool call, and the task will be killed and retried on a different model. If you reply with a prose plan, an outline, or "I'll start by...", the task fails. The right move is to invoke read_file, list_directory, or search_files immediately to gather information.

EXAMPLE — correct first response shape:
Task: "Read server/foo.js and add a license header at the top."
Your first response MUST be a tool call, NOT prose. The structured tool-call payload looks like:
  {"name": "read_file", "arguments": {"path": "server/foo.js"}}
Then on the NEXT iteration, after seeing the file content, you would call:
  {"name": "edit_file", "arguments": {"path": "server/foo.js", "old_text": "...", "new_text": "..."}}
DO NOT respond with text saying "I'll read the file first" — that is prose, not a tool call. Invoke read_file directly.

RULES:
1. Use tools to read files, make edits, list directories, search code, and run commands.
2. NEVER describe what you would do — actually do it with tools.
3. ONLY modify files explicitly mentioned in the task. Do NOT touch unrelated files.
4. If a build/test fails for reasons UNRELATED to your change, report the failure and stop. Do NOT try to fix pre-existing issues.
5. If a tool call fails, try ONE alternative approach. If that also fails, report the error and stop.
6. LARGE FILES: For files over ~300 lines, use read_file with start_line/end_line to read ONLY the section you need (e.g., read_file({path, start_line: 150, end_line: 200})). Then use replace_lines to edit by line number. NEVER read an entire large file — it wastes context and slows inference. Use search_files first to find the right line numbers if needed.
7. EDIT FAILURES: If edit_file fails with "old_text not found", the file may have been modified by a prior edit. Re-read the file with read_file to see the current content, then retry. For large files, switch to replace_lines instead.
8. When done, respond with a COMPLETE summary that includes the actual data from tool results. Do NOT just say "I called list_directory" — include the actual file/folder names, counts, and content you found.
9. Be efficient — you have limited iterations. Do ONLY what the task asks. If the task says "list directory", just call list_directory once and report. Do NOT write files, run commands, or do extra work unless explicitly asked.
${platformRule}
11. INDENTATION: When editing code, match the file's existing indentation EXACTLY. Read the file first to see its indent style (spaces/tabs and width). Your new_text must use the same indentation as the surrounding code.
12. SEARCH: Use search_files and list_directory for finding files and content. NEVER use find, grep, or rg via run_command — they are slow and may timeout on large projects.
13. STOP READING WHEN YOU HAVE ENOUGH. The task description names the files to change. Read each relevant file ONCE, then write. If you have read a file already, do NOT re-read it under a different argument shape. Tasks that modify code fail when the model gathers context exhaustively but never edits — three or four read calls is usually enough to start writing. If you find yourself about to call read_file or search_files after you already have the content, call edit_file or replace_lines instead.
14. READ-ONLY FINAL ANSWERS: If the task asks to inspect, list, summarize, report, scout, or otherwise read only, do not ask what to create or modify. Report the observed tool results and state that no edits were made.

Working directory: ${workingDir}`;
}
```

The change is a single inserted paragraph between "CRITICAL — TOOL CALLS..." and "RULES:". Everything else is preserved verbatim.

- [ ] **Step 4.5: Run tests — verify they pass**

Run: `torque-remote npx vitest run server/tests/build-agentic-system-prompt.test.js`
Expected: All 7 tests pass.

- [ ] **Step 4.6: Commit**

```bash
git add server/providers/execution.js server/tests/build-agentic-system-prompt.test.js
git commit -m "feat(execution): few-shot example in agentic system prompt for small-model tool engagement"
```

---

## Task 5: Fix #1B — First-iteration validator + corrective reprompt

**Files:**
- Modify: `server/providers/ollama-agentic.js` — after response-parse, inside `if (toolCalls.length === 0)` block (~line 398-430)
- Test: `server/tests/agentic-execution-fixes.test.js` (extend)

**Why:** Even with the few-shot, qwen3-coder:30b sometimes still produces a markdown response on iter 0. A corrective reprompt — "Your previous response had no tool calls. Re-attempt: invoke read_file, list_directory, or write_file directly." — gives the model one explicit second chance with the failure mode named. Single-shot per task: gated on `iterations === 0` so it can't loop.

- [ ] **Step 5.1: Write failing tests**

Append to `server/tests/agentic-execution-fixes.test.js`, in the same describe block as Fix #3:

```javascript
describe('Fix #1B — first-iteration validator', () => {
  // Same harness pattern as Fix #3.

  it('fires on iter 0 with text-only response > 50 chars', async () => {
    // Mock adapter:
    //   iter 0: response = { content: 'I will create the migration file by writing SQL...', tool_calls: [] }
    //   iter 0 RETRY: response = { content: '', tool_calls: [{name: 'write_file', arguments: {path: 'm.sql', content: 'CREATE TABLE...'}}] }
    //   iter 1: response = { content: 'Done.', tool_calls: [] }
    // Assert:
    //   - Adapter was called at least 2 times for the first iteration (validator triggered retry)
    //   - The 2nd call's messages array has a user message containing 'Your previous response had no tool calls'
    //   - finalOutput contains 'Done.' (task completes normally after the retry)
    expect(true).toBe(false); // placeholder; replaced in 5.3
  });

  it('does NOT fire when content < 50 chars (likely empty-ish, handled elsewhere)', async () => {
    // iter 0: { content: 'ok', tool_calls: [] } — short, validator skips, hits empty-summary retry instead.
    // Assert: messages do NOT contain 'Your previous response had no tool calls'.
    expect(true).toBe(false); // placeholder
  });

  it('does NOT fire when tool_calls is non-empty', async () => {
    // iter 0: { content: 'I will read foo.', tool_calls: [{name: 'read_file', ...}] }
    // Assert: validator did not fire (no corrective message in messages).
    expect(true).toBe(false); // placeholder
  });

  it('does NOT fire on iter > 0', async () => {
    // iter 0: tool_call (success)
    // iter 1: text-only (50+ chars) — final response, validator must NOT fire
    // Assert: messages do NOT contain 'Your previous response had no tool calls';
    //         loop terminates with that text as finalOutput.
    expect(true).toBe(false); // placeholder
  });

  it('fires at most once even if retry also produces text-only', async () => {
    // iter 0: { content: '... 100 chars of prose ...', tool_calls: [] }   → validator fires
    // iter 0 RETRY: { content: '... 100 chars of more prose ...', tool_calls: [] }   → validator must NOT fire again
    //   (loop falls through to normal handling, treats it as final response)
    // Assert:
    //   - Adapter called exactly 2 times total
    //   - messages contains exactly ONE 'Your previous response had no tool calls' user message
    expect(true).toBe(false); // placeholder
  });
});
```

- [ ] **Step 5.2: Run tests — verify they fail**

Run: `torque-remote npx vitest run server/tests/agentic-execution-fixes.test.js -t "Fix #1B"`
Expected: All 5 placeholders fail.

- [ ] **Step 5.3: Fill in test bodies using the existing harness**

Use the same mock-adapter pattern as Fix #3 (Task 3 Step 3.4). Replace each `expect(true).toBe(false)` with the assertions described in the per-test comments. The key knobs for the harness:
- Per-iteration response: `content` (string) and `tool_calls` (array).
- Captured `messages` array passed to the adapter on each call (this is what we inspect to verify the corrective user message was pushed).

- [ ] **Step 5.4: Run tests — verify they STILL fail (logic unchanged)**

Run: `torque-remote npx vitest run server/tests/agentic-execution-fixes.test.js -t "Fix #1B"`
Expected: At least the "fires on iter 0" test fails because no validator yet.

- [ ] **Step 5.5: Implement first-iter validator**

Open `server/providers/ollama-agentic.js`. Find the empty-content retry block (~line 425):

```javascript
      // Empty first response retry: if the very first iteration returns empty
      // (no content, no tool calls), retry once — some providers intermittently
      // return empty responses (cerebras observed at 50% rate)
      if (!content.trim() && toolLog.length === 0 && iterations === 0 && !emptySummaryRetried) {
        logger.info(`[Agentic] Empty first response (no content, no tools) — retrying`);
        emptySummaryRetried = true;
        continue; // retry without injecting extra messages
      }
```

Find the variable declarations near the top of the function (search for `let emptySummaryRetried = false;`). Add a sibling flag:

Run: `grep -n "emptySummaryRetried" server/providers/ollama-agentic.js`

Find the `let emptySummaryRetried = false;` line and add right after it:

```javascript
  let emptySummaryRetried = false;
  let firstIterValidatorFired = false; // Fix #1B: corrective reprompt for text-only iter-0 responses
```

Then in the body — DIRECTLY BEFORE the empty-content retry block (so the validator is checked when content IS present, and the empty retry is checked when content is NOT present) — insert:

```javascript
      // First-iteration text-only validator (Fix #1B).
      // Small models (qwen3-coder:30b) sometimes ignore the system prompt's
      // "tool calls only" rule and reply with prose + markdown code blocks on
      // iter 0. A single corrective reprompt names the failure mode and asks
      // for a tool call. Gated on iterations === 0 so it fires AT MOST once
      // per task. If the retry also produces text-only, control falls through
      // to the normal final-response handling.
      if (
        iterations === 0 &&
        !firstIterValidatorFired &&
        content.trim().length > 50
      ) {
        logger.info(`[Agentic] iter-0 produced text-only response (${content.length} chars) — sending corrective reprompt`);
        // Preserve the model's prose response in the conversation so the model
        // can see what it said and what we are responding to.
        messages.push({ role: 'assistant', content });
        messages.push({
          role: 'user',
          content: 'Your previous response had no tool calls — only text. Tool calls are the ONLY way to make progress. Re-attempt: invoke read_file, list_directory, or write_file directly using the structured tool-call mechanism. Do NOT write code or plans in the message body.',
        });
        firstIterValidatorFired = true;
        continue; // retry; do NOT increment iterations
      }
```

The order is important: validator fires when `content > 50` (model said something substantive but didn't tool-call); the empty-retry below fires when `content` is empty/whitespace. The two paths don't overlap.

- [ ] **Step 5.6: Run tests — verify they pass**

Run: `torque-remote npx vitest run server/tests/agentic-execution-fixes.test.js -t "Fix #1B"`
Expected: All 5 Fix #1B tests pass.

Also re-run the full agentic test suite to ensure no regression:

Run: `torque-remote npx vitest run server/tests/agentic-execution-fixes.test.js`
Expected: All tests pass (Fix #1B + Fix #3 + existing + updated 'after 3 iterations' test).

- [ ] **Step 5.7: Commit**

```bash
git add server/providers/ollama-agentic.js server/tests/agentic-execution-fixes.test.js
git commit -m "feat(ollama-agentic): first-iter validator nudges small models to tool_call instead of prose"
```

---

## Task 6: Integration test — composed scenarios

**Files:**
- Modify: `server/tests/agentic-execution-fixes.test.js` (extend)

**Why:** Each fix has unit tests. The composition needs end-to-end coverage so we know the layers work together — Few-shot system prompt + first-iter recovery + allowlist suggestion + relaxed early-stop in one mocked-loop run.

- [ ] **Step 6.1: Write the integration test**

Append to `server/tests/agentic-execution-fixes.test.js`:

```javascript
describe('Integration — small-model robustness composition', () => {
  it('Scenario A: markdown-then-recovery — model produces prose on iter 0, validator nudges, model tool_calls, completes', async () => {
    // Mock adapter sequence:
    //   call 1 (iter 0): { content: 'I\'ll create the migration. Here is the SQL:\n```sql\nCREATE TABLE x...\n```', tool_calls: [] }
    //   call 2 (iter 0 retry): { content: '', tool_calls: [{name: 'write_file', arguments: {path: 'm.sql', content: 'CREATE TABLE x (id INTEGER PRIMARY KEY);'}}] }
    //   call 3 (iter 1): { content: 'Done. Created m.sql with the table definition.', tool_calls: [] }
    // Mock executor: write_file succeeds.
    // Assert:
    //   - stopReason !== 'consecutive_tool_errors'
    //   - finalOutput contains 'Done.'
    //   - toolLog has exactly 1 entry (write_file at iteration 1)
    //   - messages contains the corrective user message
    expect(true).toBe(false); // placeholder; fill via 6.2
  });

  it('Scenario B: allowlist-recovery — model uses cat (rejected with suggestion), then read_file (success)', async () => {
    // Mock adapter:
    //   iter 0: { content: '', tool_calls: [{name: 'run_command', arguments: {command: 'cat src/foo.js'}}] }
    //   iter 1: { content: '', tool_calls: [{name: 'read_file', arguments: {path: 'src/foo.js'}}] }
    //   iter 2: { content: 'Read foo.js — it has 5 functions.', tool_calls: [] }
    // Mock executor: run_command rejects with _allowlist_rejection: true and suggestion 'use read_file'; read_file succeeds.
    // Assert:
    //   - stopReason !== 'consecutive_tool_errors'  (allowlist rejection didn't increment counter)
    //   - finalOutput contains 'Read foo.js'
    //   - The tool result message for the rejected call contains 'use read_file'
    expect(true).toBe(false); // placeholder
  });

  it('Scenario C: relaxed early-stop — 2 same-tool errors do NOT bail; 3rd error triggers stop', async () => {
    // Mock adapter:
    //   iter 0..2: { content: '', tool_calls: [{name: 'read_file', arguments: {path: `bad${i}.js`}}] }
    //   iter 3 (only reached if loop did NOT bail at 2): would-be summary
    // Mock executor: ENOENT for all read_file.
    // Assert:
    //   - stopReason === 'consecutive_tool_errors'
    //   - The 3rd error is what triggers it (counter hit 3, not 2)
    //   - At least 3 read_file errors recorded in toolLog
    expect(true).toBe(false); // placeholder
  });
});
```

- [ ] **Step 6.2: Fill in test bodies and run**

Use the harness pattern from Tasks 3 and 5. Replace each placeholder. Then:

Run: `torque-remote npx vitest run server/tests/agentic-execution-fixes.test.js -t "Integration — small-model robustness"`
Expected: All 3 integration scenarios pass.

- [ ] **Step 6.3: Commit**

```bash
git add server/tests/agentic-execution-fixes.test.js
git commit -m "test(ollama-agentic): integration scenarios for composed small-model robustness"
```

---

## Task 7: Full-suite verify on remote

**Files:** none modified.

**Why:** Catch any cross-test interaction with the threshold change or system-prompt change. The agentic test suite is large; running the entire server suite remotely is the cheapest safety check before considering the worktree mergeable.

- [ ] **Step 7.1: Run full agentic surface tests on remote**

Run:

```bash
torque-remote npx vitest run server/tests/agentic-execution-fixes.test.js server/tests/agentic-loop.test.js server/tests/agentic-tools.test.js server/tests/agentic-incomplete-task-nudge.test.js server/tests/agentic-truncation.test.js server/tests/ollama-agentic.test.js server/tests/ollama-tools-security.test.js server/tests/ollama-tools-coverage.test.js server/tests/build-agentic-system-prompt.test.js
```

Expected: All pass. If any fail, the most likely cause is a test that asserted on the old "after 2 iterations" wording or hard-coded the old threshold — fix the test (the production behavior is correct) and re-commit.

- [ ] **Step 7.2: Run full server suite on remote**

Run: `torque-remote npm --prefix server test`
Expected: At least no NEW failures introduced by this branch (compare to baseline failure list captured before the branch — see CLAUDE.md "remote pre-push gate is unstable" memory; pre-existing failures are not blockers).

If new failures appear, find their root cause before proceeding.

- [ ] **Step 7.3: No commit (verification only)**

If everything passes, proceed to Task 8.

---

## Task 8: Live smoke test against a known-failing task

**Files:** none modified.

**Why:** Unit tests use mocked adapters. We need at least one real-model run against qwen3-coder:30b to confirm the failure mode shifts from "zero tool calls" to "tool calls + actual progress." Pick a representative failure from today's logs.

- [ ] **Step 8.1: Identify a smoke-test target**

Today's logs included task `8bce19bb` ("annotation queues feature"). Run:

```bash
sqlite3 server/data/torque.db "SELECT id, description FROM tasks WHERE id LIKE '8bce19bb%' LIMIT 1;"
```

Capture the full description for re-submission. If the task is gone from the DB, pick any of the 25 failed tasks from 2026-04-27 that ran on local Ollama with `tool_calls=[]`:

```bash
sqlite3 server/data/torque.db "SELECT id, description FROM tasks WHERE provider='ollama' AND status='failed' AND DATE(created_at) = '2026-04-27' LIMIT 1;"
```

- [ ] **Step 8.2: Submit a re-run on the worktree code**

The worktree must be running the new code. From the worktree root:

```bash
# Ensure the worktree's code is what's running. If TORQUE is on main, restart on the worktree.
# This is intentionally not automated — the user will decide whether to cut over now or after merge.
```

Submit via MCP:

```
smart_submit_task({
  description: '<paste the failing task description verbatim>',
  provider: 'ollama',
  model: 'qwen3-coder:30b',
  metadata: { smoke_test: 'ollama-agentic-robustness' }
})
```

Then `await_task` with a 15-minute timeout.

- [ ] **Step 8.3: Inspect the result**

Success criterion is NOT 100% task completion — qwen3-coder:30b has real capability ceilings. The criterion is: **failure mode shifts from "tool_calls=[]" to "tool_calls > 0 + actual file changes."**

Check:

```bash
sqlite3 server/data/torque.db "SELECT id, status, tool_calls FROM tasks WHERE id = '<smoke-test-id>';"
```

If `tool_calls > 0`, the model engaged tools — the bottleneck moved. If status is `success`, even better. Record the result in the commit message of Task 9.

- [ ] **Step 8.4: No commit (verification only)**

---

## Task 9: Rollout note — update worktree CLAUDE memory and prep for cutover

**Files:**
- Optional: `docs/superpowers/specs/2026-04-27-ollama-agentic-loop-robustness-design.md` — append "Status: Implemented" line.

**Why:** The user runs cutovers manually. This task captures the verification result and rollout readiness inline so the cutover commit message can reference it.

- [ ] **Step 9.1: Update spec status line**

Open `docs/superpowers/specs/2026-04-27-ollama-agentic-loop-robustness-design.md`. Find the front-matter line:

```markdown
**Status:** Draft (brainstorming approved, awaiting user spec review)
```

Replace with:

```markdown
**Status:** Implemented on `feat/ollama-agentic-robustness` — pending cutover to main.
```

- [ ] **Step 9.2: Final commit**

```bash
git add docs/superpowers/specs/2026-04-27-ollama-agentic-loop-robustness-design.md
git commit -m "docs(ollama-agentic): mark spec status implemented, ready for cutover"
```

- [ ] **Step 9.3: Verify the worktree's commit graph**

Run: `git log --oneline main..HEAD`
Expected: ~7 commits in this order (Tasks 1, 2, 3, 4, 5, 6, 9; Tasks 7 and 8 don't commit):

```
docs(ollama-agentic): mark spec status implemented, ready for cutover
test(ollama-agentic): integration scenarios for composed small-model robustness
feat(ollama-agentic): first-iter validator nudges small models to tool_call instead of prose
feat(execution): few-shot example in agentic system prompt for small-model tool engagement
feat(ollama-agentic): bump consecutive-error threshold 2→3 and skip allowlist rejections
feat(ollama-tools): suggest built-in tool on allowlist rejection + add _allowlist_rejection marker
feat(ollama-tools): always allow safe read-only PS cmdlets in run_command
```

The cutover happens via `scripts/worktree-cutover.sh ollama-agentic-robustness` — that's outside the plan; the user runs it.

---

## Summary

7 commits, 5 production code changes, 3 test files (1 new, 2 extended), no schema changes, no new dependencies. Each commit can be reverted independently if a regression surfaces.

**Production change surfaces:**
- `server/providers/ollama-tools.js` — `isCommandAllowed` (always-allowed cmdlets) + `run_command` rejection branch (suggestion + marker)
- `server/providers/ollama-agentic.js` — consecutive-error block (skip on marker, threshold 3) + first-iter validator
- `server/providers/execution.js` — `buildAgenticSystemPrompt` (few-shot block, also exported for testing)
