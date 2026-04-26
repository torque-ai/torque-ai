'use strict';

// Hot-path globs — matches umbrella spec §3.1
const HOT_PATH_PATTERNS = [
  'server/handlers/',
  'server/execution/',
  'server/governance/',
  'server/audit/',
  'server/api/',
  'server/dashboard-server.js',
  'server/queue-scheduler',
  'server/maintenance/orphan-cleanup.js',
];

// All sync fs method names to flag
const SYNC_FS_METHODS = new Set([
  'readFileSync', 'writeFileSync', 'statSync', 'existsSync', 'readdirSync',
  'unlinkSync', 'mkdirSync', 'rmSync', 'lstatSync', 'realpathSync',
  'openSync', 'closeSync', 'readSync', 'writeSync', 'fstatSync', 'copyFileSync',
]);

// Sync subprocess methods to flag
const SYNC_CP_METHODS = new Set(['execSync', 'execFileSync', 'spawnSync']);

const MIN_REASON_LENGTH = 10;

function normalizeFilename(context) {
  const filename = typeof context.filename === 'string'
    ? context.filename
    : context.getFilename();
  return typeof filename === 'string' ? filename.replace(/\\/g, '/') : '';
}

function isHotPath(filename) {
  return HOT_PATH_PATTERNS.some((p) => filename.includes(p));
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow synchronous fs and child_process calls on hot-path files — they block the Node.js event loop under concurrent request load.',
    },
    messages: {
      noSyncFsOnHotPath:
        'Sync I/O call "{{name}}" blocks the event loop on hot-path files. Use the async equivalent (fs.promises.* or promisified subprocess).',
      shortDisableReason:
        'eslint-disable comment for torque/no-sync-fs-on-hot-paths must include a reason longer than {{min}} chars (e.g., "-- startup only, not a request hot-path").',
    },
    schema: [],
  },
  create(context) {
    const filename = normalizeFilename(context);
    if (!isHotPath(filename)) {
      return {};
    }

    // Track renamed destructured bindings from require('child_process')
    // e.g. const { execFileSync: efs } = require('child_process')  =>  efs -> 'execFileSync'
    const renamedCpBindings = new Map(); // localName -> canonicalName

    function checkInlineDisableComment(node, ruleName) {
      const sourceCode = context.getSourceCode ? context.getSourceCode() : context.sourceCode;
      const comments = sourceCode.getCommentsBefore(node);
      for (const comment of comments) {
        const text = comment.value.trim();
        if (text.includes(`eslint-disable-next-line ${ruleName}`)) {
          // Extract reason after '--'
          const dashIdx = text.indexOf('--');
          if (dashIdx === -1) {
            context.report({ node, messageId: 'shortDisableReason', data: { min: MIN_REASON_LENGTH } });
            return true;
          }
          const reason = text.slice(dashIdx + 2).trim();
          if (reason.length <= MIN_REASON_LENGTH) {
            context.report({ node, messageId: 'shortDisableReason', data: { min: MIN_REASON_LENGTH } });
          }
          return true; // has disable comment (whether valid or not, don't double-report)
        }
      }
      return false;
    }

    return {
      // Track: const { execFileSync } = require('child_process')
      // Track: const { execFileSync: efs } = require('child_process')
      VariableDeclarator(node) {
        if (
          node.init &&
          node.init.type === 'CallExpression' &&
          node.init.callee.type === 'Identifier' &&
          node.init.callee.name === 'require' &&
          node.init.arguments.length === 1 &&
          node.init.arguments[0].type === 'Literal' &&
          node.init.arguments[0].value === 'child_process' &&
          node.id.type === 'ObjectPattern'
        ) {
          for (const prop of node.id.properties) {
            if (prop.type === 'Property') {
              const keyName = prop.key.type === 'Identifier' ? prop.key.name : null;
              const valName = prop.value.type === 'Identifier' ? prop.value.name : null;
              if (keyName && valName && SYNC_CP_METHODS.has(keyName)) {
                renamedCpBindings.set(valName, keyName);
              }
            }
          }
        }
      },

      CallExpression(node) {
        const { callee } = node;

        // Case 1: fs.readFileSync(...) — MemberExpression
        if (
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.property.type === 'Identifier'
        ) {
          const methodName = callee.property.name;
          if (SYNC_FS_METHODS.has(methodName) || SYNC_CP_METHODS.has(methodName)) {
            if (!checkInlineDisableComment(node, 'torque/no-sync-fs-on-hot-paths')) {
              context.report({
                node,
                messageId: 'noSyncFsOnHotPath',
                data: { name: methodName },
              });
            }
          }
          return;
        }

        // Case 2: execFileSync(...) — bare Identifier (destructured direct import)
        if (callee.type === 'Identifier') {
          const name = callee.name;
          if (SYNC_CP_METHODS.has(name)) {
            if (!checkInlineDisableComment(node, 'torque/no-sync-fs-on-hot-paths')) {
              context.report({
                node,
                messageId: 'noSyncFsOnHotPath',
                data: { name },
              });
            }
            return;
          }
          // Case 3: renamed binding — e.g., efs(...) where efs = execFileSync
          if (renamedCpBindings.has(name)) {
            if (!checkInlineDisableComment(node, 'torque/no-sync-fs-on-hot-paths')) {
              context.report({
                node,
                messageId: 'noSyncFsOnHotPath',
                data: { name: `${name} (alias for ${renamedCpBindings.get(name)})` },
              });
            }
          }
        }
      },
    };
  },
};
