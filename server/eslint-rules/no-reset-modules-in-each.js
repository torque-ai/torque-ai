'use strict';

/**
 * torque/no-reset-modules-in-each
 *
 * Flags vi.resetModules() calls inside beforeEach() callbacks.
 * These force a full module cache clear before every test case, multiplying
 * cold-import costs by the test count in the file.
 *
 * Recommended alternatives:
 *   - vi.restoreAllMocks() / vi.clearAllMocks()  — reset mock state without reload
 *   - db.resetForTest()                          — DB isolation without module reload
 *   - beforeAll() + vi.resetModules()            — if module-init testing genuinely needed
 *
 * Inline suppression: // eslint-disable-next-line torque/no-reset-modules-in-each
 */

function isBeforeEachCallback(node) {
  // Check if this function node is a direct argument to a beforeEach() call.
  let current = node.parent;
  while (current) {
    if (
      current.type === 'CallExpression' &&
      current.callee &&
      current.callee.type === 'Identifier' &&
      current.callee.name === 'beforeEach'
    ) {
      return current.arguments.includes(node);
    }
    const t = current.type;
    if (
      t === 'FunctionDeclaration' ||
      t === 'FunctionExpression' ||
      t === 'ArrowFunctionExpression'
    ) {
      break;
    }
    current = current.parent;
  }
  return false;
}

function isInsideBeforeEach(node) {
  // Walk up ancestor chain; if we cross a Function boundary, check if that
  // Function is a beforeEach argument.
  let current = node.parent;
  while (current) {
    const t = current.type;
    if (
      t === 'FunctionExpression' ||
      t === 'ArrowFunctionExpression' ||
      t === 'FunctionDeclaration'
    ) {
      if (isBeforeEachCallback(current)) return true;
      return false;
    }
    if (t === 'Program') return false;
    current = current.parent;
  }
  return false;
}

module.exports = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow vi.resetModules() inside beforeEach(). Use vi.restoreAllMocks(), vi.clearAllMocks(), or db.resetForTest() instead. Move to beforeAll() only when genuine module-init testing is needed.',
    },
    messages: {
      resetModulesInEach:
        'vi.resetModules() inside beforeEach() forces a full module cache clear before every test case, multiplying cold-import costs. Use vi.restoreAllMocks() / vi.clearAllMocks() for mock isolation, or db.resetForTest() for DB isolation. If you genuinely need module-init testing, move to beforeAll().',
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        // Match vi.resetModules()
        if (
          node.callee.type !== 'MemberExpression' ||
          node.callee.object.type !== 'Identifier' ||
          node.callee.object.name !== 'vi' ||
          node.callee.property.type !== 'Identifier' ||
          node.callee.property.name !== 'resetModules'
        ) {
          return;
        }

        if (!isInsideBeforeEach(node)) return;

        context.report({ node, messageId: 'resetModulesInEach' });
      },
    };
  },
};
