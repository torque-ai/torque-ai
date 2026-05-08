'use strict';

const { renderTable } = require('../factory/scripts/render-decision-actions-doc');

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
