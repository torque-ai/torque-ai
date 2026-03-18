# edit_file Fuzzy Matching Design

**Date:** 2026-03-18
**Status:** Approved
**Scope:** `server/providers/ollama-tools.js`

## Problem

Free LLMs (cerebras, groq, ollama) calling `edit_file` frequently send `old_text` with wrong indentation. The exact `indexOf` match fails, wasting an agentic iteration or failing the task entirely. The existing indentation normalization only fixes `new_text` indentation after a successful match — it doesn't help when `old_text` itself doesn't match.

Observed in baseline testing (2026-03-17): cerebras has ~40% edit success rate, with indentation mismatch as the dominant failure mode.

## Solution

Add a 2-tier fallback in `edit_file` when exact `indexOf` fails:

1. **Whitespace-normalized match** — strip leading whitespace, compare content-only
2. **Fuzzy match** — Levenshtein-based line similarity (reuse existing `lineSimilarity` from `hashline-parser.js`)

Both tiers report back to the LLM on success: `"Edit applied to X (whitespace-normalized match)"` or `"Edit applied to X (fuzzy match at 91.2% similarity)"`.

## Tier 1: Whitespace-Normalized Match

When exact `indexOf(old_text)` returns -1:

1. Normalize both `old_text` and file content: strip leading whitespace from each line
2. **Line-based matching**: split both into normalized line arrays, find the start line index where the normalized `old_text` lines match a contiguous run in the normalized file lines. This avoids the character-offset-to-line recovery problem with blank lines.
3. **0 matches** → fall through to Tier 2
4. **2+ matches** → return "multiple matches" error (same as exact mode)
5. **1 match** → the matched start line in the file is known directly (line-based search), splice in `new_text` re-indented to the original file's indentation at the match point

### Known limitation: blank-line ambiguity

Lines containing only whitespace normalize to empty strings. In files with many blank-line-separated blocks of identical code, the normalized form may produce a unique match that maps to the wrong region. This is inherent to whitespace-blind matching. Mitigated by line-based matching (comparing line-by-line rather than a single joined string) and the fact that most real `old_text` blocks contain enough content lines to disambiguate.

Test case: `old_text` with internal blank lines that appears twice at different indent levels → must be rejected as ambiguous or match the correct region.

## Tier 2: Fuzzy Match

When whitespace-normalized match also fails:

1. Split `old_text` into lines, split file into lines
2. **Performance guard**: skip fuzzy if file > 2000 lines or `old_text` > 50 lines. Return the normal "not found" error with a note: `"(file too large for fuzzy matching)"`. Tier 1 (whitespace-normalized) still applies regardless of size since it's just array comparison.
3. Slide a window of `searchLines.length` lines across the file
4. For each window position, compute average `lineSimilarity` (Levenshtein-based, imported from `hashline-parser.js`)
5. Track the **top-two** scoring positions (best and second-best)
6. Accept the best match if:
   - Average similarity >= 0.80
   - Every individual line similarity >= 0.50
   - **Ambiguity gap**: second-best score < 0.70 (10+ point gap from the 0.80 threshold). If second-best is >= 0.70, reject as ambiguous even if it's below 0.80 — two near-matches in repetitive code are too risky.
7. If accepted, splice `new_text` into the file at that position, re-indented to match the original region's leading whitespace

### Implementation note: import `lineSimilarity` only

Import `lineSimilarity` from `hashline-parser.js` as the primitive. Do NOT import `findSearchMatch` — it lacks second-best tracking and the ambiguity gap check. Implement the sliding window inline in `ollama-tools.js` with the specific thresholds above.

## Re-Indentation Logic

Both tiers use a **prefix-replacement** approach (NOT the existing character-count-delta arithmetic, which breaks with mixed tabs/spaces):

1. Extract `fileIndent`: the leading whitespace of the matched region's first non-blank line in the original file
2. Extract `newIndent`: the leading whitespace of `new_text`'s first non-blank line
3. For each line in `new_text`:
   - If the line starts with `newIndent`, replace that prefix with `fileIndent`
   - If the line has less indentation than `newIndent` (e.g., a closing brace), replace as much of the common prefix as exists
   - Blank lines are left unchanged

This handles tabs, spaces, and mixed indentation correctly because it replaces the prefix string rather than computing a character-count delta.

## replace_all Mode

The `replace_all: true` path gets whitespace-normalized fallback only — NOT fuzzy. Fuzzy + replace_all risks matching unintended locations in repetitive code.

## Uniqueness Invariant

All three tiers (exact, whitespace, fuzzy) enforce the same rule: **exactly one match or error**. The fuzzy tier additionally requires a 10+ point ambiguity gap between best and second-best scores. This is the core safety property that prevents wrong-location edits.

### Known limitation: repetitive code

In files with repetitive patterns (generated code, test files, duplicated blocks), even uniqueness checks can't guarantee the correct match location. This is inherent to content-based matching at all three tiers. The error message for failed matches should suggest including more surrounding context.

## Success Messages

| Tier | Message |
|------|---------|
| Exact | `Edit applied to {path}` |
| Whitespace-normalized | `Edit applied to {path} (matched with normalized whitespace)` |
| Fuzzy | `Edit applied to {path} (fuzzy match at {score}% similarity)` |
| Whitespace-normalized (replace_all) | `Edit applied to {path} ({N} replacements, matched with normalized whitespace)` |

## Files

**Modified:**
- `server/providers/ollama-tools.js` — 2-tier fallback in `edit_file` case, import `lineSimilarity`

**Imported (no changes):**
- `server/utils/hashline-parser.js` — `lineSimilarity` function (primitive only, not `findSearchMatch`)

**New tests:**
- `server/tests/ollama-tools-edit-fuzzy.test.js`

## Test Cases

### Whitespace-normalized tier
- Wrong leading indentation matches correctly
- Multiple normalized matches → error
- `new_text` re-indented to match file's indentation (prefix-replacement)
- Tabs vs spaces: file uses tabs, old_text uses spaces → matches, new_text gets tabs
- Blank lines in old_text with duplicated code at different indents → ambiguity detected
- Empty `old_text` lines preserved

### Fuzzy tier
- Near-miss content (typo in variable name) matches at >80%
- Low-similarity content (<80%) rejected
- Ambiguous fuzzy matches (two regions >80%) → error
- Near-ambiguous (best 85%, second-best 72%) → error (gap < 10 points from threshold)
- Clear match (best 90%, second-best 60%) → success
- Single-line edits work
- Multi-line edits work
- `new_text` re-indented via prefix-replacement
- Files > 2000 lines → fuzzy skipped, error with note
- old_text > 50 lines → fuzzy skipped

### Cascade
- Exact match preferred over whitespace/fuzzy
- Whitespace match preferred over fuzzy
- All three tiers return correct success messages
- `replace_all` uses whitespace fallback but not fuzzy

## Not In Scope

- No changes to hashline-parser, hashline-verify, or aider repair pipeline
- No fuzzy matching for `replace_all` + fuzzy tier
- No changes to agentic loop or tool definitions
- No new config flags — always-on, safe by construction
- No new dependencies
