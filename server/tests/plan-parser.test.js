'use strict';
const { describe, it, expect } = require('vitest');
const { parsePlanFile, extractVerifyCommand } = require('../factory/plan-parser');

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

  it('returns header metadata (title, goal, tech_stack)', () => {
    const parsed = parsePlanFile(SAMPLE);
    expect(parsed.title).toBe('Feature X Plan');
    expect(parsed.goal).toContain('Add feature X');
    expect(parsed.tech_stack).toContain('better-sqlite3');
  });
});
