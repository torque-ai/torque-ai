'use strict';

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow require("vitest") in test files; rely on vitest globals (globals: true in vitest.config.js).',
    },
    messages: {
      banned: 'Do not require("vitest"). The vitest config enables globals so describe/it/expect/vi are available without an import.',
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'require') return;
        const arg = node.arguments[0];
        if (arg && arg.type === 'Literal' && arg.value === 'vitest') {
          context.report({ node, messageId: 'banned' });
        }
      },
    };
  },
};
