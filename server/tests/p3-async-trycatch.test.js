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
]);

describe('Async handler safety', () => {
  it('wraps every async handler with a top-level try/catch', () => {
    const handlerDir = path.join(__dirname, '../handlers');
    const handlerFiles = fs.readdirSync(handlerDir).filter((file) => file.endsWith('.js'));

    const missing = [];

    for (const file of handlerFiles) {
      if (EXEMPT_HANDLER_FILES.has(file)) continue;

      const filePath = path.join(handlerDir, file);
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
          missing.push(`${file}:${line}:${stmt.id.name}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });
});
