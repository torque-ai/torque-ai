'use strict';

const fs = require('fs');
const path = require('path');

const RISKY_REPO_WORKSPACE_CALLS = [
  /(safeTool|handleToolCall)\(\s*['"`](submit_task|smart_submit_task)['"`][\s\S]{0,800}?working_directory\s*:\s*(process\.cwd\(\)|cwd\b)/m,
  /\b[\w.]+\.handleSmartSubmitTask\(\s*\{[\s\S]{0,1200}?working_directory\s*:\s*(process\.cwd\(\)|cwd\b)/m,
  /\b(taskCore|db)\.createTask\(\s*\{[\s\S]{0,1200}?working_directory\s*:\s*(process\.cwd\(\)|cwd\b)/m,
];
const CWD_ALIAS_RE = /\bconst\s+cwd\s*=\s*process\.cwd\(\)\s*;/;

function walkTestFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTestFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('task workspace containment', () => {
  it('does not submit runnable tasks against the repo checkout', () => {
    const offenders = walkTestFiles(__dirname)
      .filter(file => file !== __filename)
      .filter(file => {
        const source = fs.readFileSync(file, 'utf8');
        return (source.includes('process.cwd()') || CWD_ALIAS_RE.test(source))
          && RISKY_REPO_WORKSPACE_CALLS.some(pattern => pattern.test(source));
      })
      .map(file => path.relative(__dirname, file).replace(/\\/g, '/'))
      .sort();

    expect(offenders).toEqual([]);
  });
});
