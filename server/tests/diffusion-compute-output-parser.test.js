import { describe, it, expect } from 'vitest';
const { parseComputeOutput, validateComputeSchema } = require('../diffusion/compute-output-parser');

describe('parseComputeOutput', () => {
  it('extracts clean JSON', () => {
    const output = JSON.stringify({
      file_edits: [{ file: 'a.cs', operations: [{ type: 'replace', old_text: 'old', new_text: 'new' }] }]
    });
    const result = parseComputeOutput(output);
    expect(result).not.toBeNull();
    expect(result.file_edits).toHaveLength(1);
  });

  it('extracts JSON wrapped in markdown fences', () => {
    const json = JSON.stringify({
      file_edits: [{ file: 'a.cs', operations: [{ type: 'replace', old_text: 'x', new_text: 'y' }] }]
    });
    const output = 'Here are the edits:\n```json\n' + json + '\n```\nDone!';
    const result = parseComputeOutput(output);
    expect(result).not.toBeNull();
    expect(result.file_edits[0].file).toBe('a.cs');
  });

  it('extracts JSON with conversational prefix/suffix', () => {
    const json = JSON.stringify({
      file_edits: [{ file: 'b.cs', operations: [{ type: 'replace', old_text: 'a', new_text: 'b' }] }]
    });
    const output = 'I analyzed the files. Here is the result:\n' + json + '\nLet me know if you need changes.';
    const result = parseComputeOutput(output);
    expect(result).not.toBeNull();
    expect(result.file_edits[0].file).toBe('b.cs');
  });

  it('returns null for unparseable output', () => {
    expect(parseComputeOutput('just some text, no json')).toBeNull();
  });

  it('returns null for empty output', () => {
    expect(parseComputeOutput('')).toBeNull();
    expect(parseComputeOutput(null)).toBeNull();
  });
});

describe('validateComputeSchema', () => {
  it('accepts valid compute output', () => {
    const data = {
      file_edits: [{
        file: 'a.cs',
        operations: [
          { type: 'replace', old_text: 'old code', new_text: 'new code' },
          { type: 'replace', old_text: 'delete this', new_text: '' },
        ]
      }]
    };
    const result = validateComputeSchema(data);
    expect(result.valid).toBe(true);
  });

  it('rejects missing file_edits', () => {
    const result = validateComputeSchema({ something_else: true });
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining('file_edits'));
  });

  it('rejects operations missing old_text', () => {
    const data = {
      file_edits: [{ file: 'a.cs', operations: [{ type: 'replace', new_text: 'x' }] }]
    };
    const result = validateComputeSchema(data);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining('old_text'));
  });

  it('rejects empty file_edits array', () => {
    const result = validateComputeSchema({ file_edits: [] });
    expect(result.valid).toBe(false);
  });
});
