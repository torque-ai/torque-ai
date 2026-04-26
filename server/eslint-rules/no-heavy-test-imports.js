'use strict';

/**
 * torque/no-heavy-test-imports
 *
 * Disallows top-level (module-scope) require() of heavy modules from test files.
 * Heavy modules: ../tools, ../task-manager, ../database, ../dashboard-server.
 *
 * Exception: files on the `allowlist` option array (basenames only, no path).
 * Inline suppression: // eslint-disable-next-line torque/no-heavy-test-imports -- <reason>
 */

const HEAVY_MODULES = new Set([
  '../tools',
  '../task-manager',
  '../database',
  '../dashboard-server',
]);

const path = require('path');

function getBasename(filePath) {
  return path.basename(typeof filePath === 'string' ? filePath : '');
}

/**
 * Returns true if the node is a top-level (Program-body) statement,
 * not nested inside a function, block inside a function, etc.
 * Walks up the ancestor chain and returns false if any FunctionDeclaration,
 * FunctionExpression, or ArrowFunctionExpression is encountered.
 */
function isTopLevel(node) {
  let current = node.parent;
  while (current) {
    const t = current.type;
    if (
      t === 'FunctionDeclaration' ||
      t === 'FunctionExpression' ||
      t === 'ArrowFunctionExpression'
    ) {
      return false;
    }
    if (t === 'Program') return true;
    current = current.parent;
  }
  return true;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow top-level require() of heavy modules (tools, task-manager, database, dashboard-server) from test files. Use tool-registry or lazy-require instead.',
    },
    messages: {
      heavyImport:
        '"{{module}}" is a heavy module (~335ms+ cold-import). Import tool-registry instead (for metadata), or move the require() inside the test/beforeEach that needs it. If this file genuinely needs handleToolCall, add it to the no-heavy-test-imports allowlist in eslint.config.js.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allowlist: {
            type: 'array',
            items: { type: 'string' },
            default: [],
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const options = context.options[0] || {};
    const allowlist = new Set(options.allowlist || []);
    const filename = context.filename || (context.getFilename ? context.getFilename() : '');
    const basename = getBasename(filename);

    if (allowlist.has(basename)) return {};

    return {
      CallExpression(node) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'require') return;
        const arg = node.arguments[0];
        if (!arg || arg.type !== 'Literal' || typeof arg.value !== 'string') return;
        if (!HEAVY_MODULES.has(arg.value)) return;
        if (!isTopLevel(node)) return;

        context.report({
          node,
          messageId: 'heavyImport',
          data: { module: arg.value },
        });
      },
    };
  },
};
