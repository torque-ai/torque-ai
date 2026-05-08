'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  renderTable,
  spliceIntoDoc,
  BEGIN_MARKER,
  END_MARKER,
} = require('../factory/scripts/render-decision-actions-doc');
const { DECISION_ACTIONS } = require('../factory/decision-actions');

describe('renderTable', () => {
  it('renders a markdown table with stage / action / classifier / outcome columns', () => {
    const catalog = {
      scanned_plans: { stage: 'SENSE', classifier: 'benign', outcome: ['plans_dir', 'scanned'] },
      execute_zero_diff_short_circuit: {
        stage: 'EXECUTE', classifier: 'recovery-rule', rule_id: 'execute_zero_diff_short_circuit',
        outcome: ['work_item_id', 'reason'],
      },
    };
    const md = renderTable(catalog);
    expect(md).toMatch(/\| Stage \| Action \| Classifier \| Outcome shape \|/);
    expect(md).toMatch(/\| SENSE \| `scanned_plans` \| `benign` \| `plans_dir`, `scanned` \|/);
    expect(md).toMatch(/\| EXECUTE \| `execute_zero_diff_short_circuit` \| `recovery-rule` \(rule: `execute_zero_diff_short_circuit`\) \| `work_item_id`, `reason` \|/);
  });

  it('preserves catalog declaration order in the rendered table', () => {
    const catalog = {
      a: { stage: 'EXECUTE', classifier: 'benign', outcome: [] },
      b: { stage: 'SENSE', classifier: 'benign', outcome: [] },
      c: { stage: 'EXECUTE', classifier: 'benign', outcome: [] },
    };
    const md = renderTable(catalog);
    const linesIdx = (s) => md.indexOf(s);
    expect(linesIdx('| EXECUTE | `a`')).toBeLessThan(linesIdx('| SENSE | `b`'));
    expect(linesIdx('| SENSE | `b`')).toBeLessThan(linesIdx('| EXECUTE | `c`'));
  });
});

describe('docs/factory-loop-states.md autogen sync', () => {
  it('the autogen block content matches renderTable(DECISION_ACTIONS)', () => {
    const docPath = path.resolve(__dirname, '../../docs/factory-loop-states.md');
    const text = fs.readFileSync(docPath, 'utf8');

    const beginIdx = text.indexOf(BEGIN_MARKER);
    const endIdx = text.indexOf(END_MARKER);
    expect(beginIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(-1);

    const expected = renderTable(DECISION_ACTIONS);
    const actualBlock = text.slice(beginIdx + BEGIN_MARKER.length, endIdx).trim();
    const expectedBlock = expected.trim();

    if (actualBlock !== expectedBlock) {
      throw new Error(
        `docs/factory-loop-states.md autogen block is stale. Run:\n  node server/factory/scripts/render-decision-actions-doc.js --write\n  git add docs/factory-loop-states.md`,
      );
    }
  });
});
