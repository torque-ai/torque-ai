/**
 * ESLint rule: torque/no-prepare-in-loop
 *
 * Detects db.prepare() calls inside loop bodies or array callback methods.
 * Hoisting prepares to module level is always correct for better-sqlite3
 * because PreparedStatement is reentrant and stateless between .run()/.get()/.all() calls.
 *
 * Disable with a comment that includes a reason of more than 10 chars:
 *   // eslint-disable-next-line torque/no-prepare-in-loop -- reason here
 */

'use strict';

const LOOP_TYPES = new Set([
  'ForOfStatement',
  'ForInStatement',
  'ForStatement',
  'WhileStatement',
  'DoWhileStatement',
]);

const ARRAY_CALLBACKS = new Set([
  'map', 'forEach', 'filter', 'reduce', 'reduceRight',
  'find', 'findIndex', 'some', 'every', 'flatMap',
]);

function isInsideLoop(node) {
  let current = node.parent;
  while (current) {
    if (LOOP_TYPES.has(current.type)) return true;
    if (
      current.type === 'CallExpression' &&
      current.callee.type === 'MemberExpression' &&
      ARRAY_CALLBACKS.has(current.callee.property.name)
    ) {
      const argIndex = current.arguments.indexOf(
        findAncestorArg(node, current)
      );
      if (argIndex >= 0) return true;
    }
    current = current.parent;
  }
  return false;
}

function findAncestorArg(node, callExpr) {
  let current = node;
  while (current && current.parent !== callExpr) {
    current = current.parent;
  }
  return current;
}

module.exports = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Disallow db.prepare() inside loops or array callbacks — hoist to module level',
      category: 'Performance',
    },
    schema: [],
    messages: {
      prepareInLoop:
        'db.prepare() inside a loop or callback. Hoist to module level — PreparedStatement is reentrant.',
      shortDisableReason:
        'Disable comment reason is too short (more than 10 chars required). Explain why this prepare cannot be hoisted.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (
          node.callee.type !== 'MemberExpression' ||
          node.callee.property.name !== 'prepare'
        ) return;

        if (!isInsideLoop(node)) return;

        const sourceCode = context.getSourceCode();
        const comments = sourceCode.getCommentsBefore(node);
        for (const comment of comments) {
          if (comment.value.includes('eslint-disable')) {
            const reasonMatch = comment.value.match(/--\s*(.+)/);
            if (reasonMatch && reasonMatch[1].trim().length > 10) return;
            context.report({ node, messageId: 'shortDisableReason' });
            return;
          }
        }

        context.report({ node, messageId: 'prepareInLoop' });
      },
    };
  },
};
