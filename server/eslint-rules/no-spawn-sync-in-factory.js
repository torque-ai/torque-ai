'use strict';

function normalizeFilename(context) {
  const filename = typeof context.filename === 'string' ? context.filename : context.getFilename();
  return typeof filename === 'string' ? filename.replace(/\\/g, '/') : '';
}

function isScopedFile(filename) {
  return filename.includes('server/factory/') || filename.includes('server/handlers/factory-');
}

function isSpawnSyncCallee(callee) {
  if (!callee) return false;

  if (callee.type === 'Identifier') {
    return callee.name === 'spawnSync';
  }

  if (callee.type === 'ChainExpression') {
    return isSpawnSyncCallee(callee.expression);
  }

  if (callee.type !== 'MemberExpression') {
    return false;
  }

  if (!callee.computed && callee.property.type === 'Identifier') {
    return callee.property.name === 'spawnSync';
  }

  if (callee.computed && callee.property.type === 'Literal') {
    return callee.property.value === 'spawnSync';
  }

  return false;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow spawnSync in factory code paths because it blocks the Node.js event loop.',
    },
    messages: {
      spawnSync: 'spawnSync blocks the Node event loop; use spawn with async/await. Verify and worktree ops here have 30-minute timeouts that would freeze the server.',
    },
    schema: [],
  },
  create(context) {
    const filename = normalizeFilename(context);
    if (!isScopedFile(filename)) {
      return {};
    }

    return {
      CallExpression(node) {
        if (!isSpawnSyncCallee(node.callee)) return;

        context.report({
          node,
          messageId: 'spawnSync',
        });
      },
    };
  },
};
