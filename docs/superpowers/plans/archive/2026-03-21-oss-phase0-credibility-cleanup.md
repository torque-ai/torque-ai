# OSS Phase 0: Credibility Cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove all hardcoded personal data, orphaned artifacts, and structural oddities from the codebase so it looks intentionally designed for open-source review.

**Architecture:** No architectural changes. Pure search-and-replace cleanup across source files, test files, tool definitions, and documentation. Every change is a text replacement — no logic changes.

**Tech Stack:** Node.js, Vitest, Git

**Spec:** `docs/superpowers/specs/2026-03-21-oss-architecture-design.md` — Phase 0 section

**Tests:** Run via `torque-remote npx vitest run` (routes to remote workstation). For targeted runs: `torque-remote npx vitest run server/tests/<file>`.

---

### Task 1: Remove hardcoded personal paths from benchmark scripts

These are integration test scripts (not part of the test suite) that hardcode the developer's Windows paths and personal Ollama host IP.

**Files:**
- Modify: `server/tests/baseline-runner.js:3,16,96,114`
- Modify: `server/tests/baseline-all-models.js:3,15,131-132`

- [ ] **Step 1: Fix baseline-runner.js**

Replace the hardcoded `TORQUE_DATA_DIR` and working directory:

```js
// Line 3: Replace hardcoded path with env var
// OLD: process.env.TORQUE_DATA_DIR = '/path/to/torque-data';
// NEW:
process.env.TORQUE_DATA_DIR = process.env.TORQUE_DATA_DIR || path.join(os.tmpdir(), 'torque-baseline-test');
```

Add `path` and `os` requires at top if not present:
```js
const path = require('path');
const os = require('os');
```

```js
// Line 16: Replace hardcoded working directory
// OLD: const WD = '/path/to/project';
// NEW:
const WD = process.env.BASELINE_WORKING_DIR || process.cwd();
```

```js
// Line 96: Replace hardcoded Ollama host
// OLD: host: 'http://192.0.2.100:11434', model: 'qwen2.5-coder:32b',
// NEW:
host: process.env.OLLAMA_HOST || 'http://localhost:11434', model: process.env.OLLAMA_MODEL || 'qwen2.5-coder:32b',
```

```js
// Line 114: Replace hardcoded fallback host
// OLD: options: { host: 'http://192.0.2.100:11434', model: 'codestral:22b' },
// NEW:
options: { host: process.env.OLLAMA_HOST || 'http://localhost:11434', model: 'codestral:22b' },
```

- [ ] **Step 2: Fix baseline-all-models.js**

Same pattern — replace hardcoded paths and IPs:

```js
// Line 3: Replace hardcoded path
// OLD: process.env.TORQUE_DATA_DIR = '/path/to/torque-data';
// NEW:
process.env.TORQUE_DATA_DIR = process.env.TORQUE_DATA_DIR || path.join(os.tmpdir(), 'torque-baseline-test');
```

Add `path` and `os` requires at top if not present.

```js
// Line 15: Replace hardcoded working directory
// OLD: const WD = '/path/to/project';
// NEW:
const WD = process.env.BASELINE_WORKING_DIR || process.cwd();
```

```js
// Lines 131-132: Replace hardcoded Ollama hosts
// OLD: await test('local / qwen2.5-coder:32b', ollamaAdapter, { host: 'http://192.0.2.100:11434', model: 'qwen2.5-coder:32b' });
// NEW:
const ollamaHost = process.env.OLLAMA_HOST || 'http://localhost:11434';
await test('local / qwen2.5-coder:32b', ollamaAdapter, { host: ollamaHost, model: 'qwen2.5-coder:32b' });

// OLD: await test('local / codestral:22b (prompt-inj)', ollamaAdapter, { host: 'http://192.0.2.100:11434', model: 'codestral:22b' }, { promptInjected: true });
// NEW:
await test('local / codestral:22b (prompt-inj)', ollamaAdapter, { host: ollamaHost, model: 'codestral:22b' }, { promptInjected: true });
```

- [ ] **Step 3: Verify no remaining personal paths**

Run: `grep -rn "C:/Users" server/tests/baseline-runner.js server/tests/baseline-all-models.js`
Expected: No matches

- [ ] **Step 4: Commit**

```bash
git add server/tests/baseline-runner.js server/tests/baseline-all-models.js
git commit -m "fix: remove hardcoded personal paths from benchmark scripts"
```

---

### Task 2: Remove personal infrastructure references from agentic integration test

This test file defaults to a personal Ollama host IP and references a personal machine name.

**Files:**
- Modify: `server/tests/agentic-integration.test.js:5,26,33,92,97`

- [ ] **Step 1: Fix the file header comment**

```js
// Line 5: Remove machine name reference
// OLD: *   1. Live Ollama Integration — skipped if remote-gpu-host is unreachable
// NEW:
//   1. Live Ollama Integration — skipped if the configured Ollama host is unreachable
```

- [ ] **Step 2: Fix normaliseOllamaHost function**

```js
// Line 26: Fix JSDoc example
// OLD: * Handles bare IPs/hostnames (e.g. "0.0.0.0", "192.0.2.100") by prepending "http://".
// NEW:
// * Handles bare IPs/hostnames (e.g. "0.0.0.0", "10.0.0.5") by prepending "http://".

// Line 33: Fix default fallback
// OLD: if (!raw) return 'http://192.0.2.100:11434';
// NEW:
if (!raw) return 'http://localhost:11434';
```

- [ ] **Step 3: Fix the live test section**

```js
// Line 92: Fix comment
// OLD: // Use AGENTIC_TEST_OLLAMA_HOST to target remote-gpu-host specifically.
// NEW:
// Use AGENTIC_TEST_OLLAMA_HOST to target a specific Ollama host.

// Line 97: Fix default
// OLD: || 'http://192.0.2.100:11434';
// NEW:
|| 'http://localhost:11434';
```

- [ ] **Step 4: Verify no remaining personal references**

Run: `grep -rn "192.0.2.100\|remote-gpu-host" server/tests/agentic-integration.test.js`
Expected: No matches

- [ ] **Step 5: Commit**

```bash
git add server/tests/agentic-integration.test.js
git commit -m "fix: remove personal infrastructure references from agentic integration test"
```

---

### Task 3: Remove personal username from PID heartbeat test

One test fixture hardcodes a developer's username in a simulated `wmic` output.

**Files:**
- Modify: `server/tests/pid-heartbeat.test.js:155`

- [ ] **Step 1: Replace personal username**

```js
// Line 155:
// OLD: if (cmd === 'wmic') return 'CommandLine=node /path/to/torque/server/index.js';
// NEW:
if (cmd === 'wmic') return 'CommandLine=node /opt/torque/server/index.js';
```

- [ ] **Step 2: Verify no remaining personal references**

Run: `grep -rn "personal-data" server/tests/pid-heartbeat.test.js`
Expected: No matches

- [ ] **Step 3: Run the specific test to confirm it still passes**

Run: `torque-remote npx vitest run server/tests/pid-heartbeat.test.js`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add server/tests/pid-heartbeat.test.js
git commit -m "fix: remove personal username from PID heartbeat test fixture"
```

---

### Task 4: Replace private network IPs with RFC 5737 documentation IPs in source files

Source files (not tests) use `192.168.1.100` and `192.168.1.50` as example IPs in help text, JSDoc, and tool definitions. Replace with `192.0.2.100` (RFC 5737 TEST-NET-1 range, reserved for documentation).

**Files:**
- Modify: `server/handlers/provider-ollama-hosts.js:273,445`
- Modify: `server/handlers/shared.js:767`
- Modify: `server/benchmark.js:669`
- Modify: `server/tool-defs/provider-defs.js:217,799,1035`
- Modify: `server/tool-defs/snapscope-defs.js:817`
- Modify: `server/tool-defs/remote-agent-defs.js:18`

- [ ] **Step 1: Fix provider-ollama-hosts.js (2 occurrences)**

```js
// Lines 273 and 445: Replace example IP in help text
// OLD: add_ollama_host id="remote" name="Remote 3090" url="http://192.168.1.100:11434"
// NEW:
// add_ollama_host id="remote" name="Remote 3090" url="http://192.0.2.100:11434"
```

Use replace_all for `192.168.1.100` → `192.0.2.100` in this file.

- [ ] **Step 2: Fix handlers/shared.js (1 occurrence)**

```js
// Line 767: JSDoc comment
// OLD: * @param {string} hostUrl - Base URL of the Ollama host (e.g., "http://192.168.1.100:11434")
// NEW:
// * @param {string} hostUrl - Base URL of the Ollama host (e.g., "http://192.0.2.100:11434")
```

- [ ] **Step 3: Fix benchmark.js (1 occurrence)**

```js
// Line 669: Usage text
// OLD: node benchmark.js --host=http://192.168.1.100:11434 --full
// NEW:
// node benchmark.js --host=http://192.0.2.100:11434 --full
```

- [ ] **Step 4: Fix tool-defs/provider-defs.js (3 occurrences)**

Use replace_all for `192.168.1.100` → `192.0.2.100` in this file.

```js
// Lines 217, 799, 1035: Tool parameter descriptions
// OLD: "http://192.168.1.100:11434"
// NEW: "http://192.0.2.100:11434"
```

- [ ] **Step 5: Fix tool-defs/snapscope-defs.js (1 occurrence)**

```js
// Line 817:
// OLD: "http://192.168.1.100:9876"
// NEW: "http://192.0.2.100:9876"
```

- [ ] **Step 6: Fix tool-defs/remote-agent-defs.js (1 occurrence)**

```js
// Line 18:
// OLD: 'Hostname or IP address of the remote agent (e.g., "192.168.1.50")'
// NEW:
'Hostname or IP address of the remote agent (e.g., "192.0.2.50")'
```

- [ ] **Step 7: Verify no remaining private IPs in source (non-test) files**

Run: `grep -rn "192\.168\." server/handlers/ server/tool-defs/ server/benchmark.js | grep -v node_modules`
Expected: No matches

- [ ] **Step 8: Commit**

```bash
git add server/handlers/provider-ollama-hosts.js server/handlers/shared.js server/benchmark.js server/tool-defs/provider-defs.js server/tool-defs/snapscope-defs.js server/tool-defs/remote-agent-defs.js
git commit -m "fix: replace private network IPs with RFC 5737 documentation range in source files"
```

---

### Task 5: Replace private network IPs in documentation guides

`server/docs/guides/multi-host.md` uses private IPs as examples. Replace with RFC 5737 range.

**Files:**
- Modify: `server/docs/guides/multi-host.md`

- [ ] **Step 1: Replace all private IPs**

Use replace_all:
- `192.168.1.50` → `192.0.2.50`
- `192.168.1.51` → `192.0.2.51`
- `192.168.1.0/24` → `192.0.2.0/24`
- `"192.168.1"` → `"192.0.2"`

- [ ] **Step 2: Verify**

Run: `grep -n "192\.168\." server/docs/guides/multi-host.md`
Expected: No matches

- [ ] **Step 3: Check other docs guides for private IPs**

Run: `grep -rn "192\.168\." server/docs/`
Expected: No matches

- [ ] **Step 4: Commit**

```bash
git add server/docs/
git commit -m "docs: replace private network IPs with RFC 5737 range in guides"
```

---

### Task 6: Replace private network IPs in test fixture data

Test files use `192.168.1.100` and `192.168.1.50` as fixture data for mock hosts and API tests. While these aren't personal infrastructure leaks, using RFC 5737 IPs makes the test intent clearer and avoids confusion with real network addresses.

**Files (all in `server/tests/`):**
- Modify: `api-server-core.test.js` (1 occurrence: line 874)
- Modify: `api-server.test.js` (1 occurrence: line 2729)
- Modify: `api-key-rate-limit.test.js` (1 occurrence: line 194)
- Modify: `aider-command.test.js` (5 occurrences: lines 341,347,353,362,465)
- Modify: `host-management.test.js`, `provider-handlers-hosts.test.js`, `provider-tuning.test.js`
- Modify: `provider-ollama-strategic.test.js`, `host-credentials.test.js`
- Modify: `orchestrator-integration.test.js`, `smart-diagnosis-stage.test.js`
- Modify: `exp4-exp5-pipeline-integration.test.js`
- Modify: `remote/agent-registry.test.js`, `remote/remote-agent-handlers.test.js`
- Modify: `provider-ollama-hosts.test.js`

- [ ] **Step 1: Bulk replace `192.168.1.100` → `192.0.2.100` across all test files**

For each file, use replace_all to change `192.168.1.100` to `192.0.2.100`.

- [ ] **Step 2: Bulk replace `192.168.1.50` → `192.0.2.50` across all test files**

For each file, use replace_all to change `192.168.1.50` to `192.0.2.50`.

- [ ] **Step 3: Verify no remaining private IPs in test files**

Run: `grep -rn "192\.168\." server/tests/ | grep -v node_modules | grep -v "192\.168\.254\.254"`
Expected: No matches. (`192.168.254.254` is a deliberately-synthetic unreachable IP used for timeout testing — leave it as-is.)

- [ ] **Step 4: Run the full test suite to confirm nothing broke**

Run: `torque-remote npx vitest run`
Expected: All tests pass. These are pure string replacements in fixture data — no logic changes.

- [ ] **Step 5: Commit**

```bash
git add server/tests/
git commit -m "fix: replace private network IPs with RFC 5737 documentation range in test fixtures"
```

---

### Task 7: Delete orphaned directories and stale artifacts

Clean up structural oddities that would confuse an open-source contributor.

**Files:**
- Delete: `server/server/tests/` (empty orphaned directory)
- Delete: `server/tmp-peek-capture-rndOvK/` (stale temp directory)
- Move or delete: `apply_safeparse.py` (one-off migration script at project root)
- Modify: `.gitignore`

- [ ] **Step 1: Delete orphaned server/server/tests/ directory**

```bash
rm -rf server/server/tests/
```

Check if `server/server/` is now empty. If so, delete it too:
```bash
rmdir server/server/ 2>/dev/null || true
```

- [ ] **Step 2: Delete stale temp directory**

```bash
rm -rf server/tmp-peek-capture-rndOvK/
```

- [ ] **Step 3: Remove apply_safeparse.py**

This is a one-off Python migration script at the project root. It's not referenced by any code and doesn't belong in an OSS repo.

```bash
rm apply_safeparse.py
```

- [ ] **Step 4: Add .gitignore patterns**

Add to `.gitignore` under the `# Stray artifacts` section:

```
# Stale temp directories
server/tmp-*/
```

- [ ] **Step 5: Verify cleanup**

```bash
# Confirm orphaned dirs are gone
ls server/server/ 2>/dev/null && echo "STILL EXISTS" || echo "CLEANED"
ls server/tmp-peek-capture-rndOvK/ 2>/dev/null && echo "STILL EXISTS" || echo "CLEANED"
ls apply_safeparse.py 2>/dev/null && echo "STILL EXISTS" || echo "CLEANED"
```

Expected: All three print "CLEANED"

- [ ] **Step 6: Commit**

```bash
git add -A .gitignore
git rm -r --cached server/server/ 2>/dev/null || true
git rm -r --cached server/tmp-peek-capture-rndOvK/ 2>/dev/null || true
git rm apply_safeparse.py 2>/dev/null || true
git commit -m "chore: remove orphaned directories and stale artifacts"
```

---

### Task 8: Scrub personal paths from documentation files

34 files in `docs/superpowers/` contain personal paths from development specs and plans. Replace with generic paths so the docs read as proper OSS documentation.

**Files:** All 34 files listed by `grep -rn "personal-data\|C:/Users" docs/superpowers/`

- [ ] **Step 1: Bulk replace personal paths**

For each file in `docs/superpowers/`, apply these replacements:

| Pattern | Replacement |
|---------|------------|
| `/path/to/torque` | `/path/to/torque` |
| `/path/to/torque-data` | `/path/to/torque-data` |
| `/path/to/torque` | `/path/to/torque` |
| `/path/to/project` | `/path/to/project` |
| `/path/to/deluge` | `/path/to/deluge` |
| `/path/to/headwaters` | `/path/to/headwaters` |
| `/path/to/` | `/path/to/` |
| `C:\\Users\\<user>\\Projects\\` | `/path/to/` |
| `remote-gpu-host` | `remote-gpu-host` |
| `user@remote-gpu-host` | `user@remote-gpu-host` |
| `192.0.2.100` | `192.0.2.100` |

Use `sed` or the Edit tool with replace_all for each file.

**Note:** This plan file and the OSS spec file are among the 34 files with personal paths. The paths appear in code examples and tables showing OLD→NEW changes. Scrubbing them is fine — the examples remain readable with generic paths. Do NOT skip this plan file from the scrub.

- [ ] **Step 2: Verify no remaining personal references in docs**

Run: `grep -rn "personal-data\|C:/Users" docs/superpowers/`
Expected: No matches (the newly created OSS spec may reference these patterns in tables — verify those are in the "fix" column, not as live values)

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/
git commit -m "docs: scrub personal paths and machine names from specs and plans"
```

---

### Task 9: Final verification and summary commit

- [ ] **Step 1: Full grep for any remaining personal data**

```bash
# Check for personal username
grep -rn "personal-username" --include="*.js" --include="*.md" --include="*.json" . | grep -v node_modules | grep -v .git/ | grep -v CLAUDE.md | grep -v MEMORY.md | grep -v memory/

# Check for personal machine names
grep -rn "user\|remote-gpu-host" --include="*.js" --include="*.md" . | grep -v node_modules | grep -v .git/ | grep -v CLAUDE.md | grep -v MEMORY.md | grep -v memory/

# Check for personal infrastructure IP
grep -rn "192\.168\.1\.183" --include="*.js" --include="*.md" . | grep -v node_modules | grep -v .git/

# Check for any remaining private IPs in source (non-test)
grep -rn "192\.168\." server/handlers/ server/tool-defs/ server/benchmark.js server/providers/ server/*.js | grep -v node_modules
```

Expected: No matches for any of the above (CLAUDE.md and memory files are excluded — they're user-private config, not shipped code)

- [ ] **Step 2: Run the full test suite**

Run: `torque-remote npx vitest run`
Expected: All tests pass. Phase 0 changes are purely cosmetic text replacements — no logic was modified.

- [ ] **Step 3: Verify git status is clean**

```bash
git status
```

Expected: Clean working tree, no untracked files.
