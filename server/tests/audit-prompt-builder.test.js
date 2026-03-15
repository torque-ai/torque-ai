'use strict';

const {
  buildCategoryInstructions,
  buildResponseFormat,
  buildReviewPrompt,
} = require('../audit/prompt-builder');

describe('buildCategoryInstructions', () => {
  it('includes category labels and guidance on one line per category', () => {
    const categories = {
      security: {
        label: 'Security',
        prompt_guidance: 'Look for SQL injection and unsafe query construction.',
      },
      observability: {
        label: 'Observability',
        prompt_guidance: 'Look for missing logs on important failure paths.',
      },
    };

    const instructions = buildCategoryInstructions(categories);

    expect(instructions).toContain('- Security: Look for SQL injection and unsafe query construction.');
    expect(instructions).toContain('- Observability: Look for missing logs on important failure paths.');
  });
});

describe('buildResponseFormat', () => {
  it('describes a JSON array result shape with required fields', () => {
    const format = buildResponseFormat();

    expect(format).toContain('JSON array');
    expect(format).toContain('category');
    expect(format).toContain('severity');
    expect(format).toContain('line_start');
    expect(format).toContain('line_end');
    expect(format).toContain('suggestion');
    expect(format).toContain('If no issues are found, return: []');
  });
});

describe('buildReviewPrompt', () => {
  it('assembles preamble, file context, review instructions, and code sections', () => {
    const preamble = 'PROJECT PREAMBLE: review only security-sensitive changes.';
    const categories = {
      security: {
        label: 'Security',
        prompt_guidance: 'Look for SQL injection and unsafe input handling.',
      },
    };
    const unit = {
      files: [
        { relativePath: 'src/auth.js', importPaths: ['fs', 'path'] },
        { relativePath: 'src/api.js', importPaths: ['express'] },
      ],
    };
    const fileContents = {
      'src/auth.js': 'function login(user) { return user; }',
      'src/api.js': 'app.post("/login", login);',
    };

    const prompt = buildReviewPrompt({
      unit,
      preamble,
      categories,
      fileContents,
    });

    expect(prompt.startsWith(preamble)).toBe(true);
    expect(prompt).toContain('[FILE CONTEXT]');
    expect(prompt).toContain('This file imports from: fs, path');
    expect(prompt).toContain('This file imports from: express');
    expect(prompt).toContain('[REVIEW INSTRUCTIONS]');
    expect(prompt).toContain('Look for SQL injection and unsafe input handling.');
    expect(prompt).toContain('[RESPONSE FORMAT]');
    expect(prompt).toContain('[CODE]');
    expect(prompt).toContain('--- file: src/auth.js ---');
    expect(prompt).toContain('function login(user) { return user; }');
    expect(prompt).toContain('--- file: src/api.js ---');
    expect(prompt).toContain('app.post("/login", login);');

    const preambleIndex = prompt.indexOf(preamble);
    const contextIndex = prompt.indexOf('[FILE CONTEXT]');
    const reviewIndex = prompt.indexOf('[REVIEW INSTRUCTIONS]');
    const codeIndex = prompt.indexOf('[CODE]');

    expect(preambleIndex).toBeLessThan(contextIndex);
    expect(contextIndex).toBeLessThan(reviewIndex);
    expect(reviewIndex).toBeLessThan(codeIndex);
  });

  it('includes chunk context and chunk content for chunked units', () => {
    const categories = {
      security: {
        label: 'Security',
        prompt_guidance: 'Detect unsafe trust-boundary handling.',
      },
    };
    const unit = {
      chunked: true,
      chunkContext: 'Chunk 2 of 4 for src/worker.js (lines 401-800).',
      chunkContent: 'const secret = process.env.SECRET;',
      files: [{ relativePath: 'src/worker.js', importPaths: ['crypto'] }],
    };

    const prompt = buildReviewPrompt({
      unit,
      preamble: 'PROJECT PREAMBLE',
      categories,
      fileContents: { 'src/worker.js': 'ignored for chunked unit' },
    });

    expect(prompt).toContain('[CHUNK CONTEXT]');
    expect(prompt).toContain('Chunk 2 of 4 for src/worker.js (lines 401-800).');
    expect(prompt).toContain('const secret = process.env.SECRET;');
    expect(prompt).not.toContain('--- file: src/worker.js ---');
  });

  it('batches multiple files in one non-chunk prompt', () => {
    const categories = {
      security: {
        label: 'Security',
        prompt_guidance: 'Detect unsafe trust-boundary handling.',
      },
    };
    const unit = {
      files: [
        { relativePath: 'src/a.js', importPaths: [] },
        { relativePath: 'src/b.js', importPaths: ['react'] },
      ],
    };
    const fileContents = {
      'src/a.js': 'const a = 1;',
      'src/b.js': 'export default function b() {}',
    };

    const prompt = buildReviewPrompt({
      unit,
      preamble: 'PROJECT PREAMBLE',
      categories,
      fileContents,
    });

    const aIndex = prompt.indexOf('--- file: src/a.js ---');
    const bIndex = prompt.indexOf('--- file: src/b.js ---');
    const reviewIndex = prompt.indexOf('[REVIEW INSTRUCTIONS]');
    const codeIndex = prompt.indexOf('[CODE]');

    expect(aIndex).toBeGreaterThan(codeIndex);
    expect(bIndex).toBeGreaterThan(aIndex);
    expect(prompt).toContain('This file imports from: ');
    expect(prompt).toContain('This file imports from: react');
    expect(prompt).toContain('const a = 1;');
    expect(prompt).toContain('export default function b() {}');
    expect(reviewIndex).toBeLessThan(codeIndex);
  });

  it('returns an empty category section when categories are invalid and throws on missing unit', () => {
    const withInvalidCategories = buildReviewPrompt({
      unit: { files: [] },
      preamble: 'PROJECT PREAMBLE',
      categories: null,
      fileContents: {},
    });

    expect(withInvalidCategories).toContain('[REVIEW INSTRUCTIONS]');
    expect(withInvalidCategories).toContain('No files provided.');
    expect(withInvalidCategories).toContain('[CODE]');

    expect(() => buildReviewPrompt('not-an-object'))
      .toThrow(TypeError);
  });
});
