import { describe, it, expect } from 'vitest';
const { parseComputeOutput, validateComputeSchema } = require('../diffusion/compute-output-parser');
const { expandApplyTaskDescription } = require('../diffusion/planner');

describe('compute→apply close-handler hook (unit)', () => {
  it('full pipeline: parse output → validate → generate apply description', () => {
    const computeOutput = JSON.stringify({
      file_edits: [{
        file: 'src/Foo.cs',
        operations: [
          { type: 'replace', old_text: 'class Foo : INPC', new_text: 'class Foo : BindableBase' },
          { type: 'replace', old_text: 'private bool SetProperty<T>(...) { ... }', new_text: '' },
        ]
      }]
    });

    const parsed = parseComputeOutput(computeOutput);
    expect(parsed).not.toBeNull();

    const validation = validateComputeSchema(parsed);
    expect(validation.valid).toBe(true);

    const applyDesc = expandApplyTaskDescription(parsed, '/proj');
    expect(applyDesc).toContain('src/Foo.cs');
    expect(applyDesc).toContain('class Foo : BindableBase');
    expect(applyDesc).toContain('DELETE');
  });

  it('rejects invalid compute output gracefully', () => {
    const parsed = parseComputeOutput('not json at all');
    expect(parsed).toBeNull();
  });

  it('rejects compute output with missing operations', () => {
    const parsed = parseComputeOutput(JSON.stringify({ file_edits: [{ file: 'a.cs' }] }));
    if (parsed) {
      const validation = validateComputeSchema(parsed);
      expect(validation.valid).toBe(false);
    }
  });
});
