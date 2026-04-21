# edit_file Fuzzy Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `edit_file`'s exact match fails, recover via whitespace-normalized and fuzzy matching so free LLMs don't waste iterations on indentation mismatches.

**Architecture:** Two helper functions (`findWhitespaceNormalizedMatch`, `findFuzzyMatch`) added to `ollama-tools.js`, called as fallbacks from the `edit_file` case. A shared `reindentNewText` function handles prefix-replacement re-indentation. `lineSimilarity` imported from `hashline-parser.js` for the fuzzy tier.

**Tech Stack:** Node.js, vitest, existing `lineSimilarity` from `server/utils/hashline-parser.js`

**Spec:** `docs/superpowers/specs/2026-03-18-edit-file-fuzzy-matching-design.md`

---

### Task 1: Re-indentation helper + tests (TDD)

**Files:**
- Modify: `server/providers/ollama-tools.js` (add `reindentNewText` function near top, before `execute`)
- Create: `server/tests/ollama-tools-edit-fuzzy.test.js`

This function is used by both Tier 1 and Tier 2, so build it first.

- [x] **Step 1: Write failing tests for `reindentNewText`**

Create `server/tests/ollama-tools-edit-fuzzy.test.js`:

```js
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { reindentNewText } = require('../providers/ollama-tools');

let tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-fuzzy-edit-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  tempDirs = [];
});

describe('reindentNewText', () => {
  it('shifts new_text from 0 indent to 4-space indent', () => {
    const result = reindentNewText('if (x) {\n  y();\n}', '    ');
    expect(result).toBe('    if (x) {\n      y();\n    }');
  });

  it('shifts new_text from 2-space to 4-space indent', () => {
    const result = reindentNewText('  if (x) {\n    y();\n  }', '    ');
    expect(result).toBe('    if (x) {\n      y();\n    }');
  });

  it('strips indent when file has less than new_text', () => {
    const result = reindentNewText('    if (x) {\n      y();\n    }', '  ');
    expect(result).toBe('  if (x) {\n    y();\n  }');
  });

  it('handles tabs in file indent, spaces in new_text', () => {
    const result = reindentNewText('  if (x) {\n    y();\n  }', '\t');
    expect(result).toBe('\tif (x) {\n\t  y();\n\t}');
  });

  it('preserves blank lines unchanged', () => {
    const result = reindentNewText('if (x) {\n\n  y();\n}', '    ');
    expect(result).toBe('    if (x) {\n\n      y();\n    }');
  });

  it('returns single-line text with file indent', () => {
    const result = reindentNewText('doThing();', '    ');
    expect(result).toBe('    doThing();');
  });

  it('no-ops when indents already match', () => {
    const result = reindentNewText('    if (x) {\n      y();\n    }', '    ');
    expect(result).toBe('    if (x) {\n      y();\n    }');
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/ollama-tools-edit-fuzzy.test.js -t "reindentNewText"`
Expected: FAIL with `reindentNewText` is not exported

- [x] **Step 3: Implement `reindentNewText` in ollama-tools.js**

Add near the top of the file (after the `require` block, before `const TOOL_DEFINITIONS`):

```js
/**
 * Re-indent new_text to match the file's indentation at the match point.
 * Uses prefix-replacement (not character-count delta) to handle mixed tabs/spaces.
 * @param {string} newText - The replacement text
 * @param {string} fileIndent - Leading whitespace of the matched region's first non-blank line
 * @returns {string} Re-indented text
 */
function reindentNewText(newText, fileIndent) {
  const lines = newText.split('\n');
  // Find the indentation of new_text's first non-blank line
  const firstNonBlank = lines.find(l => l.trim().length > 0);
  if (!firstNonBlank) return newText;
  const newIndent = firstNonBlank.match(/^(\s*)/)[1];

  if (newIndent === fileIndent) return newText;

  return lines.map(line => {
    if (!line.trim()) return line; // preserve blank lines
    if (line.startsWith(newIndent)) {
      return fileIndent + line.slice(newIndent.length);
    }
    // Line has less indent than newIndent (e.g., closing brace at outer level)
    // Replace as much of the common prefix as exists
    const lineIndent = line.match(/^(\s*)/)[1];
    const common = Math.min(lineIndent.length, newIndent.length);
    return fileIndent + line.slice(common);
  }).join('\n');
}
```

Export it from `module.exports` at the bottom of the file.

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/ollama-tools-edit-fuzzy.test.js -t "reindentNewText"`
Expected: PASS (all 7 tests)

- [x] **Step 5: Commit**

```
git add server/providers/ollama-tools.js server/tests/ollama-tools-edit-fuzzy.test.js
git commit -m "feat(edit_file): add reindentNewText helper for fuzzy matching"
```

---

### Task 2: Whitespace-normalized matching (Tier 1) + tests (TDD)

**Files:**
- Modify: `server/providers/ollama-tools.js` (add `findWhitespaceNormalizedMatch` function, wire into `edit_file` case)
- Modify: `server/tests/ollama-tools-edit-fuzzy.test.js`

- [x] **Step 1: Write failing tests for whitespace-normalized matching**

Append to `server/tests/ollama-tools-edit-fuzzy.test.js`:

```js
const { createToolExecutor } = require('../providers/ollama-tools');

function writeFile(dir, name, content) {
  const full = path.join(dir, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
  return full;
}

describe('edit_file whitespace-normalized fallback', () => {
  it('matches when old_text has wrong indentation', () => {
    const dir = makeTempDir();
    writeFile(dir, 'app.js', '    if (x) {\n      doThing();\n    }');
    const { execute: exec } = createToolExecutor(dir);
    // old_text has 2-space indent, file has 4-space
    const result = exec('edit_file', {
      path: 'app.js',
      old_text: '  if (x) {\n    doThing();\n  }',
      new_text: '  if (y) {\n    doOther();\n  }',
    });
    expect(result.error).toBeFalsy();
    expect(result.result).toContain('matched with normalized whitespace');
    // new_text should be re-indented to 4-space
    const written = fs.readFileSync(path.join(dir, 'app.js'), 'utf-8');
    expect(written).toBe('    if (y) {\n      doOther();\n    }');
  });

  it('rejects when normalized form matches multiple locations', () => {
    const dir = makeTempDir();
    // Same code at two different indent levels
    writeFile(dir, 'dup.js', '  doThing();\n\n    doThing();');
    const { execute: exec } = createToolExecutor(dir);
    const result = exec('edit_file', {
      path: 'dup.js',
      old_text: 'doThing();',  // no indent — matches both after normalization
      new_text: 'doOther();',
    });
    expect(result.error).toBe(true);
    expect(result.result).toContain('multiple');
  });

  it('exact match still preferred over whitespace fallback', () => {
    const dir = makeTempDir();
    writeFile(dir, 'exact.js', '  foo();\n    foo();');
    const { execute: exec } = createToolExecutor(dir);
    // Exact match for the 2-space version
    const result = exec('edit_file', {
      path: 'exact.js',
      old_text: '  foo();',
      new_text: '  bar();',
    });
    expect(result.error).toBeFalsy();
    expect(result.result).not.toContain('normalized');
    const written = fs.readFileSync(path.join(dir, 'exact.js'), 'utf-8');
    expect(written).toBe('  bar();\n    foo();');
  });

  it('handles tabs in file, spaces in old_text', () => {
    const dir = makeTempDir();
    writeFile(dir, 'tabs.js', '\tif (x) {\n\t\ty();\n\t}');
    const { execute: exec } = createToolExecutor(dir);
    const result = exec('edit_file', {
      path: 'tabs.js',
      old_text: '  if (x) {\n    y();\n  }',
      new_text: '  if (z) {\n    w();\n  }',
    });
    expect(result.error).toBeFalsy();
    expect(result.result).toContain('normalized whitespace');
    const written = fs.readFileSync(path.join(dir, 'tabs.js'), 'utf-8');
    expect(written).toBe('\tif (z) {\n\t\tw();\n\t}');
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/ollama-tools-edit-fuzzy.test.js -t "whitespace-normalized"`
Expected: FAIL — edits return "old_text not found" errors

- [x] **Step 3: Implement `findWhitespaceNormalizedMatch` and wire into edit_file**

Add function near `reindentNewText`:

```js
/**
 * Find a whitespace-normalized match for old_text in file content.
 * Strips leading whitespace from each line before comparing.
 * Returns { startLine, lineCount, fileIndent } or null.
 * Throws if multiple matches found.
 */
function findWhitespaceNormalizedMatch(oldText, fileContent) {
  const oldLines = oldText.split('\n').map(l => l.trimStart());
  const fileLines = fileContent.split('\n');
  const normalizedFileLines = fileLines.map(l => l.trimStart());

  const matches = [];
  for (let i = 0; i <= normalizedFileLines.length - oldLines.length; i++) {
    let matched = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (normalizedFileLines[i + j] !== oldLines[j]) {
        matched = false;
        break;
      }
    }
    if (matched) matches.push(i);
  }

  if (matches.length === 0) return null;
  if (matches.length > 1) {
    const err = new Error('multiple_normalized_matches');
    err.code = 'MULTIPLE_MATCHES';
    throw err;
  }

  const startLine = matches[0];
  // Indentation of first non-blank line in the matched file region
  const firstNonBlank = fileLines.slice(startLine, startLine + oldLines.length)
    .find(l => l.trim().length > 0);
  const fileIndent = firstNonBlank ? firstNonBlank.match(/^(\s*)/)[1] : '';

  return { startLine, lineCount: oldLines.length, fileIndent };
}
```

Then modify the `edit_file` single-match branch. Replace the `if (idx === -1) { ... }` block that returns the "old_text not found" error with:

```js
            if (idx === -1) {
              // Tier 1: whitespace-normalized fallback
              try {
                const wsMatch = findWhitespaceNormalizedMatch(args.old_text, content);
                if (wsMatch) {
                  const fileLines = content.split('\n');
                  const reindented = reindentNewText(args.new_text, wsMatch.fileIndent);
                  const before = fileLines.slice(0, wsMatch.startLine);
                  const after = fileLines.slice(wsMatch.startLine + wsMatch.lineCount);
                  const newContent = [...before, ...reindented.split('\n'), ...after].join('\n');
                  fs.writeFileSync(resolvedPath, newContent, 'utf-8');
                  changedFiles.add(resolvedPath);
                  return {
                    result: `Edit applied to ${args.path} (matched with normalized whitespace)`,
                  };
                }
              } catch (wsErr) {
                if (wsErr.code === 'MULTIPLE_MATCHES') {
                  return {
                    result: `Error: old_text matches multiple locations in ${args.path} after whitespace normalization. Provide more surrounding context to make the match unique.`,
                    error: true,
                  };
                }
              }

              // TODO: Tier 2 fuzzy matching (Task 3)

              const lines = content.split('\n');
              const preview = lines.slice(0, Math.min(30, lines.length)).join('\n');
              return {
                result: `Error: old_text not found in ${args.path}. Include more context or check indentation. First 30 lines:\n${preview}`,
                error: true,
              };
            }
```

Also wire the whitespace fallback into the `replace_all` path. Replace the `if (occurrences === 0) { ... }` block that returns the "old_text not found" error with:

```js
            if (occurrences === 0) {
              // Whitespace-normalized fallback for replace_all
              try {
                const wsMatch = findWhitespaceNormalizedMatch(args.old_text, content);
                if (wsMatch) {
                  // Found at least one normalized match — do a normalized replace_all
                  const oldLines = args.old_text.split('\n').map(l => l.trimStart());
                  const fileLines = content.split('\n');
                  const normalizedFileLines = fileLines.map(l => l.trimStart());
                  let replacements = 0;
                  const resultLines = [];
                  let i = 0;
                  while (i < fileLines.length) {
                    let matched = true;
                    if (i <= fileLines.length - oldLines.length) {
                      for (let j = 0; j < oldLines.length; j++) {
                        if (normalizedFileLines[i + j] !== oldLines[j]) {
                          matched = false;
                          break;
                        }
                      }
                    } else {
                      matched = false;
                    }
                    if (matched) {
                      const firstNonBlank = fileLines.slice(i, i + oldLines.length).find(l => l.trim().length > 0);
                      const indent = firstNonBlank ? firstNonBlank.match(/^(\s*)/)[1] : '';
                      resultLines.push(...reindentNewText(args.new_text, indent).split('\n'));
                      i += oldLines.length;
                      replacements++;
                    } else {
                      resultLines.push(fileLines[i]);
                      i++;
                    }
                  }
                  if (replacements > 0) {
                    fs.writeFileSync(resolvedPath, resultLines.join('\n'), 'utf-8');
                    changedFiles.add(resolvedPath);
                    return {
                      result: `Edit applied to ${args.path} (${replacements} replacement${replacements !== 1 ? 's' : ''}, matched with normalized whitespace)`,
                      metadata: { replacements },
                    };
                  }
                }
              } catch { /* fall through to error */ }

              const lines = content.split('\n');
              const preview = lines.slice(0, Math.min(30, lines.length)).join('\n');
              return {
                result: `Error: old_text not found in ${args.path}. First 30 lines:\n${preview}`,
                error: true,
              };
            }
```

Export `findWhitespaceNormalizedMatch` from `module.exports`.

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/ollama-tools-edit-fuzzy.test.js -t "whitespace-normalized"`
Expected: PASS (all 4 tests)

- [x] **Step 5: Run existing tests to verify no regressions**

Run: `npx vitest run tests/ollama-tools-coverage.test.js tests/agentic-tools.test.js`
Expected: PASS (all existing edit_file tests still pass — exact matching is unchanged)

- [x] **Step 6: Commit**

```
git add server/providers/ollama-tools.js server/tests/ollama-tools-edit-fuzzy.test.js
git commit -m "feat(edit_file): Tier 1 whitespace-normalized fallback matching"
```

---

### Task 3: Fuzzy matching (Tier 2) + tests (TDD)

**Files:**
- Modify: `server/providers/ollama-tools.js` (add `findFuzzyMatch` function, wire into `edit_file` case)
- Modify: `server/tests/ollama-tools-edit-fuzzy.test.js`

- [ ] **Step 1: Write failing tests for fuzzy matching**

Append to test file:

```js
describe('edit_file fuzzy fallback (Tier 2)', () => {
  it('matches near-miss content (variable name typo)', () => {
    const dir = makeTempDir();
    writeFile(dir, 'src.js', '    const userName = getData();\n    process(userName);');
    const { execute: exec } = createToolExecutor(dir);
    // old_text has "username" not "userName" — content mismatch, not whitespace
    const result = exec('edit_file', {
      path: 'src.js',
      old_text: '    const username = getData();\n    process(username);',
      new_text: '    const email = getEmail();\n    process(email);',
    });
    expect(result.error).toBeFalsy();
    expect(result.result).toContain('fuzzy match');
    const written = fs.readFileSync(path.join(dir, 'src.js'), 'utf-8');
    expect(written).toBe('    const email = getEmail();\n    process(email);');
  });

  it('rejects low-similarity content (<80%)', () => {
    const dir = makeTempDir();
    writeFile(dir, 'low.js', '    completelyDifferentCode();\n    nothingAlike();');
    const { execute: exec } = createToolExecutor(dir);
    const result = exec('edit_file', {
      path: 'low.js',
      old_text: '    someRandomFunction();\n    anotherThing();',
      new_text: '    replacement();',
    });
    expect(result.error).toBe(true);
    expect(result.result).toContain('not found');
  });

  it('rejects ambiguous fuzzy matches (two similar regions)', () => {
    const dir = makeTempDir();
    writeFile(dir, 'amb.js', [
      '    const dataA = fetchData();',
      '    processA(dataA);',
      '',
      '    const dataB = fetchData();',
      '    processB(dataB);',
    ].join('\n'));
    const { execute: exec } = createToolExecutor(dir);
    // old_text is similar to both regions
    const result = exec('edit_file', {
      path: 'amb.js',
      old_text: '    const dataX = fetchData();\n    processX(dataX);',
      new_text: '    replaced();',
    });
    expect(result.error).toBe(true);
    // Should fail — either ambiguous or not found
  });

  it('skips fuzzy for files over 2000 lines', () => {
    const dir = makeTempDir();
    const bigFile = Array.from({ length: 2001 }, (_, i) => `line${i}();`).join('\n');
    writeFile(dir, 'big.js', bigFile);
    const { execute: exec } = createToolExecutor(dir);
    const result = exec('edit_file', {
      path: 'big.js',
      old_text: 'lineXYZ();',  // doesn't exist
      new_text: 'replaced();',
    });
    expect(result.error).toBe(true);
    expect(result.result).toContain('not found');
  });

  it('skips fuzzy for old_text over 50 lines', () => {
    const dir = makeTempDir();
    writeFile(dir, 'normal.js', 'someLine();');
    const { execute: exec } = createToolExecutor(dir);
    const bigOldText = Array.from({ length: 51 }, (_, i) => `old${i}();`).join('\n');
    const result = exec('edit_file', {
      path: 'normal.js',
      old_text: bigOldText,
      new_text: 'replaced();',
    });
    expect(result.error).toBe(true);
    expect(result.result).toContain('not found');
  });

  it('fuzzy re-indents new_text to match file region', () => {
    const dir = makeTempDir();
    writeFile(dir, 'indent.js', '      const result = compute();\n      return result;');
    const { execute: exec } = createToolExecutor(dir);
    // old_text at 2-space indent, slight content difference
    const result = exec('edit_file', {
      path: 'indent.js',
      old_text: '  const result = compote();\n  return result;',
      new_text: '  const value = transform();\n  return value;',
    });
    expect(result.error).toBeFalsy();
    const written = fs.readFileSync(path.join(dir, 'indent.js'), 'utf-8');
    expect(written).toBe('      const value = transform();\n      return value;');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/ollama-tools-edit-fuzzy.test.js -t "fuzzy fallback"`
Expected: FAIL — fuzzy matching not implemented, returns "not found" errors

- [ ] **Step 3: Import `lineSimilarity` and implement `findFuzzyMatch`**

At the top of `ollama-tools.js`, add:
```js
const { lineSimilarity } = require('../utils/hashline-parser');
```

Add the function near the other helpers:

```js
/**
 * Find a fuzzy match for old_text in file content using line-by-line Levenshtein similarity.
 * Requires: avg similarity >= 0.80, every line >= 0.50, ambiguity gap >= 10 points.
 * @param {string} oldText - Text to search for
 * @param {string} fileContent - Full file content
 * @returns {{ startLine: number, lineCount: number, fileIndent: string, score: number } | null}
 */
function findFuzzyMatch(oldText, fileContent) {
  const searchLines = oldText.split('\n');
  const fileLines = fileContent.split('\n');

  // Performance guard
  if (fileLines.length > 2000 || searchLines.length > 50) return null;
  if (searchLines.length === 0 || fileLines.length === 0) return null;

  let bestScore = 0;
  let bestStart = -1;
  let secondBestScore = 0;

  for (let i = 0; i <= fileLines.length - searchLines.length; i++) {
    let totalSim = 0;
    let minSim = 1;
    for (let j = 0; j < searchLines.length; j++) {
      const sim = lineSimilarity(searchLines[j], fileLines[i + j]);
      totalSim += sim;
      if (sim < minSim) minSim = sim;
    }
    const avgSim = totalSim / searchLines.length;

    // Track second-best at >= 0.70 for ambiguity detection,
    // but only accept best match if it also passes minSim >= 0.50
    if (avgSim >= 0.70) {
      if (avgSim > bestScore && minSim >= 0.5) {
        secondBestScore = bestScore;
        bestScore = avgSim;
        bestStart = i;
      } else if (avgSim > secondBestScore) {
        secondBestScore = avgSim;
      }
    }
  }

  if (bestStart === -1) return null;

  // Ambiguity gap: second-best must be < 0.70
  if (secondBestScore >= 0.70) return null;

  const firstNonBlank = fileLines.slice(bestStart, bestStart + searchLines.length)
    .find(l => l.trim().length > 0);
  const fileIndent = firstNonBlank ? firstNonBlank.match(/^(\s*)/)[1] : '';

  return {
    startLine: bestStart,
    lineCount: searchLines.length,
    fileIndent,
    score: bestScore,
  };
}
```

- [ ] **Step 4: Wire fuzzy matching into edit_file**

Replace the `// TODO: Tier 2 fuzzy matching (Task 3)` comment added in Task 2 with:

```js
              // Tier 2: fuzzy matching
              const fuzzyMatch = findFuzzyMatch(args.old_text, content);
              if (fuzzyMatch) {
                const fileLines = content.split('\n');
                const reindented = reindentNewText(args.new_text, fuzzyMatch.fileIndent);
                const before = fileLines.slice(0, fuzzyMatch.startLine);
                const after = fileLines.slice(fuzzyMatch.startLine + fuzzyMatch.lineCount);
                const newContent = [...before, ...reindented.split('\n'), ...after].join('\n');
                fs.writeFileSync(resolvedPath, newContent, 'utf-8');
                changedFiles.add(resolvedPath);
                return {
                  result: `Edit applied to ${args.path} (fuzzy match at ${(fuzzyMatch.score * 100).toFixed(1)}% similarity)`,
                };
              }
```

Export `findFuzzyMatch` from `module.exports`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/ollama-tools-edit-fuzzy.test.js`
Expected: PASS (all tests — reindent + whitespace + fuzzy)

- [ ] **Step 6: Run full regression suite**

Run: `npx vitest run tests/ollama-tools-coverage.test.js tests/agentic-tools.test.js tests/ollama-tools-edit-fuzzy.test.js`
Expected: PASS (all existing + new tests)

- [ ] **Step 7: Commit**

```
git add server/providers/ollama-tools.js server/tests/ollama-tools-edit-fuzzy.test.js
git commit -m "feat(edit_file): Tier 2 fuzzy matching with lineSimilarity + ambiguity gap"
```

---

### Task 4: Cascade integration tests + error message improvements

**Files:**
- Modify: `server/tests/ollama-tools-edit-fuzzy.test.js`
- Modify: `server/providers/ollama-tools.js` (error message tweaks only)

- [ ] **Step 1: Write cascade integration tests**

Append to test file:

```js
describe('edit_file cascade (exact > whitespace > fuzzy)', () => {
  it('prefers exact over whitespace when exact matches', () => {
    const dir = makeTempDir();
    writeFile(dir, 'cascade.js', '  foo();\n    foo();');
    const { execute: exec } = createToolExecutor(dir);
    const result = exec('edit_file', {
      path: 'cascade.js',
      old_text: '  foo();',
      new_text: '  bar();',
    });
    expect(result.result).toBe('Edit applied to cascade.js');
    expect(result.result).not.toContain('normalized');
    expect(result.result).not.toContain('fuzzy');
  });

  it('prefers whitespace over fuzzy when whitespace matches', () => {
    const dir = makeTempDir();
    writeFile(dir, 'cascade2.js', '    doWork();');
    const { execute: exec } = createToolExecutor(dir);
    const result = exec('edit_file', {
      path: 'cascade2.js',
      old_text: '  doWork();',  // wrong indent but content exact
      new_text: '  doBetter();',
    });
    expect(result.result).toContain('normalized whitespace');
    expect(result.result).not.toContain('fuzzy');
  });

  it('replace_all with whitespace fallback but no fuzzy', () => {
    const dir = makeTempDir();
    writeFile(dir, 'ra.js', '    log(x);\n\n    log(x);');
    const { execute: exec } = createToolExecutor(dir);
    const result = exec('edit_file', {
      path: 'ra.js',
      old_text: '  log(x);',
      new_text: '  log(y);',
      replace_all: true,
    });
    expect(result.error).toBeFalsy();
    expect(result.result).toContain('2 replacements');
    expect(result.result).toContain('normalized whitespace');
  });

  it('error message suggests more context when all tiers fail', () => {
    const dir = makeTempDir();
    writeFile(dir, 'nope.js', 'completely different content');
    const { execute: exec } = createToolExecutor(dir);
    const result = exec('edit_file', {
      path: 'nope.js',
      old_text: 'this does not exist anywhere',
      new_text: 'replacement',
    });
    expect(result.error).toBe(true);
    expect(result.result).toContain('not found');
    expect(result.result).toContain('context');
  });
});
```

- [ ] **Step 2: Run all tests**

Run: `npx vitest run tests/ollama-tools-edit-fuzzy.test.js`
Expected: PASS

- [ ] **Step 3: Commit**

```
git add server/tests/ollama-tools-edit-fuzzy.test.js
git commit -m "test(edit_file): cascade integration tests for fuzzy matching"
```

- [ ] **Step 4: Run the full related test suite one final time**

Run: `npx vitest run tests/ollama-tools-edit-fuzzy.test.js tests/ollama-tools-coverage.test.js tests/agentic-tools.test.js tests/harness-improvements.test.js`
Expected: All PASS

- [ ] **Step 5: Final commit with spec and plan docs**

```
git add docs/superpowers/specs/2026-03-18-edit-file-fuzzy-matching-design.md docs/superpowers/plans/2026-03-18-edit-file-fuzzy-matching.md
git commit -m "docs: edit_file fuzzy matching spec and implementation plan"
```
