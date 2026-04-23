'use strict';

const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');

const { validateCoverage } = require('../tool-annotations');
const { CORE_TOOL_NAMES, EXTENDED_TOOL_NAMES } = require('../core-tools');
const { TOOLS, routeMap, schemaMap } = require('../tools');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SERVER_ROOT = path.join(REPO_ROOT, 'server');
const TOOL_DEFS_DIR = path.join(SERVER_ROOT, 'tool-defs');
const HANDLERS_DIR = path.join(SERVER_ROOT, 'handlers');
const TOOLS_AGGREGATOR_TEST_FILE = path.join(__dirname, 'tools-aggregator.test.js');
const TOOL_SCHEMA_VALIDATION_TEST_FILE = path.join(__dirname, 'tool-schema-validation.test.js');
const TOOL_ANNOTATIONS_TEST_FILE = path.join(__dirname, 'tool-annotations.test.js');
const P3_ASYNC_TRYCATCH_TEST_FILE = path.join(__dirname, 'p3-async-trycatch.test.js');
const P3_RAW_THROWS_TEST_FILE = path.join(__dirname, 'p3-raw-throws.test.js');
const CORE_TOOLS_TEST_FILE = path.join(__dirname, 'core-tools.test.js');

// Recursive alignment uses the existing p3 exemptions plus a few legacy nested modules
// whose handlers intentionally delegate error handling today.
const ASYNC_HANDLER_FILE_EXEMPTIONS = new Set([
  'comparison-handler.js',
  'competitive-feature-handlers.js',
  'discovery-handlers.js',
  'codebase-study-handlers.js',
  'review-handler.js',
  'automation-handlers.js',
  'governance-handlers.js',
  'concurrency-handlers.js',
  'model-registry-handlers.js',
  'factory-handlers.js',
  'integration/infra.js',
  'validation/file.js',
  'validation/index.js',
]);

const ASYNC_HANDLER_EXEMPTIONS = new Set([
  'workflow/await.js:handleRestartRecovery',
]);

const RAW_THROW_FILE_EXEMPTIONS = new Set([
  'task-utils.js',
  'shared.js',
  'error-codes.js',
  'snapscope-handlers.js',
  'comparison-handler.js',
  'review-handler.js',
  'factory-handlers.js',
  'task/core.js',
]);

function walkJsFiles(dirPath) {
  const files = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkJsFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

function toPosix(value) {
  return String(value).replace(/\\/g, '/');
}

function relativeToRepo(filePath) {
  return toPosix(path.relative(REPO_ROOT, filePath));
}

function lineReference(filePath, line) {
  return `${relativeToRepo(filePath)}:${line}`;
}

function lineNumberForIndex(source, index) {
  return source.slice(0, index).split(/\r?\n/).length;
}

function buildToolNameOccurrenceQueues(source) {
  const queues = new Map();
  const nameRegex = /\bname\s*:\s*['"]([^'"]+)['"]/g;

  for (const match of source.matchAll(nameRegex)) {
    const name = match[1];
    if (!queues.has(name)) {
      queues.set(name, []);
    }
    queues.get(name).push(lineNumberForIndex(source, match.index));
  }

  return queues;
}

function collectToolEntries(drifts) {
  const entries = [];

  for (const filePath of walkJsFiles(TOOL_DEFS_DIR)) {
    const defs = require(filePath);
    if (!Array.isArray(defs)) {
      drifts.push(
        `${lineReference(filePath, 1)} exports ${typeof defs}, but tool-def files must export arrays. Canonical owner: ${lineReference(TOOL_SCHEMA_VALIDATION_TEST_FILE, 1)}.`
      );
      continue;
    }

    const source = fs.readFileSync(filePath, 'utf8');
    const lineQueues = buildToolNameOccurrenceQueues(source);

    defs.forEach((def, index) => {
      if (!def || typeof def.name !== 'string' || def.name.trim().length === 0) {
        drifts.push(
          `${lineReference(filePath, 1)} tool-def entry ${index + 1} is missing a non-empty string name. Canonical owner: ${lineReference(TOOL_SCHEMA_VALIDATION_TEST_FILE, 1)}.`
        );
        return;
      }

      const queue = lineQueues.get(def.name);
      const line = queue && queue.length > 0 ? queue.shift() : 1;
      entries.push({ name: def.name, filePath, line });
    });
  }

  return entries;
}

function extractInlineToolNamesFromTools(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  const switchBlockMatch = source.match(
    /switch\s*\(name\)\s*\{(?<body>[\s\S]*?)\n\s*}\n\n\s*\/\/ Centralized JSON Schema validation/
  );
  if (!switchBlockMatch) {
    throw new Error(`Could not find handleToolCall inline switch in ${relativeToRepo(filePath)}`);
  }

  return [...new Set(
    [...switchBlockMatch.groups.body.matchAll(/case\s+'([^']+)'/g)].map((match) => match[1])
  )].sort();
}

function collectRouteRegistryDiff() {
  const toolNames = TOOLS.map((tool) => tool.name);
  const toolNameSet = new Set(toolNames);
  const inlineToolNames = extractInlineToolNamesFromTools(path.join(SERVER_ROOT, 'tools.js'))
    .filter((name) => toolNameSet.has(name) && !routeMap.has(name))
    .sort();
  const inlineToolNameSet = new Set(inlineToolNames);

  return {
    inlineToolNames,
    unmappedToolNames: toolNames
      .filter((name) => !routeMap.has(name) && !inlineToolNameSet.has(name))
      .sort(),
    aliasedRouteNames: [...routeMap.keys()]
      .filter((name) => !toolNameSet.has(name))
      .sort(),
  };
}

describe('MCP tool alignment', () => {
  it('keeps tool defs, route exposure, REST domains, and handler guardrails aligned', () => {
    const drifts = [];
    const toolEntries = collectToolEntries(drifts);
    const toolsByName = new Map();

    for (const entry of toolEntries) {
      if (!toolsByName.has(entry.name)) {
        toolsByName.set(entry.name, []);
      }
      toolsByName.get(entry.name).push(entry);
    }

    for (const [name, entries] of toolsByName.entries()) {
      if (entries.length < 2) {
        continue;
      }
      drifts.push(
        `Duplicate MCP tool name "${name}" in ${entries.map((entry) => lineReference(entry.filePath, entry.line)).join(', ')}. Canonical owner: ${lineReference(CORE_TOOLS_TEST_FILE, 1)}.`
      );
    }

    const toolNames = [...toolsByName.keys()].sort();
    const toolNameSet = new Set(toolNames);
    const toolsCatalogNames = new Set(TOOLS.map((tool) => tool.name));
    const uncoveredAnnotations = new Set(validateCoverage(toolNames).uncovered);

    for (const name of toolNames) {
      const firstEntry = toolsByName.get(name)[0];

      if (!toolsCatalogNames.has(name)) {
        drifts.push(
          `${lineReference(firstEntry.filePath, firstEntry.line)} defines "${name}", but server/tools.js does not import it into TOOLS for full unlock exposure. Canonical owners: ${lineReference(CORE_TOOLS_TEST_FILE, 1)}, ${lineReference(TOOLS_AGGREGATOR_TEST_FILE, 1)}.`
        );
      }

      if (!schemaMap.has(name)) {
        drifts.push(
          `${lineReference(firstEntry.filePath, firstEntry.line)} defines "${name}", but server/tools.js schemaMap has no entry for it. Canonical owner: ${lineReference(TOOL_SCHEMA_VALIDATION_TEST_FILE, 1)}.`
        );
      }

      if (uncoveredAnnotations.has(name)) {
        drifts.push(
          `${lineReference(firstEntry.filePath, firstEntry.line)} defines "${name}", but server/tool-annotations.js falls back instead of covering it explicitly or by convention. Canonical owner: ${lineReference(TOOL_ANNOTATIONS_TEST_FILE, 1)}.`
        );
      }
    }

    for (const [tierLabel, names] of [
      ['CORE_TOOL_NAMES', CORE_TOOL_NAMES],
      ['EXTENDED_TOOL_NAMES', EXTENDED_TOOL_NAMES],
    ]) {
      for (const name of names) {
        if (toolNameSet.has(name)) {
          continue;
        }
        drifts.push(
          `${lineReference(path.join(SERVER_ROOT, 'core-tools.js'), 1)} lists "${name}" in ${tierLabel}, but no tool-def exports that name. Canonical owner: ${lineReference(CORE_TOOLS_TEST_FILE, 1)}.`
        );
      }
    }

    const {
      inlineToolNames,
      unmappedToolNames,
      aliasedRouteNames,
    } = collectRouteRegistryDiff();
    const excludedToolNames = new Set([...inlineToolNames, ...unmappedToolNames]);
    const expectedRouteMapSize = TOOLS.length - excludedToolNames.size + aliasedRouteNames.length;

    if (routeMap.size !== expectedRouteMapSize) {
      drifts.push(
        `server/tools.js routeMap.size is ${routeMap.size}, expected ${expectedRouteMapSize} from the live registry diff: TOOLS.length (${TOOLS.length}) - inline-only tool defs (${inlineToolNames.length}) - handlerless tool defs (${unmappedToolNames.length}) + aliased handler routes (${aliasedRouteNames.length}). Canonical owner: ${lineReference(TOOLS_AGGREGATOR_TEST_FILE, 1)}.`
      );
    }

    for (const filePath of walkJsFiles(HANDLERS_DIR)) {
      const relativeHandlerPath = toPosix(path.relative(HANDLERS_DIR, filePath));
      if (ASYNC_HANDLER_FILE_EXEMPTIONS.has(relativeHandlerPath)) {
        continue;
      }

      const source = fs.readFileSync(filePath, 'utf8');
      const ast = acorn.parse(source, {
        ecmaVersion: 2023,
        sourceType: 'script',
        locations: true,
      });

      for (const statement of ast.body) {
        if (
          statement.type !== 'FunctionDeclaration'
          || !statement.async
          || !statement.id
          || !/^handle/.test(statement.id.name)
        ) {
          continue;
        }

        if (ASYNC_HANDLER_EXEMPTIONS.has(`${relativeHandlerPath}:${statement.id.name}`)) {
          continue;
        }

        const bodyStatements = statement.body.body || [];
        const firstStatement = bodyStatements[0];
        const hasTopLevelTryCatch = bodyStatements.length === 1
          && firstStatement
          && firstStatement.type === 'TryStatement'
          && !!firstStatement.handler;

        if (hasTopLevelTryCatch) {
          continue;
        }

        drifts.push(
          `${lineReference(filePath, statement.loc.start.line)} async handler ${statement.id.name} is missing a single top-level try/catch wrapper. Canonical owner: ${lineReference(P3_ASYNC_TRYCATCH_TEST_FILE, 1)}.`
        );
      }
    }

    const rawThrowRegex = /\bthrow\s+new\s+Error\(/g;
    for (const filePath of walkJsFiles(HANDLERS_DIR)) {
      const relativeHandlerPath = toPosix(path.relative(HANDLERS_DIR, filePath));
      if (RAW_THROW_FILE_EXEMPTIONS.has(relativeHandlerPath)) {
        continue;
      }

      const source = fs.readFileSync(filePath, 'utf8');
      for (const match of source.matchAll(rawThrowRegex)) {
        drifts.push(
          `${lineReference(filePath, lineNumberForIndex(source, match.index))} contains raw throw new Error(...). Canonical owner: ${lineReference(P3_RAW_THROWS_TEST_FILE, 1)}.`
        );
      }
    }

    if (drifts.length > 0) {
      throw new Error(`Alignment drift detected:\n${drifts.map((drift, index) => `${index + 1}. ${drift}`).join('\n')}`);
    }
  });
});
