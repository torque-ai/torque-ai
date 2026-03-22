import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

test('handlers should not use raw throw Error() usage', () => {
  const handlersDir = path.join(__dirname, '..', 'handlers');
  const throwRegex = /\bthrow\s+new\s+Error\(/g;

  const UTILITY_FILES = new Set(['task-utils.js', 'shared.js', 'error-codes.js', 'snapscope-handlers.js', 'comparison-handler.js']);
  const files = fs
    .readdirSync(handlersDir)
    .filter((name) => name.endsWith('.js') && !UTILITY_FILES.has(name));

  const matches = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(handlersDir, file), 'utf8');
    for (const match of text.matchAll(throwRegex)) {
      const line = text.slice(0, match.index).split(/\r?\n/).length;
      matches.push(`${file}:${line}`);
    }
  }

  expect(matches).toEqual([]);
});
