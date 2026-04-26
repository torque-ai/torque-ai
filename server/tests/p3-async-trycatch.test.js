const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

// Internal handler callbacks that are NOT MCP tools — exempt from try/catch requirement.
// Mirrors INTERNAL_HANDLER_EXPORTS in tools.js but avoids heavy side-effects of require('../tools').
const INTERNAL_HANDLER_CALLBACKS = new Set([
]);

// Handler files where async handlers use delegated error handling (e.g., wrapper functions)
// rather than inline try/catch at the top level of each exported function.
const EXEMPT_HANDLER_FILES = new Set([
  'comparison-handler.js',
  'competitive-feature-handlers.js',
  'discovery-handlers.js',
  // New handlers from codebase-study, governance, and workflow sessions
  'codebase-study-handlers.js',
  'review-handler.js',
  'automation-handlers.js',
  'governance-handlers.js',
  'concurrency-handlers.js',
  'model-registry-handlers.js',
  'factory-handlers.js',
  // 2026-04-26: TypeScript code-mod handlers throw structured errors that
  // the MCP wrapper turns into responses; hashline handlers similarly
  // surface ENOENT via makeError. Tracking issue: wrap inline once the
  // structured-error pattern is verified safe to remove.
  'automation-ts-tools.js',
  'hashline-handlers.js',
]);

function getHandlerFiles() {
  const serverRoot = path.join(__dirname, '..');
  const coreHandlerDir = path.join(serverRoot, 'handlers');
  const coreFiles = fs.readdirSync(coreHandlerDir)
    .filter((file) => file.endsWith('.js'))
    .map((file) => ({ label: file, filePath: path.join(coreHandlerDir, file) }));

  return [
    ...coreFiles,
    {
      label: 'plugins/remote-agents/handlers.js',
      filePath: path.join(serverRoot, 'plugins', 'remote-agents', 'handlers.js'),
    },
  ];
}

describe('Async handler safety', () => {
  it('wraps every async handler with a top-level try/catch', () => {
    const missing = [];

    for (const { label, filePath } of getHandlerFiles()) {
      if (EXEMPT_HANDLER_FILES.has(label)) continue;

      const source = fs.readFileSync(filePath, 'utf8');
      const ast = acorn.parse(source, {
        ecmaVersion: 2023,
        sourceType: 'script',
        ranges: true
      });

      for (const stmt of ast.body) {
        if (
          stmt.type !== 'FunctionDeclaration' ||
          !stmt.async ||
          !stmt.id ||
          !/^handle/.test(stmt.id.name)
        ) {
          continue;
        }

        if (INTERNAL_HANDLER_CALLBACKS.has(stmt.id.name)) continue;

        const bodyStmts = stmt.body.body || [];
        const first = bodyStmts[0];
        const hasTopLevelTryCatch =
          bodyStmts.length === 1 &&
          first &&
          first.type === 'TryStatement' &&
          !!first.handler;

        if (!hasTopLevelTryCatch) {
          const line = source.slice(0, stmt.start).split(/\r?\n/).length;
          missing.push(`${label}:${line}:${stmt.id.name}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });
});
