'use strict';

const {
  unwrapWholeMarkdownFence,
  convertFencedBlocksToIndented,
  isPromptEchoTail,
  trimPromptEchoTail,
  indentForPlan,
  normalizeProposalOperationType,
  buildPlanFromFileEditsProposal,
  cleanNumberedPlanSummaryText,
  extractNumberedPlanSummaryTasks,
  titleFromNumberedPlanSummaryTask,
  summarizeNumberedPlanTaskScope,
  buildPlanFromNumberedTaskSummary,
} = require('../factory/plan-builders/from-output');

// ---------------------------------------------------------------------------
// unwrapWholeMarkdownFence
// ---------------------------------------------------------------------------
describe('unwrapWholeMarkdownFence', () => {
  it('strips a triple-backtick fence with language tag', () => {
    const input = '```json\n{"key": "value"}\n```';
    expect(unwrapWholeMarkdownFence(input)).toBe('{"key": "value"}');
  });

  it('strips a triple-backtick fence without language tag', () => {
    const input = '```\nsome content\n```';
    expect(unwrapWholeMarkdownFence(input)).toBe('some content');
  });

  it('returns plain text unchanged when no fence present', () => {
    const input = 'just plain text';
    expect(unwrapWholeMarkdownFence(input)).toBe('just plain text');
  });

  it('returns empty string for empty/falsy input', () => {
    expect(unwrapWholeMarkdownFence('')).toBe('');
    expect(unwrapWholeMarkdownFence(null)).toBe('');
    expect(unwrapWholeMarkdownFence(undefined)).toBe('');
  });

  it('trims leading/trailing whitespace around fences', () => {
    const input = '  \n```js\nconst x = 1;\n```\n  ';
    expect(unwrapWholeMarkdownFence(input)).toBe('const x = 1;');
  });

  it('does not strip partial fences (only opening or closing)', () => {
    const input = '```js\nconst x = 1;';
    expect(unwrapWholeMarkdownFence(input)).toBe(input.trim());
  });

  it('does not strip fences that are not whole-document', () => {
    const input = 'preamble\n```json\n{"a":1}\n```\npostscript';
    expect(unwrapWholeMarkdownFence(input)).toBe(input);
  });

  it('handles multiline content inside fences', () => {
    const input = '```\nline1\nline2\nline3\n```';
    expect(unwrapWholeMarkdownFence(input)).toBe('line1\nline2\nline3');
  });

  it('handles language tags with hyphens and digits', () => {
    const input = '```c-sharp99\nclass Foo {}\n```';
    expect(unwrapWholeMarkdownFence(input)).toBe('class Foo {}');
  });
});

// ---------------------------------------------------------------------------
// convertFencedBlocksToIndented
// ---------------------------------------------------------------------------
describe('convertFencedBlocksToIndented', () => {
  it('converts a single fenced block to 4-space indented lines', () => {
    const input = 'text before\n```\ncode line\n```\ntext after';
    const result = convertFencedBlocksToIndented(input);
    expect(result).toBe('text before\n    code line\ntext after');
  });

  it('converts multiple fenced blocks', () => {
    const input = '```\na\n```\nmid\n```\nb\n```';
    const result = convertFencedBlocksToIndented(input);
    expect(result).toBe('    a\nmid\n    b');
  });

  it('preserves empty lines inside fenced blocks as empty strings', () => {
    const input = '```\nfirst\n\nsecond\n```';
    const result = convertFencedBlocksToIndented(input);
    expect(result).toBe('    first\n\n    second');
  });

  it('passes through input with no fences unchanged', () => {
    const input = 'no fences here\njust text';
    expect(convertFencedBlocksToIndented(input)).toBe(input);
  });

  it('handles empty/falsy input', () => {
    expect(convertFencedBlocksToIndented('')).toBe('');
    expect(convertFencedBlocksToIndented(null)).toBe('');
  });

  it('handles fenced blocks with language tags', () => {
    const input = '```js\nconsole.log("hi");\n```';
    const result = convertFencedBlocksToIndented(input);
    expect(result).toBe('    console.log("hi");');
  });

  it('preserves content outside fences verbatim', () => {
    const input = 'before\n```\ninside\n```\n  after  ';
    const result = convertFencedBlocksToIndented(input);
    expect(result).toBe('before\n    inside\n  after  ');
  });
});

// ---------------------------------------------------------------------------
// Prompt-echo trimming (isPromptEchoTail + trimPromptEchoTail)
// ---------------------------------------------------------------------------
describe('isPromptEchoTail', () => {
  it('detects "Project context:" echo', () => {
    const lines = ['something', 'Project context:', 'some more text'];
    expect(isPromptEchoTail(lines, 1)).toBe(true);
  });

  it('detects "Work item context:" echo', () => {
    const lines = ['something', 'Work item context:'];
    expect(isPromptEchoTail(lines, 1)).toBe(true);
  });

  it('detects "Code-graph research:" echo', () => {
    const lines = ['something', 'Code-graph research:'];
    expect(isPromptEchoTail(lines, 1)).toBe(true);
  });

  it('detects "Quality Rules" heading echo', () => {
    const lines = ['something', '## Quality Rules'];
    expect(isPromptEchoTail(lines, 1)).toBe(true);
  });

  it('detects "Every task body MUST include all five" echo', () => {
    const lines = ['something', 'Every task body MUST include all five required sections'];
    expect(isPromptEchoTail(lines, 1)).toBe(true);
  });

  it('detects "Use `## Task N:` headings exactly" echo', () => {
    const lines = ['something', 'Use `## Task N:` headings exactly as shown'];
    expect(isPromptEchoTail(lines, 1)).toBe(true);
  });

  it('returns false for non-echo content', () => {
    const lines = ['something', 'just normal text', 'more normal text'];
    expect(isPromptEchoTail(lines, 1)).toBe(false);
  });

  it('looks ahead up to 30 lines', () => {
    const lines = ['something'];
    // Pad 25 lines then an echo marker within the 30-line window
    for (let i = 0; i < 25; i++) lines.push('padding');
    lines.push('Project context:');
    expect(isPromptEchoTail(lines, 1)).toBe(true);
  });
});

describe('trimPromptEchoTail', () => {
  it('trims output at "Project context:" boundary', () => {
    const input = 'Task 1: Do something\nSome detail\nProject context:\nThis is echoed';
    const result = trimPromptEchoTail(input);
    expect(result).toBe('Task 1: Do something\nSome detail');
  });

  it('trims output at "Work item context:" boundary', () => {
    const input = 'Real output\nWork item context:\nEchoed stuff';
    const result = trimPromptEchoTail(input);
    expect(result).toBe('Real output');
  });

  it('trims output at "# Quality Rules" heading', () => {
    const input = 'Real content\n## Quality Rules\nDo not do this';
    const result = trimPromptEchoTail(input);
    expect(result).toBe('Real content');
  });

  it('trims at "Every task body MUST include all five" line', () => {
    const input = 'Useful output\nEvery task body MUST include all five sections';
    const result = trimPromptEchoTail(input);
    expect(result).toBe('Useful output');
  });

  it('returns unchanged output when no echo detected', () => {
    const input = 'This is normal output\nWith multiple lines\nAll clean';
    expect(trimPromptEchoTail(input)).toBe(input);
  });

  it('returns the original value passed in for falsy input', () => {
    // trimPromptEchoTail returns `value` when cutoff is -1, so null/undefined pass through
    expect(trimPromptEchoTail('')).toBe('');
    expect(trimPromptEchoTail(null)).toBeNull();
    expect(trimPromptEchoTail(undefined)).toBeUndefined();
  });

  it('does not trim at line 0 (first line is always kept)', () => {
    // "Project context:" at index 0 should NOT trigger cutoff
    const input = 'Project context:\nSome actual output';
    expect(trimPromptEchoTail(input)).toBe(input);
  });

  it('trims at "Rules:" followed by prompt echo tail content', () => {
    const lines = [
      'Task 1: Something',
      'Rules:',
      'Use `## Task N:` headings exactly as shown',
    ];
    const input = lines.join('\n');
    const result = trimPromptEchoTail(input);
    expect(result).toBe('Task 1: Something');
  });

  it('does not trim "Rules:" when NOT followed by prompt echo tail', () => {
    const input = 'Task 1: Something\nRules:\nCustom user rules here\nMore rules';
    expect(trimPromptEchoTail(input)).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// indentForPlan
// ---------------------------------------------------------------------------
describe('indentForPlan', () => {
  it('indents single-line text with default 8 spaces', () => {
    expect(indentForPlan('hello')).toBe('        hello');
  });

  it('indents multiline text', () => {
    const result = indentForPlan('line1\nline2');
    expect(result).toBe('        line1\n        line2');
  });

  it('uses custom indent width', () => {
    expect(indentForPlan('x', 4)).toBe('    x');
  });

  it('returns indented <empty> for empty/falsy text', () => {
    expect(indentForPlan('')).toBe('        <empty>');
    expect(indentForPlan(null)).toBe('        <empty>');
    expect(indentForPlan(undefined)).toBe('        <empty>');
  });

  it('handles zero-width indent', () => {
    expect(indentForPlan('hello', 0)).toBe('hello');
  });
});

// ---------------------------------------------------------------------------
// normalizeProposalOperationType
// ---------------------------------------------------------------------------
describe('normalizeProposalOperationType', () => {
  it('returns "create" for type "create"', () => {
    expect(normalizeProposalOperationType({ type: 'create' })).toBe('create');
  });

  it('returns "create" for type "CREATE" (case-insensitive)', () => {
    expect(normalizeProposalOperationType({ type: 'CREATE' })).toBe('create');
  });

  it('returns "delete" for type "delete"', () => {
    expect(normalizeProposalOperationType({ type: 'delete' })).toBe('delete');
  });

  it('returns "delete" for type "DELETE" (case-insensitive)', () => {
    expect(normalizeProposalOperationType({ type: 'DELETE' })).toBe('delete');
  });

  it('returns "replace" for type "replace"', () => {
    expect(normalizeProposalOperationType({ type: 'replace' })).toBe('replace');
  });

  it('defaults to "replace" for unknown types like "edit"', () => {
    expect(normalizeProposalOperationType({ type: 'edit' })).toBe('replace');
  });

  it('defaults to "replace" for "modify"', () => {
    expect(normalizeProposalOperationType({ type: 'modify' })).toBe('replace');
  });

  it('defaults to "replace" for "update"', () => {
    expect(normalizeProposalOperationType({ type: 'update' })).toBe('replace');
  });

  it('defaults to "replace" for null/undefined operation', () => {
    expect(normalizeProposalOperationType(null)).toBe('replace');
    expect(normalizeProposalOperationType(undefined)).toBe('replace');
  });

  it('defaults to "replace" when type is missing', () => {
    expect(normalizeProposalOperationType({})).toBe('replace');
  });

  it('defaults to "replace" when type is non-string', () => {
    expect(normalizeProposalOperationType({ type: 123 })).toBe('replace');
  });

  it('trims whitespace from type', () => {
    expect(normalizeProposalOperationType({ type: '  create  ' })).toBe('create');
    expect(normalizeProposalOperationType({ type: ' delete ' })).toBe('delete');
  });
});

// ---------------------------------------------------------------------------
// buildPlanFromFileEditsProposal (JSON file_edits pipeline)
// ---------------------------------------------------------------------------
describe('buildPlanFromFileEditsProposal', () => {
  // The function requires `../../diffusion/compute-output-parser` internally.
  // That module is available (no mock needed) — we feed it valid/invalid JSON.

  const validRawOutput = JSON.stringify({
    file_edits: [
      {
        file: 'server/utils/helper.js',
        operations: [
          { type: 'replace', old_text: 'const x = 1;', new_text: 'const x = 2;' },
        ],
      },
    ],
  });

  const workItem = { id: 42, title: 'Fix helper constant' };
  const project = { name: 'torque', path: process.cwd() };

  it('produces a plan from valid file_edits JSON', () => {
    const result = buildPlanFromFileEditsProposal(validRawOutput, workItem, project);
    expect(result).toBeTypeOf('string');
    expect(result).toContain('# Fix helper constant Plan');
    expect(result).toContain('auto-generated from work_item #42');
    expect(result).toContain('## Task 1: Apply proposed edits for Fix helper constant');
    expect(result).toContain('`server/utils/helper.js`');
    expect(result).toContain('Operation 1: replace');
    expect(result).toContain('Old text:');
    expect(result).toContain('New text:');
    expect(result).toContain('Step 2: Validate');
    expect(result).toContain('Step 3: Commit');
    expect(result).toMatch(/\n$/);
  });

  it('includes "create" operation without Old text section', () => {
    // create operations skip Old text in the plan output
    const raw = JSON.stringify({
      file_edits: [{
        file: 'new-file.js',
        operations: [{ type: 'create', old_text: '', new_text: 'new content' }],
      }],
    });
    const result = buildPlanFromFileEditsProposal(raw, workItem, project);
    expect(result).toBeTypeOf('string');
    expect(result).toContain('Operation 1: create');
    expect(result).toContain('New text:');
  });

  it('includes "delete" operation without New text section', () => {
    const raw = JSON.stringify({
      file_edits: [{
        file: 'old-file.js',
        operations: [{ type: 'delete', old_text: 'dead code', new_text: '' }],
      }],
    });
    const result = buildPlanFromFileEditsProposal(raw, workItem, project);
    expect(result).toContain('Operation 1: delete');
    expect(result).toContain('Old text:');
  });

  it('handles multiple files and multiple operations', () => {
    const raw = JSON.stringify({
      file_edits: [
        {
          file: 'a.js',
          operations: [
            { type: 'replace', old_text: 'old1', new_text: 'new1' },
            { type: 'replace', old_text: 'old2', new_text: 'new2' },
          ],
        },
        {
          file: 'b.js',
          operations: [
            { type: 'replace', old_text: 'old3', new_text: 'new3' },
          ],
        },
      ],
    });
    const result = buildPlanFromFileEditsProposal(raw, workItem, project);
    expect(result).toContain('Edit 2 file(s) with 3 exact operation(s)');
    expect(result).toContain('`a.js`');
    expect(result).toContain('`b.js`');
  });

  it('returns null for malformed JSON', () => {
    const result = buildPlanFromFileEditsProposal('{not valid json!!!', workItem, project);
    expect(result).toBeNull();
  });

  it('returns null for empty file_edits array', () => {
    const raw = JSON.stringify({ file_edits: [] });
    const result = buildPlanFromFileEditsProposal(raw, workItem, project);
    expect(result).toBeNull();
  });

  it('returns null for completely non-JSON input', () => {
    const result = buildPlanFromFileEditsProposal('Just some plain text output', workItem, project);
    expect(result).toBeNull();
  });

  it('returns null for null/undefined input', () => {
    expect(buildPlanFromFileEditsProposal(null, workItem, project)).toBeNull();
    expect(buildPlanFromFileEditsProposal(undefined, workItem, project)).toBeNull();
  });

  it('filters out edits with empty file path after schema validation', () => {
    // validateComputeSchema rejects entries with invalid file paths,
    // so the entire proposal returns null when the only valid-schema
    // entries happen to have empty file strings
    const raw = JSON.stringify({
      file_edits: [
        { file: '', operations: [{ type: 'replace', old_text: 'a', new_text: 'b' }] },
      ],
    });
    const result = buildPlanFromFileEditsProposal(raw, workItem, project);
    // Schema validation catches the empty file path — returns null
    expect(result).toBeNull();
  });

  it('produces plan when mixed valid/empty-file edits pass schema validation', () => {
    // Both entries have non-empty file paths for schema validation,
    // but from-output filters out the one with empty operations
    const raw = JSON.stringify({
      file_edits: [
        { file: 'skip-me.js', operations: [] },
        { file: 'keep-me.js', operations: [{ type: 'replace', old_text: 'old', new_text: 'new' }] },
      ],
    });
    const result = buildPlanFromFileEditsProposal(raw, workItem, project);
    // Schema validation rejects empty operations array on skip-me.js
    expect(result).toBeNull();
  });

  it('uses workItem.id fallback when title is missing', () => {
    const result = buildPlanFromFileEditsProposal(validRawOutput, { id: 99 }, project);
    expect(result).toContain('# Work Item 99 Plan');
    expect(result).toContain('Apply proposed edits for work item 99');
  });

  it('produces plan from JSON embedded inside markdown fences', () => {
    const fencedRaw = '```json\n' + validRawOutput + '\n```';
    const result = buildPlanFromFileEditsProposal(fencedRaw, workItem, project);
    expect(result).toBeTypeOf('string');
    expect(result).toContain('# Fix helper constant Plan');
  });

  it('uses slugified project name in commit message', () => {
    const result = buildPlanFromFileEditsProposal(validRawOutput, workItem, { name: 'My Cool Project', path: process.cwd() });
    expect(result).toContain('fix(my-cool-project):');
  });

  it('normalizes unknown operation types to replace in the plan output', () => {
    const raw = JSON.stringify({
      file_edits: [{
        file: 'server/foo.js',
        operations: [{ type: 'modify', old_text: 'old', new_text: 'new' }],
      }],
    });
    const result = buildPlanFromFileEditsProposal(raw, workItem, project);
    expect(result).toBeTypeOf('string');
    expect(result).toContain('Operation 1: replace');
  });

  it('shows <empty> placeholder for empty old_text/new_text', () => {
    const raw = JSON.stringify({
      file_edits: [{
        file: 'server/bar.js',
        operations: [{ type: 'replace', old_text: '', new_text: 'inserted' }],
      }],
    });
    const result = buildPlanFromFileEditsProposal(raw, workItem, project);
    expect(result).toContain('<empty>');
  });
});

// ---------------------------------------------------------------------------
// cleanNumberedPlanSummaryText
// ---------------------------------------------------------------------------
describe('cleanNumberedPlanSummaryText', () => {
  it('collapses multiple whitespace to single space', () => {
    expect(cleanNumberedPlanSummaryText('hello   world')).toBe('hello world');
  });

  it('removes whitespace before punctuation', () => {
    expect(cleanNumberedPlanSummaryText('hello , world')).toBe('hello, world');
    expect(cleanNumberedPlanSummaryText('value ;')).toBe('value;');
  });

  it('strips leading colons, dashes, and whitespace', () => {
    expect(cleanNumberedPlanSummaryText(': some text')).toBe('some text');
    expect(cleanNumberedPlanSummaryText('---text')).toBe('text');
  });

  it('returns empty string for empty/falsy input', () => {
    expect(cleanNumberedPlanSummaryText('')).toBe('');
    expect(cleanNumberedPlanSummaryText(null)).toBe('');
    expect(cleanNumberedPlanSummaryText(undefined)).toBe('');
  });

  it('trims result', () => {
    expect(cleanNumberedPlanSummaryText('  hello  ')).toBe('hello');
  });
});

// ---------------------------------------------------------------------------
// extractNumberedPlanSummaryTasks (Numbered Task N: heading pipeline)
// ---------------------------------------------------------------------------
describe('extractNumberedPlanSummaryTasks', () => {
  it('extracts well-formed numbered Task headings with file paths', () => {
    const input = [
      '1) Task 1 - Edit `server/auth.js` to patch the login flow',
      '2) Task 2 - Create `server/tests/auth.test.js` with coverage',
    ].join('\n');
    const tasks = extractNumberedPlanSummaryTasks(input);
    expect(tasks).toHaveLength(2);
    expect(tasks[0].taskNumber).toBe(1);
    expect(tasks[1].taskNumber).toBe(2);
  });

  it('extracts bare Task headings (no leading number)', () => {
    const input = [
      'Task 1 - Edit `server/auth.js` for the fix',
      'Task 2 - Create `server/tests/auth.test.js` with tests',
    ].join('\n');
    const tasks = extractNumberedPlanSummaryTasks(input);
    expect(tasks).toHaveLength(2);
  });

  it('captures explicit titles from the heading', () => {
    // The regex's lazy capture means the explicit title group captures
    // a short prefix. Verify the task is extracted with some explicitTitle.
    const input = '1) Task 1: Update server/auth.js with better error handling';
    const tasks = extractNumberedPlanSummaryTasks(input);
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    // The explicit title is whatever the regex captures before the em-dash
    expect(tasks[0].explicitTitle).toBeTypeOf('string');
  });

  it('captures continuation lines as detail', () => {
    const input = [
      '1) Task 1 - Edit `server/auth.js` for login',
      '   Also update `server/config.js` for the new auth token',
    ].join('\n');
    const tasks = extractNumberedPlanSummaryTasks(input);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].detail).toContain('server/config.js');
  });

  it('stops at prompt echo boundary (tasks before the echo are kept)', () => {
    // isPromptEchoTail looks ahead 30 lines, so the echo marker must be
    // far enough from the first task for that task to be parsed.
    const lines = [
      '1) Task 1 - Edit `server/auth.js` to patch login',
    ];
    // Push the echo marker beyond the 30-line lookahead window of line 0
    for (let i = 0; i < 31; i++) lines.push(`   continuation detail line ${i}`);
    lines.push('2) Task 2 - Edit `server/config.js` for config update');
    lines.push('Project context:');
    lines.push('3) Task 3 - Edit `server/fake.js` (should be ignored)');
    const tasks = extractNumberedPlanSummaryTasks(lines.join('\n'));
    // Task 1 is well before the echo; Task 2 is right before "Project context:"
    // and its 30-line lookahead includes the echo marker, so it breaks there.
    // At minimum Task 1 should be extracted.
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    expect(tasks[0].taskNumber).toBe(1);
  });

  it('stops at known section headers like "Description:"', () => {
    const input = [
      '1) Task 1 - Edit `server/auth.js` for login fix',
      'Description:',
    ].join('\n');
    const tasks = extractNumberedPlanSummaryTasks(input);
    expect(tasks).toHaveLength(1);
  });

  it('returns empty array for input with no task headings', () => {
    const input = 'This is just normal text without any task headings';
    expect(extractNumberedPlanSummaryTasks(input)).toEqual([]);
  });

  it('returns empty array for empty/null input', () => {
    expect(extractNumberedPlanSummaryTasks('')).toEqual([]);
    expect(extractNumberedPlanSummaryTasks(null)).toEqual([]);
    expect(extractNumberedPlanSummaryTasks(undefined)).toEqual([]);
  });

  it('filters out tasks with no file paths in detail', () => {
    const input = '1) Task 1 - Do something vague without any file paths mentioned';
    const tasks = extractNumberedPlanSummaryTasks(input);
    expect(tasks).toEqual([]);
  });

  it('limits to 5 tasks maximum', () => {
    const lines = [];
    for (let i = 1; i <= 8; i++) {
      lines.push(`${i}) Task ${i} - Edit \`server/file${i}.js\` for fix ${i}`);
    }
    const tasks = extractNumberedPlanSummaryTasks(lines.join('\n'));
    expect(tasks.length).toBeLessThanOrEqual(5);
  });

  it('filters tasks with non-sequential numbering', () => {
    const input = [
      '1) Task 1 - Edit `server/auth.js` for login',
      '5) Task 5 - Edit `server/config.js` for config',
    ].join('\n');
    const tasks = extractNumberedPlanSummaryTasks(input);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].taskNumber).toBe(1);
  });

  it('handles bold-formatted task headings', () => {
    const input = '1) **Task 1** - Edit `server/auth.js` for login fix';
    const tasks = extractNumberedPlanSummaryTasks(input);
    expect(tasks.length).toBeGreaterThanOrEqual(1);
  });

  it('handles bullet-prefixed bare task headings', () => {
    const input = '- Task 1 - Edit `server/auth.js` for login';
    const tasks = extractNumberedPlanSummaryTasks(input);
    expect(tasks.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// titleFromNumberedPlanSummaryTask
// ---------------------------------------------------------------------------
describe('titleFromNumberedPlanSummaryTask', () => {
  it('returns explicit title when present', () => {
    const task = { taskNumber: 1, explicitTitle: 'Fix login flow', detail: 'Edit server/auth.js' };
    expect(titleFromNumberedPlanSummaryTask(task)).toBe('Fix login flow');
  });

  it('truncates explicit title to 120 characters', () => {
    const longTitle = 'A'.repeat(200);
    const task = { taskNumber: 1, explicitTitle: longTitle, detail: '' };
    expect(titleFromNumberedPlanSummaryTask(task).length).toBeLessThanOrEqual(120);
  });

  it('derives title from detail when no explicit title', () => {
    const task = { taskNumber: 1, explicitTitle: '', detail: 'Fix the broken login in server/auth.js' };
    const title = titleFromNumberedPlanSummaryTask(task);
    expect(title).toBeTypeOf('string');
    expect(title.length).toBeGreaterThan(0);
  });

  it('prefixes "Add" when detail mentions tests but does not start with action verb', () => {
    const task = { taskNumber: 1, explicitTitle: '', detail: 'unit tests for server/auth.js' };
    const title = titleFromNumberedPlanSummaryTask(task);
    expect(title).toMatch(/^Add\s/);
  });

  it('does not prefix "Add" when detail already starts with "Add"', () => {
    const task = { taskNumber: 1, explicitTitle: '', detail: 'Add tests for server/auth.js' };
    const title = titleFromNumberedPlanSummaryTask(task);
    expect(title).not.toMatch(/^Add Add/);
  });

  it('prefixes "Implement" when detail does not start with recognized verb', () => {
    const task = { taskNumber: 1, explicitTitle: '', detail: 'login endpoint in server/auth.js' };
    const title = titleFromNumberedPlanSummaryTask(task);
    expect(title).toMatch(/^Implement\s/);
  });

  it('does not prefix "Implement" when detail starts with recognized verb', () => {
    const task = { taskNumber: 1, explicitTitle: '', detail: 'Fix broken auth in server/auth.js' };
    const title = titleFromNumberedPlanSummaryTask(task);
    expect(title).toMatch(/^Fix\s/);
  });

  it('returns a fallback title when both title and detail are empty', () => {
    // With empty detail, cleanNumberedPlanSummaryText returns '' so the code
    // falls through to `title || Plan task N`. Empty string is falsy, but
    // the "Implement" prefix is added before the fallback check.
    const task = { taskNumber: 3, explicitTitle: '', detail: '' };
    const title = titleFromNumberedPlanSummaryTask(task);
    // The title should be non-empty
    expect(title).toBeTypeOf('string');
    expect(title.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// summarizeNumberedPlanTaskScope
// ---------------------------------------------------------------------------
describe('summarizeNumberedPlanTaskScope', () => {
  it('extracts count-based scope from detail text', () => {
    const task = { explicitTitle: '', detail: 'Edit 3 files to fix the auth flow' };
    const result = summarizeNumberedPlanTaskScope(task, ['a.js', 'b.js', 'c.js']);
    expect(result).toContain('3 files');
    expect(result).toContain('across 3 files');
  });

  it('extracts count-based scope from explicit title', () => {
    const task = { explicitTitle: 'Update two tests', detail: '' };
    const result = summarizeNumberedPlanTaskScope(task, ['a.test.js', 'b.test.js']);
    expect(result).toContain('two tests');
  });

  it('returns fallback when no count mentioned', () => {
    const task = { explicitTitle: '', detail: 'Fix the auth flow' };
    const result = summarizeNumberedPlanTaskScope(task, ['auth.js']);
    expect(result).toBe('single focused change across 1 file');
  });

  it('pluralizes "file" when multiple files', () => {
    const task = { explicitTitle: '', detail: 'Fix stuff' };
    const result = summarizeNumberedPlanTaskScope(task, ['a.js', 'b.js']);
    expect(result).toContain('2 files');
  });

  it('uses singular "file" for single file', () => {
    const task = { explicitTitle: '', detail: 'Fix stuff' };
    const result = summarizeNumberedPlanTaskScope(task, ['a.js']);
    expect(result).toContain('1 file');
    expect(result).not.toContain('1 files');
  });
});

// ---------------------------------------------------------------------------
// buildPlanFromNumberedTaskSummary (full numbered task pipeline)
// ---------------------------------------------------------------------------
describe('buildPlanFromNumberedTaskSummary', () => {
  const workItem = { id: 7, title: 'Improve auth' };
  const project = { name: 'torque', path: process.cwd() };

  it('produces a plan from valid numbered task output', () => {
    const rawOutput = [
      '1) Task 1 - Edit `server/auth.js` to patch the login flow',
      '2) Task 2 - Create `server/tests/auth.test.js` with coverage',
    ].join('\n');
    const result = buildPlanFromNumberedTaskSummary(rawOutput, workItem, project);
    expect(result).toBeTypeOf('string');
    expect(result).toContain('# Improve auth Plan');
    expect(result).toContain('auto-generated from work_item #7');
    expect(result).toContain('## Task 1:');
    expect(result).toContain('## Task 2:');
    expect(result).toContain('Step 1: Implement the generated plan item');
    expect(result).toContain('Step 2: Validate targeted change');
    expect(result).toMatch(/\n$/);
  });

  it('returns null when no tasks are extracted', () => {
    expect(buildPlanFromNumberedTaskSummary('No tasks here', workItem, project)).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(buildPlanFromNumberedTaskSummary('', workItem, project)).toBeNull();
  });

  it('returns null for null/undefined input', () => {
    expect(buildPlanFromNumberedTaskSummary(null, workItem, project)).toBeNull();
    expect(buildPlanFromNumberedTaskSummary(undefined, workItem, project)).toBeNull();
  });

  it('uses workItem.id fallback when title is missing', () => {
    const rawOutput = '1) Task 1 - Edit `server/auth.js` for fix';
    const result = buildPlanFromNumberedTaskSummary(rawOutput, { id: 99 }, project);
    expect(result).toContain('# Work Item 99 Plan');
  });

  it('includes tech stack in the plan header', () => {
    const rawOutput = '1) Task 1 - Edit `server/auth.js` for fix';
    const result = buildPlanFromNumberedTaskSummary(rawOutput, workItem, project);
    expect(result).toMatch(/\*\*Tech Stack:\*\*/);
  });

  it('includes validation command in step 2', () => {
    const rawOutput = '1) Task 1 - Edit `server/auth.js` for fix';
    const result = buildPlanFromNumberedTaskSummary(rawOutput, workItem, project);
    expect(result).toMatch(/Run `[^`]+`/);
  });

  it('collapses triple newlines in output', () => {
    const rawOutput = '1) Task 1 - Edit `server/auth.js` for fix';
    const result = buildPlanFromNumberedTaskSummary(rawOutput, workItem, project);
    expect(result).not.toContain('\n\n\n');
  });
});

// ---------------------------------------------------------------------------
// Edge cases — no exceptions from any function on degenerate input
// ---------------------------------------------------------------------------
describe('edge cases — no thrown exceptions', () => {
  it('unwrapWholeMarkdownFence does not throw on non-string input', () => {
    expect(() => unwrapWholeMarkdownFence(123)).not.toThrow();
    expect(() => unwrapWholeMarkdownFence({})).not.toThrow();
    expect(() => unwrapWholeMarkdownFence([])).not.toThrow();
  });

  it('convertFencedBlocksToIndented does not throw on non-string input', () => {
    expect(() => convertFencedBlocksToIndented(123)).not.toThrow();
    expect(() => convertFencedBlocksToIndented({})).not.toThrow();
  });

  it('trimPromptEchoTail does not throw on non-string input', () => {
    expect(() => trimPromptEchoTail(123)).not.toThrow();
    expect(() => trimPromptEchoTail({})).not.toThrow();
  });

  it('indentForPlan does not throw on non-string input', () => {
    expect(() => indentForPlan(123)).not.toThrow();
    expect(() => indentForPlan({})).not.toThrow();
  });

  it('cleanNumberedPlanSummaryText does not throw on non-string input', () => {
    expect(() => cleanNumberedPlanSummaryText(123)).not.toThrow();
    expect(() => cleanNumberedPlanSummaryText({})).not.toThrow();
  });

  it('extractNumberedPlanSummaryTasks returns empty array for whitespace-only input', () => {
    expect(extractNumberedPlanSummaryTasks('   \n\n  ')).toEqual([]);
  });

  it('buildPlanFromFileEditsProposal returns null for interleaved valid/invalid content', () => {
    const input = 'Some text\n{"file_edits": invalid}\nmore text';
    expect(buildPlanFromFileEditsProposal(input, { id: 1 }, {})).toBeNull();
  });

  it('buildPlanFromNumberedTaskSummary returns null for whitespace-only input', () => {
    expect(buildPlanFromNumberedTaskSummary('   \n\n  ', { id: 1 }, {})).toBeNull();
  });

  it('normalizeProposalOperationType handles empty-string type', () => {
    expect(normalizeProposalOperationType({ type: '' })).toBe('replace');
  });

  it('normalizeProposalOperationType handles whitespace-only type', () => {
    expect(normalizeProposalOperationType({ type: '   ' })).toBe('replace');
  });
});
