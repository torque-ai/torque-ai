#!/usr/bin/env node
// PII Guard — Claude Code PreToolUse Hook
// Scans Write/Edit tool content for PII and BLOCKS if found.
// Exit 0 = allow, Exit 2 = block
'use strict';

const path = require('path');
const guardPath = path.join(__dirname, '..', 'server', 'utils', 'pii-guard.js');

let chunks = [];
process.stdin.on('data', d => chunks.push(d));
process.stdin.on('end', () => {
  try {
    const raw = Buffer.concat(chunks).toString('utf8');
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      // Invalid JSON — allow through
      process.exit(0);
    }

    const toolName = input.tool_name || '';
    if (toolName !== 'Write' && toolName !== 'Edit') {
      process.exit(0);
    }

    // Skip ALL test files — they contain mock data and fixtures that look like PII
    const filePath = (input.tool_input && input.tool_input.file_path) || '';
    const normalizedPath = filePath.replace(/\\/g, '/');
    if (normalizedPath.includes('/tests/') || normalizedPath.includes('.test.') || normalizedPath.includes('.spec.')) {
      process.exit(0);
    }

    const content = toolName === 'Write'
      ? (input.tool_input && input.tool_input.content) || ''
      : (input.tool_input && input.tool_input.new_string) || '';

    if (!content) {
      process.exit(0);
    }

    const guard = require(guardPath);
    const result = guard.scanAndReplace(content);

    if (!result.clean) {
      const lines = result.findings.map(f =>
        `  - [${f.category}] "${f.match}" on line ${f.line}`
      ).join('\n');
      process.stderr.write(
        `PII-GUARD: Blocked ${toolName} — found ${result.findings.length} PII item(s):\n${lines}\nReplace the PII with safe placeholders and retry.\n`
      );
      process.exit(2);
    }

    process.exit(0);
  } catch (err) {
    // On any error, allow through (git hook is the backstop)
    process.exit(0);
  }
});
