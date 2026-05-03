'use strict';
const {
  parsePlanFile,
  extractVerifyCommand,
  extractExplicitVerifyCommand,
  normalizeVerifyCommand,
} = require('../factory/plan-parser');

const SAMPLE = `# Feature X Plan

**Goal:** Add feature X.
**Tech Stack:** Node.js, better-sqlite3.

## Task 1: Schema + store

- [ ] **Step 1: Tests**

\`\`\`js
// test code
expect(true).toBe(true);
\`\`\`

- [ ] **Step 2: Commit**

\`\`\`bash
git commit -m "feat(x): schema + store"
\`\`\`

## Task 2: API surface

- [ ] **Step 1: Register MCP tool**

\`\`\`js
// mcp tool def
\`\`\`

- [ ] **Step 2: Commit**

\`\`\`bash
git commit -m "feat(x): MCP surface"
\`\`\`
`;

const CHECKLIST_PLAN = `# Marketplace Submission Plan

**Goal:** Submit the plugin cleanly.
**Tech Stack:** Node.js, Vitest.

## Pre-Submission Checklist

### Security Review

- [x] **Run npm audit**
- [ ] **Document privacy posture**
  - Update \`PRIVACY.md\`

### Submission Steps

1. [ ] Push \`README.md\`
2. [ ] Submit via \`claude.ai/settings/plugins/submit\`
`;

describe('parsePlanFile', () => {
  it('returns one task per "## Task N:" heading', () => {
    const parsed = parsePlanFile(SAMPLE);
    expect(parsed.tasks).toHaveLength(2);
    expect(parsed.tasks[0].task_number).toBe(1);
    expect(parsed.tasks[0].task_title).toBe('Schema + store');
    expect(parsed.tasks[1].task_number).toBe(2);
    expect(parsed.tasks[1].task_title).toBe('API surface');
  });

  it('groups steps under each task', () => {
    const parsed = parsePlanFile(SAMPLE);
    expect(parsed.tasks[0].steps).toHaveLength(2);
    expect(parsed.tasks[0].steps[0].title).toMatch(/Tests/);
    expect(parsed.tasks[0].steps[1].title).toMatch(/Commit/);
  });

  it('captures code blocks per step', () => {
    const parsed = parsePlanFile(SAMPLE);
    expect(parsed.tasks[0].steps[0].code_blocks).toHaveLength(1);
    expect(parsed.tasks[0].steps[0].code_blocks[0].lang).toBe('js');
    expect(parsed.tasks[0].steps[0].code_blocks[0].content).toContain('expect(true)');
  });

  it('extracts the commit message from a bash commit step', () => {
    const parsed = parsePlanFile(SAMPLE);
    expect(parsed.tasks[0].commit_message).toBe('feat(x): schema + store');
  });

  it('detects checkbox state for each step', () => {
    const done = SAMPLE.replace('- [ ] **Step 1: Tests**', '- [x] **Step 1: Tests**');
    const parsed = parsePlanFile(done);
    expect(parsed.tasks[0].steps[0].done).toBe(true);
    expect(parsed.tasks[0].steps[1].done).toBe(false);
    expect(parsed.tasks[0].completed).toBe(false);
  });

  it('marks a task completed when all its steps are ticked', () => {
    const all = SAMPLE
      .replace('- [ ] **Step 1: Tests**', '- [x] **Step 1: Tests**')
      .replace('- [ ] **Step 2: Commit**\n\n```bash\ngit commit -m "feat(x): schema + store"\n```', '- [x] **Step 2: Commit**\n\n```bash\ngit commit -m "feat(x): schema + store"\n```');
    const parsed = parsePlanFile(all);
    expect(parsed.tasks[0].completed).toBe(true);
  });

  it('extractVerifyCommand reads Tech Stack hints + project_defaults override', () => {
    expect(extractVerifyCommand(SAMPLE, null)).toMatch(/vitest|tsc|npm test/i);
    expect(extractVerifyCommand(SAMPLE, 'npm run check')).toBe('npm run check');
  });

  it('extractVerifyCommand prefers explicit scoped verification over project defaults', () => {
    const plan = `${SAMPLE}

Verification: torque-remote dotnet test simtests/SimCore.DotNet.Tests.csproj -c Release --filter FullyQualifiedName~LockstepTests
`;
    expect(extractVerifyCommand(plan, 'dotnet test simtests/SimCore.DotNet.Tests.csproj -c Release'))
      .toBe('dotnet test simtests/SimCore.DotNet.Tests.csproj -c Release --filter FullyQualifiedName~LockstepTests');
  });

  it('extractExplicitVerifyCommand reads Validate with code spans', () => {
    const plan = [
      '# Focused plan',
      'Acceptance criterion: run the focused regression. Validate with `torque-remote dotnet test simtests/SimCore.DotNet.Tests.csproj -c Release --filter FullyQualifiedName~LockstepTests`.',
    ].join('\n');

    expect(extractExplicitVerifyCommand(plan))
      .toBe('dotnet test simtests/SimCore.DotNet.Tests.csproj -c Release --filter FullyQualifiedName~LockstepTests');
  });

  it('extractExplicitVerifyCommand reads scoped validation phrasing and normalizes cd semicolon chains', () => {
    const plan = [
      '# Normalize verify signatures',
      'Validate the slice with `cd server; npx vitest run tests/verify-signature.test.js`; do not run the whole suite.',
    ].join('\n');

    expect(extractExplicitVerifyCommand(plan))
      .toBe('cd server && npx vitest run tests/verify-signature.test.js');
  });

  it('does not treat prose validation guidance as an executable command', () => {
    const plan = [
      '# Split loop-controller Plan',
      'Verify with the existing suite: server/tests/factory-loop-controller.test.js, loop-controller-learn.test.js, loop-controller-decision-log.test.js all already exercise the relevant paths. No behavior changes expected.',
    ].join('\n');

    expect(extractExplicitVerifyCommand(plan)).toBeNull();
    expect(extractVerifyCommand(plan, 'cd server && npx vitest run tests/loop-controller-decision-log.test.js'))
      .toBe('cd server && npx vitest run tests/loop-controller-decision-log.test.js');
  });

  it('keeps command-shaped validation without code spans', () => {
    const plan = [
      '# Focused parser Plan',
      'Verification: npm --prefix server test -- tests/file-context-builder.test.js',
    ].join('\n');

    expect(extractExplicitVerifyCommand(plan))
      .toBe('npm --prefix server test -- tests/file-context-builder.test.js');
  });

  it('trims prose suffixes after command-shaped validation text', () => {
    const plan = [
      '# Focused parser Plan',
      'Validation: npm --prefix server test -- tests/file-context-builder.test.js should report the existing suite plus the new focused case.',
    ].join('\n');

    expect(extractExplicitVerifyCommand(plan))
      .toBe('npm --prefix server test -- tests/file-context-builder.test.js');
  });

  it('normalizeVerifyCommand strips the factory transport prefix', () => {
    expect(normalizeVerifyCommand('torque-remote npm test'))
      .toBe('npm test');
  });

  it('normalizeVerifyCommand rejects natural-language verify text', () => {
    expect(normalizeVerifyCommand('the existing suite: server/tests/factory-loop-controller.test.js already covers this'))
      .toBeNull();
  });

  it('normalizeVerifyCommand wraps bare Pester commands for remote bash execution', () => {
    const command = normalizeVerifyCommand('Invoke-Pester -Path .\\Modules\\Tests\\ParserAccessWpfSeparation.Tests.ps1');
    expect(command).toMatch(/^powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand /);
    const encoded = command.split(' ').at(-1);
    expect(Buffer.from(encoded, 'base64').toString('utf16le'))
      .toBe('Invoke-Pester -Path .\\Modules\\Tests\\ParserAccessWpfSeparation.Tests.ps1');
  });

  it('normalizeVerifyCommand does not double-wrap explicit PowerShell hosts', () => {
    expect(normalizeVerifyCommand('powershell -NoProfile -Command "Invoke-Pester Modules/Tests"'))
      .toBe('powershell -NoProfile -Command "Invoke-Pester Modules/Tests"');
  });

  it('returns header metadata (title, goal, tech_stack)', () => {
    const parsed = parsePlanFile(SAMPLE);
    expect(parsed.title).toBe('Feature X Plan');
    expect(parsed.goal).toContain('Add feature X');
    expect(parsed.tech_stack).toContain('better-sqlite3');
  });

  // Regression: the h2-only task-header regex rejected plans that used
  // h3 task headers (e.g. under a "## Tasks" umbrella). Parser returned
  // zero tasks, EXECUTE stage entered the spin-loop (2026-04-19 item 102).
  it('accepts h3 "### Task N:" headers in addition to h2', () => {
    const H3_PLAN = `# Nested Plan

**Goal:** demo nested headers.

## Tasks

### Task 1: Setup

- [ ] **Step 1: Setup**

### Task 2: Teardown

- [ ] **Step 1: Teardown**
`;
    const parsed = parsePlanFile(H3_PLAN);
    expect(parsed.tasks).toHaveLength(2);
    expect(parsed.tasks[0].task_number).toBe(1);
    expect(parsed.tasks[0].task_title).toBe('Setup');
    expect(parsed.tasks[1].task_number).toBe(2);
    expect(parsed.tasks[1].task_title).toBe('Teardown');
  });

  it('accepts h4 "#### Task N:" headers too', () => {
    const H4_PLAN = `# Deeply Nested

#### Task 1: Only

- [ ] **Step 1: Work**
`;
    const parsed = parsePlanFile(H4_PLAN);
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0].task_number).toBe(1);
  });

  it('falls back to checklist sections when a plan has no explicit task headings', () => {
    const parsed = parsePlanFile(CHECKLIST_PLAN);
    expect(parsed.tasks).toHaveLength(2);
    expect(parsed.tasks[0]).toMatchObject({
      task_number: 1,
      task_title: 'Security Review',
      completed: false,
    });
    expect(parsed.tasks[0].steps).toHaveLength(2);
    expect(parsed.tasks[0].steps[0]).toMatchObject({
      step_number: 1,
      title: 'Run npm audit',
      done: true,
    });
    expect(parsed.tasks[0].steps[1]).toMatchObject({
      step_number: 2,
      title: 'Document privacy posture',
      done: false,
      notes: ['- Update `PRIVACY.md`'],
    });
    expect(parsed.tasks[1].steps.map((step) => step.title)).toEqual([
      'Push README.md',
      'Submit via claude.ai/settings/plugins/submit',
    ]);
  });
});
