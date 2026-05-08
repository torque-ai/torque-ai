'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SOURCE_GLOBS = [
  'server/factory',
  'server/plugins/auto-recovery-core',
];

// Match logDecision({ ... action: 'foo' ... }), logDecision(db, { ... action: 'foo' ... }),
// and aliased forms like logDecisionFn(...) used in some emit sites. The \w*
// suffix lets us catch `logDecisionFn` (loop-controller.js) without re-introducing
// the `logDecision\s*\(` literal that triggered self-scan false positives.
const EMIT_LITERAL_RE = /logDecision\w*\s*\(\s*(?:[a-zA-Z_$][\w$]*\s*,\s*)?\{[^}]*\baction\s*:\s*['"]([\w-]+)['"]/g;

// Match logDecision*(...) calls where action: is followed by a non-string-literal expression.
const EMIT_DYNAMIC_RE = /logDecision\w*\s*\(\s*(?:[a-zA-Z_$][\w$]*\s*,\s*)?\{[^}]*\baction\s*:\s*(?!['"])([^,}\n]+)/g;

// Audit script's own filename — exclude from self-scan so doc-comment examples
// don't get parsed as real emit sites.
const SELF_FILENAME = 'audit-decision-actions.js';

function* walkJsFiles(rootDir) {
  const stack = [rootDir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const ent of entries) {
      const abs = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
        stack.push(abs);
      } else if (
        ent.isFile()
        && ent.name.endsWith('.js')
        && !ent.name.endsWith('.test.js')
        && ent.name !== SELF_FILENAME
      ) {
        yield abs;
      }
    }
  }
}

function fileLineFromIndex(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

function discoverEmitSites(rootDir, sourceGlobs = SOURCE_GLOBS) {
  const literal_emissions = new Map();
  const dynamic_action_sites = [];

  const resolvedRoots = sourceGlobs
    .map((g) => path.join(rootDir, g))
    .filter((p) => fs.existsSync(p));
  const rootsToWalk = resolvedRoots.length > 0 ? resolvedRoots : [rootDir];

  for (const root of rootsToWalk) {
    for (const file of walkJsFiles(root)) {
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch (e) {
        continue;
      }

      EMIT_LITERAL_RE.lastIndex = 0;
      let m;
      while ((m = EMIT_LITERAL_RE.exec(text)) !== null) {
        const action = m[1];
        const line = fileLineFromIndex(text, m.index);
        const arr = literal_emissions.get(action) || [];
        arr.push({ file: path.relative(rootDir, file), line });
        literal_emissions.set(action, arr);
      }

      EMIT_DYNAMIC_RE.lastIndex = 0;
      while ((m = EMIT_DYNAMIC_RE.exec(text)) !== null) {
        const slice = text.slice(m.index, m.index + 200);
        if (/action\s*:\s*['"]/.test(slice)) continue;

        const line = fileLineFromIndex(text, m.index);
        const snippet = m[1].trim().slice(0, 80);
        dynamic_action_sites.push({ file: path.relative(rootDir, file), line, snippet });
      }
    }
  }

  return { literal_emissions, dynamic_action_sites };
}

module.exports = {
  discoverEmitSites,
  __internals: { walkJsFiles, fileLineFromIndex },
};
