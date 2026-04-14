'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REST_PASSTHROUGH_COVERAGE_TEST_FILE = path.join(
  __dirname,
  '..',
  'tests',
  'rest-passthrough-coverage.test.js',
);

function readFileIfPresent(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.length > 0))];
}

function extractStringLiterals(source) {
  return [...source.matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]);
}

function loadExpectedDomains() {
  const source = readFileIfPresent(REST_PASSTHROUGH_COVERAGE_TEST_FILE);
  const match = source.match(/const EXPECTED_DOMAINS = \[([\s\S]*?)\];/);
  if (!match) {
    return new Set();
  }

  return new Set(extractStringLiterals(match[1]));
}

function extractFencedCodeBlocks(markdown) {
  return [...String(markdown || '').matchAll(/```(?:[a-z0-9_-]+)?\r?\n([\s\S]*?)\r?\n```/gi)]
    .map((match) => match[1]);
}

function extractIndentedCodeBlocks(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const blocks = [];
  let current = [];

  function flushCurrent() {
    if (current.length > 0) {
      blocks.push(current.join('\n'));
      current = [];
    }
  }

  for (const line of lines) {
    if (/^(?: {4}|\t)/.test(line)) {
      current.push(line.replace(/^(?: {4}|\t)/, ''));
      continue;
    }

    if (current.length > 0 && line.trim() === '') {
      current.push('');
      continue;
    }

    flushCurrent();
  }

  flushCurrent();
  return blocks;
}

function extractCodeBlocks(markdown) {
  return uniqueStrings([
    ...extractFencedCodeBlocks(markdown),
    ...extractIndentedCodeBlocks(markdown),
  ]);
}

function extractFunctionBlock(source, startIndex) {
  const braceStart = source.indexOf('{', startIndex);
  if (braceStart < 0) {
    return source.slice(startIndex);
  }

  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(startIndex, index + 1);
      }
    }
  }

  return source.slice(startIndex);
}

function planMentionsNewTool(planMarkdown, codeBlocks) {
  if (/(?:^|[^a-z0-9_])(?:server\/)?tool-defs\/[^\s`'")]+-defs\.js\b/i.test(planMarkdown)) {
    return true;
  }

  return codeBlocks.some((block) => /name\s*:\s*['"][a-z0-9_:-]+['"]/i.test(block));
}

function planMentionsToolCompanions(planMarkdown) {
  if (/(?:tool-annotations|tool-output-schemas|core-tools)\.js\b/i.test(planMarkdown)) {
    return true;
  }

  return /(?:^|[^a-z0-9_])(?:server\/)?tests\/[^\s`'")]+\.test\.[cm]?js\b/i.test(planMarkdown);
}

function planMentionsAsyncGuardTests(planMarkdown) {
  return /(?:^|[^a-z0-9_])(?:server\/)?tests\/p3-(?:async-trycatch|raw-throws)\.test\.js\b/i.test(planMarkdown);
}

function hasAsyncHandlerWithoutMakeError(codeBlocks) {
  const handlerRegex = /async function (handle[A-Z0-9_]\w*)\s*\([^)]*\)\s*\{/g;

  for (const block of codeBlocks) {
    for (const match of block.matchAll(handlerRegex)) {
      const snippet = extractFunctionBlock(block, match.index);
      if (!/makeError\s*\(/.test(snippet)) {
        return true;
      }
    }
  }

  return false;
}

function findRouteDomains(planMarkdown) {
  return uniqueStrings(
    [...String(planMarkdown || '').matchAll(/\/api\/v2\/([A-Za-z0-9_-]+)\/[^\s`'")]+/g)]
      .map((match) => match[1]),
  );
}

function lintPlanContent(planMarkdown) {
  const content = typeof planMarkdown === 'string' ? planMarkdown : String(planMarkdown || '');
  const codeBlocks = extractCodeBlocks(content);
  const errors = [];
  const warnings = [];

  if (planMentionsNewTool(content, codeBlocks) && !planMentionsToolCompanions(content)) {
    warnings.push(
      "Plan adds MCP tool(s) but doesn't mention updating tool-annotations/core-tools/tests — likely to fail alignment gate. Expand the plan to include these updates.",
    );
  }

  if (!planMentionsAsyncGuardTests(content) && hasAsyncHandlerWithoutMakeError(codeBlocks)) {
    warnings.push(
      'Plan adds async handler(s) without showing makeError(...) or referencing the p3 async-handler guard tests. Expand the plan before EXECUTE.',
    );
  }

  if (codeBlocks.some((block) => /require\(\s*['"]vitest['"]\s*\)/.test(block))) {
    errors.push("Plan authors a test that calls require('vitest') — banned pattern; rely on vitest globals.");
  }

  const expectedDomains = loadExpectedDomains();
  for (const domain of findRouteDomains(content)) {
    if (!expectedDomains.has(domain)) {
      warnings.push(
        `Plan adds REST routes in domain '${domain}' not listed in EXPECTED_DOMAINS — update the test file or we'll regress coverage.`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors: uniqueStrings(errors),
    warnings: uniqueStrings(warnings),
  };
}

module.exports = {
  lintPlanContent,
};
