import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { analyzeElementTree } = require('../plugins/snapscope/handlers/pre-analyze');

function createNode(overrides = {}) {
  return {
    name: 'Root',
    type: 'Window',
    automation_id: 'RootWindow',
    bounds: { x: 0, y: 0, w: 200, h: 200 },
    children: [],
    ...overrides,
  };
}

function findByCheck(result, check) {
  return result.findings.filter((finding) => finding.check === check);
}

describe('analyzeElementTree', () => {
  it('detects missing accessible names on interactive elements', () => {
    const tree = createNode({
      children: [
        createNode({
          name: '',
          type: 'Button',
          automation_id: 'SaveButton',
          bounds: { x: 20, y: 20, w: 80, h: 32 },
          children: [],
        }),
      ],
    });

    const result = analyzeElementTree(tree, 'main');
    const findings = findByCheck(result, 'missing_name');

    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual(expect.objectContaining({
      severity: 'HIGH',
      automation_id: 'SaveButton',
      element_type: 'Button',
    }));
  });

  it('ignores missing names on non-interactive elements', () => {
    const tree = createNode({
      children: [
        createNode({
          name: '',
          type: 'Text',
          automation_id: 'CaptionText',
          bounds: { x: 20, y: 20, w: 80, h: 32 },
          children: [],
        }),
      ],
    });

    const result = analyzeElementTree(tree, 'main');

    expect(findByCheck(result, 'missing_name')).toHaveLength(0);
  });

  it('detects bounds overflow', () => {
    const tree = createNode({
      bounds: { x: 0, y: 0, w: 200, h: 120 },
      children: [
        createNode({
          name: 'Overflow Button',
          type: 'Button',
          automation_id: 'OverflowButton',
          bounds: { x: 180, y: 10, w: 50, h: 30 },
          children: [],
        }),
      ],
    });

    const result = analyzeElementTree(tree, 'main');
    const findings = findByCheck(result, 'bounds_overflow');

    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual(expect.objectContaining({
      severity: 'MEDIUM',
      element_name: 'Overflow Button',
      overflow_x: 30,
      overflow_y: 0,
    }));
  });

  it('detects empty containers', () => {
    const tree = createNode({
      children: [
        createNode({
          name: 'Results',
          type: 'List',
          automation_id: 'ResultsList',
          bounds: { x: 10, y: 10, w: 160, h: 90 },
          children: [],
        }),
      ],
    });

    const result = analyzeElementTree(tree, 'main');
    const findings = findByCheck(result, 'empty_container');

    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual(expect.objectContaining({
      severity: 'MEDIUM',
      automation_id: 'ResultsList',
      element_type: 'List',
    }));
  });

  it('does not flag non-container empty elements', () => {
    const tree = createNode({
      children: [
        createNode({
          name: 'Status',
          type: 'Text',
          automation_id: 'StatusText',
          bounds: { x: 10, y: 10, w: 120, h: 24 },
          children: [],
        }),
      ],
    });

    const result = analyzeElementTree(tree, 'main');

    expect(findByCheck(result, 'empty_container')).toHaveLength(0);
  });

  it('detects small interactive elements', () => {
    const tree = createNode({
      children: [
        createNode({
          name: 'Tiny Button',
          type: 'Button',
          automation_id: 'TinyButton',
          bounds: { x: 20, y: 20, w: 16, h: 16 },
          children: [],
        }),
      ],
    });

    const result = analyzeElementTree(tree, 'main');
    const findings = findByCheck(result, 'small_interactive');

    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual(expect.objectContaining({
      severity: 'LOW',
      automation_id: 'TinyButton',
      minimum_size: 24,
    }));
  });

  it('detects duplicate automation IDs', () => {
    const tree = createNode({
      children: [
        createNode({
          name: 'First',
          type: 'Button',
          automation_id: 'SharedId',
          bounds: { x: 20, y: 20, w: 60, h: 32 },
          children: [],
        }),
        createNode({
          name: 'Second',
          type: 'Button',
          automation_id: 'SharedId',
          bounds: { x: 100, y: 20, w: 60, h: 32 },
          children: [],
        }),
      ],
    });

    const result = analyzeElementTree(tree, 'main');
    const findings = findByCheck(result, 'duplicate_automation_id');

    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual(expect.objectContaining({
      severity: 'MEDIUM',
      automation_id: 'SharedId',
      count: 2,
    }));
  });

  it('walks nested children', () => {
    const tree = createNode({
      children: [
        createNode({
          name: 'Form',
          type: 'Pane',
          automation_id: 'FormPane',
          bounds: { x: 10, y: 10, w: 180, h: 180 },
          children: [
            createNode({
              name: 'Group',
              type: 'Pane',
              automation_id: 'GroupPane',
              bounds: { x: 20, y: 20, w: 160, h: 120 },
              children: [
                createNode({
                  name: '',
                  type: 'Edit',
                  automation_id: 'DeepInput',
                  bounds: { x: 30, y: 30, w: 100, h: 28 },
                  children: [],
                }),
              ],
            }),
          ],
        }),
      ],
    });

    const result = analyzeElementTree(tree, 'nested');
    const findings = findByCheck(result, 'missing_name');

    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual(expect.objectContaining({
      automation_id: 'DeepInput',
      severity: 'HIGH',
    }));
  });

  it('returns correct stats', () => {
    const tree = [
      createNode(),
      createNode({
        name: 'Submit',
        type: 'Button',
        automation_id: 'SubmitButton',
        bounds: { x: 10, y: 10, w: 80, h: 32 },
      }),
    ];

    const result = analyzeElementTree(tree, 'stats');

    expect(result.stats).toEqual({
      total_elements: 2,
      interactive: 1,
      checks_run: 5,
      findings: 0,
    });
  });

  it('returns empty findings for clean tree', () => {
    const tree = createNode({
      children: [
        createNode({
          name: 'Submit',
          type: 'Button',
          automation_id: 'SubmitButton',
          bounds: { x: 20, y: 20, w: 80, h: 32 },
          children: [],
        }),
        createNode({
          name: 'Description',
          type: 'Text',
          automation_id: 'DescriptionText',
          bounds: { x: 20, y: 70, w: 120, h: 24 },
          children: [],
        }),
      ],
    });

    const result = analyzeElementTree(tree, 'clean');

    expect(result.findings).toEqual([]);
    expect(result.flagged_elements).toEqual([]);
    expect(result.stats).toEqual({
      total_elements: 3,
      interactive: 1,
      checks_run: 5,
      findings: 0,
    });
  });
});
