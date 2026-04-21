'use strict';

const { RULES } = require('./plan-quality-gate');

const DEFAULT_EXAMPLES = [
  '**Good** — concrete, testable, self-contained:',
  '',
  '    ### Task 3: Normalize test-name paths in verify-signature',
  '',
  '    **Files:**',
  '    - Modify: `server/factory/verify-signature.js`',
  '    - Test:   `server/tests/verify-signature.test.js`',
  '',
  '    - [ ] Step 1: Replace the non-greedy path regex with a',
  '          per-token strip-to-last-slash helper.',
  '    - [ ] Step 2: Run `torque-remote npx vitest run',
  '          server/tests/verify-signature.test.js`.',
  '          Expected: 6 passing tests.',
  '',
  '**Bad** — vague and untestable:',
  '',
  '    ### Task 3: Improve path handling',
  '',
  '    Clean up the path regex in verify-signature so it works',
  '    better on Windows paths. Update the tests as needed.',
].join('\n');

function renderRuleList(rulesSource) {
  const keys = Object.keys(rulesSource).sort();
  const lines = [];
  for (const key of keys) {
    const rule = rulesSource[key];
    if (typeof rule?.description !== 'string' || rule.description.length === 0) {
      throw new Error(`plan-authoring-guide: rule "${key}" is missing a description`);
    }
    const softPrefix = rule.severity === 'warn' ? '(soft) ' : '';
    lines.push(`- ${softPrefix}${rule.description}`);
  }
  return lines;
}

function composeGuide({ rulesSource = RULES, examplesBlock = DEFAULT_EXAMPLES } = {}) {
  const lines = [
    '## Plan authoring rules',
    '',
    'Every plan you produce goes through a quality gate. Plans that violate',
    'these rules are rejected and re-planning burns a Codex slot. Comply on',
    'the first pass.',
    '',
    ...renderRuleList(rulesSource),
    '',
    '## Good task body anatomy',
    '',
    examplesBlock,
  ];
  return lines.join('\n');
}

module.exports = { composeGuide, renderRuleList, DEFAULT_EXAMPLES };
