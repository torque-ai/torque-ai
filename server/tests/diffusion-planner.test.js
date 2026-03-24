import { describe, it, expect } from 'vitest';
const {
  selectConvergenceStrategy,
  groupManifestByPattern,
  createBatches,
  expandTaskDescription,
  buildWorkflowTasks,
  expandComputeTaskDescription,
  expandApplyTaskDescription,
} = require('../diffusion/planner');

describe('selectConvergenceStrategy', () => {
  it('selects optimistic when confidence >= 0.8 and no shared deps', () => {
    expect(selectConvergenceStrategy(0.9, [])).toBe('optimistic');
  });

  it('selects dag when confidence < 0.8', () => {
    expect(selectConvergenceStrategy(0.5, [])).toBe('dag');
  });

  it('selects dag when shared deps exist regardless of confidence', () => {
    expect(selectConvergenceStrategy(0.95, [{ file: 'shared.js', change: 'update' }])).toBe('dag');
  });

  it('selects dag when confidence is undefined', () => {
    expect(selectConvergenceStrategy(undefined, [])).toBe('dag');
  });
});

describe('groupManifestByPattern', () => {
  it('groups manifest entries by pattern id', () => {
    const manifest = [
      { file: 'a.js', pattern: 'p1' },
      { file: 'b.js', pattern: 'p2' },
      { file: 'c.js', pattern: 'p1' },
    ];
    const groups = groupManifestByPattern(manifest);
    expect(groups.get('p1')).toEqual([
      { file: 'a.js', pattern: 'p1' },
      { file: 'c.js', pattern: 'p1' },
    ]);
    expect(groups.get('p2')).toEqual([{ file: 'b.js', pattern: 'p2' }]);
  });
});

describe('createBatches', () => {
  it('creates single-file batches by default', () => {
    const files = [{ file: 'a.js', pattern: 'p1' }, { file: 'b.js', pattern: 'p1' }];
    const batches = createBatches(files, 1);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toEqual([{ file: 'a.js', pattern: 'p1' }]);
  });

  it('groups files into batches of specified size', () => {
    const files = Array.from({ length: 7 }, (_, i) => ({ file: `f${i}.js`, pattern: 'p1' }));
    const batches = createBatches(files, 3);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(3);
    expect(batches[1]).toHaveLength(3);
    expect(batches[2]).toHaveLength(1);
  });
});

describe('expandTaskDescription', () => {
  it('generates a task description from pattern + files', () => {
    const pattern = {
      id: 'p1',
      description: 'Direct DB import files',
      transformation: 'Replace require(db) with container.get()',
    };
    const files = ['a.js', 'b.js'];
    const workingDir = '/project';
    const desc = expandTaskDescription(pattern, files, workingDir);
    expect(desc).toContain('Direct DB import files');
    expect(desc).toContain('Replace require(db) with container.get()');
    expect(desc).toContain('a.js');
    expect(desc).toContain('b.js');
    expect(desc).toContain('/project');
  });
});

describe('buildWorkflowTasks', () => {
  const basePlan = {
    summary: 'Migrate test files',
    patterns: [
      { id: 'p1', description: 'Direct import', transformation: 'Use DI', exemplar_files: ['ex.js'], exemplar_diff: 'diff', file_count: 3 },
    ],
    manifest: [
      { file: 'a.js', pattern: 'p1' },
      { file: 'b.js', pattern: 'p1' },
      { file: 'c.js', pattern: 'p1' },
    ],
    shared_dependencies: [],
    estimated_subtasks: 3,
    isolation_confidence: 0.95,
  };

  it('creates optimistic workflow when confidence is high and no shared deps', () => {
    const result = buildWorkflowTasks(basePlan, { workingDirectory: '/proj' });
    expect(result.strategy).toBe('optimistic');
    expect(result.tasks).toHaveLength(3);
    expect(result.tasks.every(t => t.depends_on.length === 0)).toBe(true);
  });

  it('creates DAG workflow with anchors when shared dependencies exist', () => {
    const plan = {
      ...basePlan,
      shared_dependencies: [{ file: 'shared.js', change: 'Add export' }],
      isolation_confidence: 0.5,
    };
    const result = buildWorkflowTasks(plan, { workingDirectory: '/proj' });
    expect(result.strategy).toBe('dag');
    const anchors = result.tasks.filter(t => t.metadata.diffusion_role === 'anchor');
    const fanouts = result.tasks.filter(t => t.metadata.diffusion_role === 'fanout');
    expect(anchors).toHaveLength(1);
    expect(fanouts).toHaveLength(3);
    expect(fanouts.every(t => t.depends_on.includes(anchors[0].id))).toBe(true);
  });

  it('respects convergence override', () => {
    const result = buildWorkflowTasks(basePlan, { workingDirectory: '/proj', convergence: 'dag' });
    expect(result.strategy).toBe('dag');
  });

  it('batches files according to batchSize', () => {
    const result = buildWorkflowTasks(basePlan, { workingDirectory: '/proj', batchSize: 2 });
    expect(result.tasks).toHaveLength(2); // 3 files / batch 2 = 2 tasks
    expect(result.tasks[0].metadata.files).toHaveLength(2);
    expect(result.tasks[1].metadata.files).toHaveLength(1);
  });

  it('stores exemplars in result', () => {
    const result = buildWorkflowTasks(basePlan, { workingDirectory: '/proj' });
    expect(result.exemplars.p1.exemplar_diff).toBe('diff');
  });
});

describe('buildWorkflowTasks with compute→apply pipeline', () => {
  const basePlan = {
    summary: 'Refactor ViewModels',
    patterns: [{
      id: 'p1', description: 'Remove SetProperty', transformation: 'Use BindableBase',
      exemplar_files: ['ex.cs'], exemplar_diff: 'diff',
      exemplar_before: 'class Before {}', exemplar_after: 'class After {}',
      file_count: 3,
    }],
    manifest: [
      { file: 'a.cs', pattern: 'p1' },
      { file: 'b.cs', pattern: 'p1' },
      { file: 'c.cs', pattern: 'p1' },
    ],
    shared_dependencies: [],
    estimated_subtasks: 3,
    isolation_confidence: 0.95,
  };

  it('creates compute tasks when computeProvider is set', () => {
    const result = buildWorkflowTasks(basePlan, {
      workingDirectory: '/proj',
      computeProvider: 'cerebras',
      applyProvider: 'ollama',
    });
    expect(result.strategy).toBe('optimistic');
    const computeTasks = result.tasks.filter(t => t.metadata.diffusion_role === 'compute');
    expect(computeTasks.length).toBeGreaterThan(0);
    expect(computeTasks[0].provider).toBe('cerebras');
    expect(computeTasks[0].metadata.apply_provider).toBe('ollama');
  });

  it('falls back to single-stage fanout when no computeProvider', () => {
    const result = buildWorkflowTasks(basePlan, { workingDirectory: '/proj' });
    const computeTasks = result.tasks.filter(t => t.metadata.diffusion_role === 'compute');
    expect(computeTasks).toHaveLength(0);
    const fanoutTasks = result.tasks.filter(t => t.metadata.diffusion_role === 'fanout');
    expect(fanoutTasks.length).toBeGreaterThan(0);
  });

  it('includes verify_command in compute task metadata', () => {
    const result = buildWorkflowTasks(basePlan, {
      workingDirectory: '/proj',
      computeProvider: 'cerebras',
      verifyCommand: 'dotnet build',
    });
    const computeTasks = result.tasks.filter(t => t.metadata.diffusion_role === 'compute');
    expect(computeTasks[0].metadata.verify_command).toBe('dotnet build');
  });
});

describe('expandComputeTaskDescription', () => {
  it('embeds file content and exemplar in compute prompt', () => {
    const pattern = {
      id: 'p1',
      description: 'Remove SetProperty duplicate',
      transformation: 'Inherit from BindableBase',
      exemplar_before: 'class Foo : INotifyPropertyChanged { ... SetProperty ... }',
      exemplar_after: 'class Foo : BindableBase { ... }',
    };
    const fileContents = { 'a.cs': 'using System;\nclass A : INPC { SetProperty<T>... }' };
    const desc = expandComputeTaskDescription(pattern, fileContents, '/proj');
    expect(desc).toContain('class Foo : INotifyPropertyChanged');
    expect(desc).toContain('class Foo : BindableBase');
    expect(desc).toContain('class A : INPC');
    expect(desc).toContain('file_edits');
    expect(desc).toContain('Output ONLY the JSON');
  });
});

describe('expandApplyTaskDescription', () => {
  it('generates apply prompt from parsed compute output', () => {
    const computeOutput = {
      file_edits: [
        { file: 'a.cs', operations: [
          { type: 'replace', old_text: 'using System.ComponentModel;', new_text: '' },
          { type: 'replace', old_text: 'class A : INPC', new_text: 'class A : BindableBase' },
        ]}
      ]
    };
    const desc = expandApplyTaskDescription(computeOutput, '/proj');
    expect(desc).toContain('a.cs');
    expect(desc).toContain('using System.ComponentModel;');
    expect(desc).toContain('class A : BindableBase');
    expect(desc).toContain('DELETE');
    expect(desc).toContain('pre-computed');
  });

  it('uses DELETE instruction for empty new_text', () => {
    const computeOutput = {
      file_edits: [
        { file: 'b.cs', operations: [
          { type: 'replace', old_text: 'remove this line', new_text: '' },
        ]}
      ]
    };
    const desc = expandApplyTaskDescription(computeOutput, '/proj');
    expect(desc).toContain('DELETE');
  });
});

describe('expandTaskDescription v2 (exemplar embedding)', () => {
  it('embeds full before/after content when available', () => {
    const pattern = {
      id: 'p1',
      description: 'Direct DB import files',
      transformation: 'Replace require(db) with container.get()',
      exemplar_before: 'using System;\nclass OldCode { void Save() { db.Save(); } }',
      exemplar_after: 'using System;\nusing Shared;\nclass NewCode { void Save() { svc.Save(); } }',
    };
    const files = ['a.cs', 'b.cs'];
    const desc = expandTaskDescription(pattern, files, '/project');
    expect(desc).toContain('Exemplar — BEFORE');
    expect(desc).toContain('class OldCode');
    expect(desc).toContain('Exemplar — AFTER');
    expect(desc).toContain('class NewCode');
    expect(desc).toContain('Do NOT deviate');
  });

  it('falls back to v1 format when exemplar_before/after not present', () => {
    const pattern = {
      id: 'p1',
      description: 'Direct DB import files',
      transformation: 'Replace require(db) with container.get()',
    };
    const files = ['a.cs'];
    const desc = expandTaskDescription(pattern, files, '/project');
    expect(desc).not.toContain('Exemplar — BEFORE');
    expect(desc).toContain('Direct DB import files');
    expect(desc).toContain('Replace require(db)');
  });
});
