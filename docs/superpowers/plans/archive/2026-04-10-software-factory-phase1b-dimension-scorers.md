# Software Factory Phase 1b: Dimension Scorers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace placeholder zeros in `scan_project_health` with real scores across all 10 health dimensions, using `scan_project` output for filesystem-based dimensions and parsed scout findings for quality/security dimensions.

**Architecture:** A scorer registry (`server/factory/scorer-registry.js`) dispatches to individual scorer modules. Each scorer implements `score(projectPath, scanReport, findingsDir) -> { score, details, findings }`. The `handleScanProjectHealth` handler calls the registry instead of recording zeros. Scorers are pure functions with no DB access — the handler records their output.

**Tech Stack:** Node.js, better-sqlite3 (existing), vitest (existing), fs (for scan_project and findings parsing)

---

## File Structure

```
server/factory/                        # New directory
  scorer-registry.js                   # Maps dimension names to scorer functions
  scorers/
    structural.js                      # File sizes, module count, largest files
    test-coverage.js                   # Missing tests ratio from scan_project
    security.js                        # Parsed security scout findings
    user-facing.js                     # Error handling patterns heuristic
    api-completeness.js                # API docs and endpoint test heuristic
    documentation.js                   # Parsed documentation scout findings
    dependency-health.js               # Parsed dependency scout + package.json
    build-ci.js                        # CI readiness heuristic from scripts
    performance.js                     # Parsed performance scout findings
    debt-ratio.js                      # TODOs, HACKs from scan_project
  findings-parser.js                   # Parse scout finding markdown files
server/handlers/factory-handlers.js    # Modify: wire scorer registry into handleScanProjectHealth
server/tests/factory-findings-parser.test.js
server/tests/factory-scorers.test.js
server/tests/factory-scan-e2e.test.js
```

---

### Task 1: Findings Parser

**Files:**
- Create: `server/factory/findings-parser.js`
- Test: `server/tests/factory-findings-parser.test.js`

The findings parser reads scout output markdown files (e.g., `docs/findings/2026-04-04-security-scan.md`) and extracts structured finding objects with severity, title, file, and status.

Scout findings follow this format:
```
### [SEVERITY] Title text
- File: path/to/file.js:line
- Description: What is wrong.
- Status: NEW|DEFERRED|RESOLVED
```

Implementation in `server/factory/findings-parser.js`:

```js
'use strict';

const fs = require('fs');
const path = require('path');

const SEVERITY_PATTERN = /^###\s*\[(\w+)\]\s*(.+)$/;
const FIELD_PATTERN = /^-\s*(File|Description|Status|Suggested fix):\s*(.+)$/;

function parseFindingsMarkdown(markdown) {
  const lines = markdown.split('\n');
  const findings = [];
  let summary = '';
  let current = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/\d+\s*findings?/i.test(trimmed) && !summary && findings.length === 0 && !current) {
      summary = trimmed;
      continue;
    }

    const sevMatch = SEVERITY_PATTERN.exec(trimmed);
    if (sevMatch) {
      if (current) findings.push(current);
      current = {
        severity: sevMatch[1].toLowerCase(),
        title: sevMatch[2].trim(),
        file: null,
        description: null,
        status: 'NEW',
        suggested_fix: null,
      };
      continue;
    }

    if (current) {
      const fieldMatch = FIELD_PATTERN.exec(trimmed);
      if (fieldMatch) {
        const key = fieldMatch[1].toLowerCase().replace(/\s+/g, '_');
        const val = fieldMatch[2].trim();
        if (key === 'file') current.file = val;
        else if (key === 'description') current.description = val;
        else if (key === 'status') current.status = val;
        else if (key === 'suggested_fix') current.suggested_fix = val;
      }
    }
  }

  if (current) findings.push(current);
  return { summary, findings };
}

function findLatestFindingsFile(findingsDir, scanType) {
  if (!fs.existsSync(findingsDir)) return null;

  const pattern = new RegExp(
    `\\d{4}-\\d{2}-\\d{2}-.*${scanType}.*(scan|sweep)\\.md$`, 'i'
  );

  let files;
  try {
    files = fs.readdirSync(findingsDir)
      .filter(f => pattern.test(f))
      .sort()
      .reverse();
  } catch { return null; }

  if (files.length === 0) return null;
  return path.join(findingsDir, files[0]);
}

function loadLatestFindings(findingsDir, scanType) {
  const filePath = findLatestFindingsFile(findingsDir, scanType);
  if (!filePath) return { summary: '', findings: [], source: null };

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = parseFindingsMarkdown(content);
    return { ...parsed, source: filePath };
  } catch {
    return { summary: '', findings: [], source: filePath };
  }
}

module.exports = { parseFindingsMarkdown, findLatestFindingsFile, loadLatestFindings };
```

Test in `server/tests/factory-findings-parser.test.js`:

```js
'use strict';

const { parseFindingsMarkdown, findLatestFindingsFile } = require('../factory/findings-parser');
const path = require('path');
const fs = require('fs');
const os = require('os');

describe('findings-parser', () => {
  describe('parseFindingsMarkdown', () => {
    test('parses findings with severity and status', () => {
      const md = [
        '# Security Scan',
        '3 findings: 1 critical, 1 high, 1 low.',
        '',
        '## Findings',
        '',
        '### [CRITICAL] SQL injection in user endpoint',
        '- File: src/api/users.js:42',
        '- Description: User input passed directly to query.',
        '- Status: NEW',
        '',
        '### [HIGH] Missing auth on admin route',
        '- File: src/api/admin.js:10',
        '- Description: No authentication middleware.',
        '- Status: NEW',
        '',
        '### [LOW] Console.log left in production code',
        '- File: src/utils/debug.js:5',
        '- Description: Debug logging in production.',
        '- Status: DEFERRED',
      ].join('\n');

      const result = parseFindingsMarkdown(md);
      expect(result.findings).toHaveLength(3);
      expect(result.findings[0].severity).toBe('critical');
      expect(result.findings[0].title).toBe('SQL injection in user endpoint');
      expect(result.findings[0].file).toBe('src/api/users.js:42');
      expect(result.findings[0].status).toBe('NEW');
      expect(result.findings[1].severity).toBe('high');
      expect(result.findings[2].status).toBe('DEFERRED');
    });

    test('returns empty findings for no findings section', () => {
      const result = parseFindingsMarkdown('# Empty scan\nNo issues found.');
      expect(result.findings).toEqual([]);
    });
  });

  describe('findLatestFindingsFile', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'findings-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('finds latest file matching scan type', () => {
      fs.writeFileSync(path.join(tmpDir, '2026-04-01-security-scan.md'), 'old');
      fs.writeFileSync(path.join(tmpDir, '2026-04-04-security-scan.md'), 'new');

      const result = findLatestFindingsFile(tmpDir, 'security');
      expect(result).toContain('2026-04-04-security-scan.md');
    });

    test('returns null when no matching files', () => {
      expect(findLatestFindingsFile(tmpDir, 'security')).toBeNull();
    });

    test('matches sweep suffix', () => {
      fs.writeFileSync(path.join(tmpDir, '2026-04-05-security-sweep.md'), 'sweep');
      const result = findLatestFindingsFile(tmpDir, 'security');
      expect(result).toContain('security-sweep.md');
    });
  });
});
```

Verify: `npx vitest run tests/factory-findings-parser.test.js`

Commit: `feat(factory): add findings markdown parser for scout output`

---

### Task 2: All 10 Scorer Modules + Registry

**Files:**
- Create: `server/factory/scorer-registry.js`
- Create: `server/factory/scorers/structural.js`
- Create: `server/factory/scorers/test-coverage.js`
- Create: `server/factory/scorers/security.js`
- Create: `server/factory/scorers/user-facing.js`
- Create: `server/factory/scorers/api-completeness.js`
- Create: `server/factory/scorers/documentation.js`
- Create: `server/factory/scorers/dependency-health.js`
- Create: `server/factory/scorers/build-ci.js`
- Create: `server/factory/scorers/performance.js`
- Create: `server/factory/scorers/debt-ratio.js`
- Test: `server/tests/factory-scorers.test.js`

Each scorer implements `score(projectPath, scanReport, findingsDir) -> { score, details, findings }`.

**Scoring philosophy:**
- 50 = "unknown/no data" (prevents balance skew from missing data)
- Tier 1 (structural, test_coverage, debt_ratio): score from scan_project filesystem data
- Tier 2 (security, documentation, dependency_health, performance): score from parsed scout findings, fall back to 50
- Tier 3 (build_ci, user_facing, api_completeness): heuristics from scan_project data, labeled `source: 'heuristic'`

See the full scorer implementations in the code blocks within the plan document body. Each scorer is a standalone module under `server/factory/scorers/`.

The registry (`server/factory/scorer-registry.js`) maps dimension names to scorer modules and provides `scoreDimension(dim, path, report, findingsDir)` and `scoreAll(path, report, findingsDir, dims?)`.

Verify: `npx vitest run tests/factory-scorers.test.js`

Commit: `feat(factory): implement all 10 dimension scorers with registry`

---

### Task 3: Wire Scorers into handleScanProjectHealth

**Files:**
- Modify: `server/handlers/factory-handlers.js` (replace lines 78-101)

Replace the placeholder loop in `handleScanProjectHealth` with:
1. Call `handleScanProject({ path: project.path })` to get filesystem data
2. Resolve findings directory (`docs/findings/` relative to project path)
3. Call `scoreAll()` from the scorer registry
4. Record snapshots and findings for each scored dimension

Verify: `npx vitest run tests/factory-e2e.test.js tests/factory-scorers.test.js`

Commit: `feat(factory): wire real dimension scorers into scan_project_health handler`

---

### Task 4: Integration Test — Score TORQUE Itself

**Files:**
- Create: `server/tests/factory-scan-e2e.test.js`

Test that runs `scoreAll` against the actual TORQUE server directory, verifying:
- All 10 dimensions produce scores
- Filesystem-based scorers (structural, test_coverage, debt_ratio, build_ci) produce non-zero scores
- Scores are recordable as snapshots
- Balance score is computable

Verify: `npx vitest run tests/factory-scan-e2e.test.js`

Commit: `test(factory): integration test scoring TORQUE's own codebase`
