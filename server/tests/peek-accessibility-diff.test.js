'use strict';

const {
  WPF_FIXTURE,
  WIN32_FIXTURE,
  countTreeNodes,
} = require('../contracts/peek-fixtures');
const {
  hashTree,
  countNodes,
  flattenTree,
  diffTrees,
  createDiffSnapshot,
} = require('../plugins/snapscope/handlers/accessibility-diff');

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function createBaseTree() {
  return [{
    name: 'Main Window',
    type: 'Window',
    automation_id: 'MainWindow',
    bounds: { x: 0, y: 0, w: 320, h: 200 },
    children: [
      {
        name: 'Actions',
        type: 'Pane',
        automation_id: 'ActionsPane',
        bounds: { x: 12, y: 12, w: 296, h: 80 },
        children: [
          {
            name: 'Submit',
            type: 'Button',
            automation_id: 'SubmitButton',
            bounds: { x: 24, y: 24, w: 96, h: 32 },
            children: [],
          },
        ],
      },
    ],
  }];
}

function createTreeWithAddedNode() {
  const tree = createBaseTree();
  tree[0].children[0].children.push({
    name: 'Cancel',
    type: 'Button',
    automation_id: 'CancelButton',
    bounds: { x: 136, y: 24, w: 96, h: 32 },
    children: [],
  });
  return tree;
}

describe('peek accessibility tree diff helper', () => {
  it('hashTree returns a stable SHA256 digest for the same tree', () => {
    const tree = createBaseTree();

    const first = hashTree(tree);
    const second = hashTree(cloneValue(tree));

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashTree returns a different hash for a different tree', () => {
    const before = createBaseTree();
    const after = createBaseTree();
    after[0].children[0].children[0].bounds.x = 40;

    expect(hashTree(before)).not.toBe(hashTree(after));
  });

  it('countNodes counts nested nodes recursively', () => {
    const tree = createBaseTree();

    expect(countNodes(tree)).toBe(3);
    expect(countNodes(tree[0])).toBe(3);
  });

  it('flattenTree creates a map keyed by automation id', () => {
    const flat = flattenTree(createBaseTree());

    expect(flat).toBeInstanceOf(Map);
    expect([...flat.keys()]).toEqual(['MainWindow', 'ActionsPane', 'SubmitButton']);
    expect(flat.get('SubmitButton')).toEqual({
      name: 'Submit',
      type: 'Button',
      automation_id: 'SubmitButton',
      bounds: { x: 24, y: 24, w: 96, h: 32 },
      child_count: 0,
    });
  });

  it('diffTrees returns changed=false for identical trees', () => {
    const before = createBaseTree();
    const after = cloneValue(before);

    expect(diffTrees(before, after)).toEqual({
      changed: false,
      before_tree_hash: hashTree(before),
      after_tree_hash: hashTree(after),
      diff_summary: 'No changes detected',
      nodes_added: 0,
      nodes_removed: 0,
      nodes_changed: 0,
      details: [],
    });
  });

  it('diffTrees detects added nodes', () => {
    const before = createBaseTree();
    const after = createTreeWithAddedNode();

    const diff = diffTrees(before, after);

    expect(diff.changed).toBe(true);
    expect(diff.nodes_added).toBe(1);
    expect(diff.nodes_removed).toBe(0);
    expect(diff.details).toContainEqual(expect.objectContaining({
      type: 'added',
      key: 'CancelButton',
      node: expect.objectContaining({
        name: 'Cancel',
        type: 'Button',
      }),
    }));
  });

  it('diffTrees detects removed nodes', () => {
    const before = createTreeWithAddedNode();
    const after = createBaseTree();

    const diff = diffTrees(before, after);

    expect(diff.changed).toBe(true);
    expect(diff.nodes_added).toBe(0);
    expect(diff.nodes_removed).toBe(1);
    expect(diff.details).toContainEqual(expect.objectContaining({
      type: 'removed',
      key: 'CancelButton',
      node: expect.objectContaining({
        automation_id: 'CancelButton',
      }),
    }));
  });

  it('diffTrees detects changed nodes when bounds move', () => {
    const before = createBaseTree();
    const after = createBaseTree();
    after[0].children[0].children[0].bounds.x = 48;

    const diff = diffTrees(before, after);

    expect(diff.changed).toBe(true);
    expect(diff.nodes_added).toBe(0);
    expect(diff.nodes_removed).toBe(0);
    expect(diff.nodes_changed).toBe(1);
    expect(diff.details).toContainEqual(expect.objectContaining({
      type: 'changed',
      key: 'SubmitButton',
      before: expect.objectContaining({
        bounds: expect.objectContaining({ x: 24 }),
      }),
      after: expect.objectContaining({
        bounds: expect.objectContaining({ x: 48 }),
      }),
    }));
  });

  it('createDiffSnapshot includes the action name and node counts', () => {
    const before = createBaseTree();
    const after = createTreeWithAddedNode();

    const snapshot = createDiffSnapshot(before, after, 'retry_click');

    expect(snapshot).toEqual(expect.objectContaining({
      action: 'retry_click',
      before_node_count: 3,
      after_node_count: 4,
      nodes_added: 1,
      nodes_removed: 0,
      changed: true,
    }));
    expect(Number.isNaN(Date.parse(snapshot.captured_at))).toBe(false);
  });

  it('works with the real WPF and Win32 fixture trees', () => {
    const wpfTree = WPF_FIXTURE.evidence.elements.tree;
    const win32Tree = WIN32_FIXTURE.evidence.elements.tree;

    expect(countNodes(wpfTree)).toBe(countTreeNodes(wpfTree));
    expect(countNodes(wpfTree)).toBe(WPF_FIXTURE.evidence.elements.count);
    expect(countNodes(win32Tree)).toBe(countTreeNodes(win32Tree));
    expect(countNodes(win32Tree)).toBe(WIN32_FIXTURE.evidence.elements.count);

    const wpfFlat = flattenTree(wpfTree);
    const win32Flat = flattenTree(win32Tree);

    expect(wpfFlat.get('ClosePeriodButton')).toEqual(expect.objectContaining({
      name: 'Close Period',
      type: 'Button',
    }));
    expect(win32Flat.get('PausePrinterButton')).toEqual(expect.objectContaining({
      name: 'Pause Printer',
      type: 'Button',
    }));
  });

  it('diffTrees handles empty trees correctly', () => {
    const diff = diffTrees([], []);

    expect(diff).toEqual({
      changed: false,
      before_tree_hash: hashTree([]),
      after_tree_hash: hashTree([]),
      diff_summary: 'No changes detected',
      nodes_added: 0,
      nodes_removed: 0,
      nodes_changed: 0,
      details: [],
    });
  });

  it('detects nested changes inside a real fixture tree', () => {
    const before = WPF_FIXTURE.evidence.elements.tree;
    const after = cloneValue(before);
    after[0].children[0].children[2].bounds.x += 24;

    const diff = diffTrees(before, after);

    expect(diff.changed).toBe(true);
    expect(diff.nodes_changed).toBe(1);
    expect(diff.details).toContainEqual(expect.objectContaining({
      type: 'changed',
      key: 'ClosePeriodButton',
      before: expect.objectContaining({
        bounds: expect.objectContaining({ x: 1184 }),
      }),
      after: expect.objectContaining({
        bounds: expect.objectContaining({ x: 1208 }),
      }),
    }));
  });
});
