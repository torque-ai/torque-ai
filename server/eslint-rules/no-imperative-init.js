'use strict';

/**
 * torque/no-imperative-init
 *
 * Flags modules that expose a public `init({…})` function paired with
 * module-level `let _x = null` state — the imperative composition pattern
 * the universal-DI migration is replacing. Modules should expose a
 * `createXxx({…})` factory + `register(container)` instead.
 *
 * Background: see docs/superpowers/specs/2026-05-04-universal-di-design.md
 *
 * Detection (heuristic, intentionally permissive):
 *   - Module exports an `init` function (via module.exports.init = ... or
 *     module.exports = { init, ... }).
 *   - AND the file contains at least one `let _<name>` declaration at
 *     module scope. The leading underscore is the convention used by every
 *     module currently following this pattern in TORQUE.
 *
 * The rule fires advisory in Phase 1 (warns by default; the existing
 * offenders are allowlisted in eslint.config.js). It becomes a hard error
 * in Phase 5 once every module is migrated.
 *
 * Inline suppression: // eslint-disable-next-line torque/no-imperative-init
 * Allowlist (eslint.config.js): module file basename, e.g. 'task-startup.js'.
 */

const path = require('path');

function getBasename(filePath) {
  return path.basename(typeof filePath === 'string' ? filePath : '');
}

module.exports = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Discourage the imperative init({…}) + module-let-state composition pattern. Use createXxx({…}) factory + register(container) instead. See docs/superpowers/specs/2026-05-04-universal-di-design.md.',
    },
    messages: {
      imperativeInit:
        'Module exposes init({…}) and module-level mutable state. Migrate to the factory + register pattern (see docs/superpowers/specs/2026-05-04-universal-di-design.md, Appendix A). To temporarily allow during migration, add this file\'s basename to the no-imperative-init allowlist in eslint.config.js.',
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

    let exportsInit = false;
    let hasUnderscoreLet = false;
    let firstReportNode = null;

    function note(node) {
      if (!firstReportNode) firstReportNode = node;
    }

    return {
      // Top-level `let _<name>` declarations (the module-state convention)
      VariableDeclaration(node) {
        // Only top-level variable decls — descendant decls (inside functions)
        // don't count as module state.
        if (node.parent && node.parent.type !== 'Program') return;
        if (node.kind !== 'let') return;
        for (const decl of node.declarations) {
          if (decl.id && decl.id.type === 'Identifier' && decl.id.name.startsWith('_')) {
            hasUnderscoreLet = true;
            note(node);
            return;
          }
        }
      },

      // module.exports = { init: ..., ... }
      AssignmentExpression(node) {
        if (node.operator !== '=') return;
        const left = node.left;
        if (
          left.type === 'MemberExpression' &&
          left.object.type === 'Identifier' &&
          left.object.name === 'module' &&
          left.property.type === 'Identifier' &&
          left.property.name === 'exports'
        ) {
          if (node.right.type === 'ObjectExpression') {
            for (const prop of node.right.properties) {
              if (prop.type === 'Property' && prop.key && prop.key.type === 'Identifier' && prop.key.name === 'init') {
                exportsInit = true;
                note(node);
                return;
              }
              // Shorthand: { init }
              if (prop.type === 'Property' && prop.shorthand && prop.key && prop.key.name === 'init') {
                exportsInit = true;
                note(node);
                return;
              }
            }
          }
          return;
        }
        // module.exports.init = function (...) { ... }
        if (
          left.type === 'MemberExpression' &&
          left.object.type === 'MemberExpression' &&
          left.object.object.type === 'Identifier' &&
          left.object.object.name === 'module' &&
          left.object.property.type === 'Identifier' &&
          left.object.property.name === 'exports' &&
          left.property.type === 'Identifier' &&
          left.property.name === 'init'
        ) {
          exportsInit = true;
          note(node);
        }
      },

      'Program:exit'() {
        if (exportsInit && hasUnderscoreLet && firstReportNode) {
          context.report({
            node: firstReportNode,
            messageId: 'imperativeInit',
          });
        }
      },
    };
  },
};
