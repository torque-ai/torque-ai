'use strict';

const path = require('path');

const javascript = require('./javascript');
const typescript = require('./typescript');
const go = require('./go');
const python = require('./python');
const rust = require('./rust');
const csharp = require('./csharp');

const C_SHARP_BUILTIN_TYPE_NAMES = new Set([
  'action',
  'array',
  'bool',
  'boolean',
  'byte',
  'cancellationtoken',
  'char',
  'collection',
  'datetime',
  'datetimeoffset',
  'decimal',
  'dictionary',
  'double',
  'dynamic',
  'eventargs',
  'exception',
  'float',
  'func',
  'guid',
  'ienumerable',
  'ienumerator',
  'iequalitycomparer',
  'iformattable',
  'ilist',
  'iqueryable',
  'list',
  'long',
  'memory',
  'object',
  'readonlymemory',
  'readonlyspan',
  'result',
  'serviceprovider',
  'short',
  'span',
  'stream',
  'string',
  'task',
  'timespan',
  'token',
  'uri',
  'value',
  'void',
]);

const C_SHARP_PARAMETER_MODIFIERS = new Set(['ref', 'out', 'in', 'params', 'this', 'scoped']);
const TEST_FILE_PATTERN = /(?:^|\/)(?:tests?|__tests__)\/|(?:\.test|\.spec|\.e2e|\.integration)\.[^.]+$/i;

module.exports = { createParsers };

function createParsers(deps = {}) {
  const parsers = deps.parsers || {
    javascript,
    typescript,
    go,
    python,
    rust,
    csharp,
  };

  function extractSymbols(file, lang) {
    const source = getSource(file);
    const filePath = getFilePath(file);
    const resolvedLanguage = normalizeLanguage(lang) || inferLanguage(filePath);
    const parser = resolvedLanguage ? parsers[resolvedLanguage] : null;
    if (!parser || typeof parser.extractSymbols !== 'function') {
      return { symbols: [], imports: [], exports: [] };
    }
    return parser.extractSymbols(source, filePath);
  }

  function getSupportedLanguages() {
    return ['javascript', 'typescript', 'go', 'python', 'rust', 'csharp'];
  }

  return {
    extractSymbols,
    getSupportedLanguages,
    buildInterfaceImplementationMap,
    buildModuleEntryMap,
    buildModuleExportLookup,
    buildServiceRegistrationLookup,
    extractCSharpExplicitExports,
    extractCSharpImplementedInterfaces,
    extractCSharpReferenceHints,
    extractServiceRegistrations,
    resolveCSharpDependencyCandidates,
  };
}

function getSource(file) {
  if (typeof file === 'string') {
    return '';
  }
  return String(
    file?.source
    ?? file?.content
    ?? file?._content
    ?? ''
  );
}

function getFilePath(file) {
  if (typeof file === 'string') {
    return file;
  }
  return String(
    file?.path
    ?? file?.file
    ?? file?.fullPath
    ?? ''
  );
}

function normalizeLanguage(lang) {
  const normalized = String(lang || '').trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === 'c#' || normalized === 'c_sharp' || normalized === 'c-sharp') {
    return 'csharp';
  }
  if (normalized === 'js') {
    return 'javascript';
  }
  if (normalized === 'ts') {
    return 'typescript';
  }
  return normalized;
}

function inferLanguage(filePath) {
  const extension = path.extname(String(filePath || '')).toLowerCase();
  switch (extension) {
    case '.js':
    case '.mjs':
    case '.cjs':
    case '.jsx':
      return 'javascript';
    case '.ts':
    case '.tsx':
      return 'typescript';
    case '.go':
      return 'go';
    case '.py':
      return 'python';
    case '.rs':
      return 'rust';
    case '.cs':
      return 'csharp';
    default:
      return null;
  }
}

function toRepoPath(filePath) {
  return String(filePath || '').trim().replace(/\\/g, '/');
}

function uniqueStrings(values) {
  const seen = new Set();
  const output = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function uniquePaths(values) {
  const seen = new Set();
  const output = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = toRepoPath(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function extractCSharpNamespaceName(content) {
  const blockMatch = String(content || '').match(/^\s*namespace\s+([A-Za-z_][\w.]*)\s*\{/m);
  if (blockMatch) {
    return blockMatch[1];
  }
  const fileScopedMatch = String(content || '').match(/^\s*namespace\s+([A-Za-z_][\w.]*)\s*;/m);
  return fileScopedMatch ? fileScopedMatch[1] : null;
}

function extractCSharpUsingNamespaces(content) {
  const namespaces = [];
  const pattern = /^\s*using\s+([A-Za-z_][\w.]*)\s*;/gm;
  let match;
  while ((match = pattern.exec(String(content || ''))) !== null) {
    namespaces.push(match[1]);
  }
  return uniqueStrings(namespaces);
}

function extractNamedTypeIdentifiers(fragment) {
  const values = [];
  const matches = String(fragment || '').match(/[A-Z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*/g) || [];
  for (const match of matches) {
    const normalized = String(match || '').trim();
    if (!normalized) {
      continue;
    }
    const segments = normalized.split('.');
    const symbolName = segments[segments.length - 1];
    if (symbolName) {
      values.push(symbolName);
    }
    if (segments.length > 1) {
      values.push(normalized);
    }
  }
  return uniqueStrings(values).filter((token) => !C_SHARP_BUILTIN_TYPE_NAMES.has(String(token || '').toLowerCase()));
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findMatchingDelimiter(source, startIndex, openChar, closeChar) {
  const normalized = String(source || '');
  let depth = 0;
  for (let index = startIndex; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === openChar) {
      depth += 1;
    } else if (char === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function splitTopLevelList(value, separator = ',') {
  const normalized = String(value || '');
  if (!normalized.trim()) {
    return [];
  }
  const parts = [];
  let current = '';
  let angleDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;

  for (const char of normalized) {
    if (char === '<') {
      angleDepth += 1;
    } else if (char === '>') {
      angleDepth = Math.max(0, angleDepth - 1);
    } else if (char === '(') {
      parenDepth += 1;
    } else if (char === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
    } else if (char === '[') {
      bracketDepth += 1;
    } else if (char === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
    } else if (char === '{') {
      braceDepth += 1;
    } else if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
    }

    if (
      char === separator
      && angleDepth === 0
      && parenDepth === 0
      && bracketDepth === 0
      && braceDepth === 0
    ) {
      if (current.trim()) {
        parts.push(current.trim());
      }
      current = '';
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    parts.push(current.trim());
  }
  return parts;
}

function collectCSharpSignatureBlock(lines, startIndex, maxLines = 6) {
  const fragments = [];
  let parenDepth = 0;
  for (let index = startIndex; index < lines.length && fragments.length < maxLines; index += 1) {
    const trimmed = String(lines[index] || '').trim();
    if (!trimmed || trimmed.startsWith('//')) {
      if (fragments.length > 0 && parenDepth === 0) {
        break;
      }
      continue;
    }
    fragments.push(trimmed);
    for (const char of trimmed) {
      if (char === '(') {
        parenDepth += 1;
      } else if (char === ')') {
        parenDepth = Math.max(0, parenDepth - 1);
      }
    }
    if ((trimmed.includes('{') || trimmed.endsWith(';')) && parenDepth === 0) {
      break;
    }
    if (parenDepth === 0 && trimmed.includes(')')) {
      break;
    }
  }
  return fragments.join(' ');
}

function extractCSharpExplicitExports(content) {
  const exports = [];
  const patterns = [
    /\b(?:public|internal)\s+(?:partial\s+|sealed\s+|abstract\s+|static\s+)*(?:class|struct|record)\s+([A-Za-z_][\w]*)/g,
    /\b(?:public|internal)\s+interface\s+([A-Za-z_][\w]*)/g,
    /\b(?:public|internal)\s+enum\s+([A-Za-z_][\w]*)/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(String(content || ''))) !== null) {
      exports.push(match[1]);
    }
  }

  return uniqueStrings(exports);
}

function extractCSharpPrimaryTypeName(repoPath, content) {
  const normalizedRepoPath = String(repoPath || '').trim();
  const fileStem = normalizedRepoPath
    ? path.basename(normalizedRepoPath, path.extname(normalizedRepoPath)).trim()
    : '';
  if (fileStem) {
    return fileStem;
  }
  return extractCSharpExplicitExports(content)[0] || null;
}

function extractCSharpPrimaryTypeToken(fragment) {
  const normalized = String(fragment || '').trim();
  if (!normalized) {
    return null;
  }
  const match = normalized.match(/[A-Z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*/);
  if (!match) {
    return null;
  }
  const qualifiedName = String(match[0] || '').trim().replace(/\?+$/, '');
  if (!qualifiedName) {
    return null;
  }
  const symbolName = qualifiedName.split('.').pop();
  if (!symbolName || C_SHARP_BUILTIN_TYPE_NAMES.has(symbolName.toLowerCase())) {
    return null;
  }
  return { symbolName, qualifiedName };
}

function extractCSharpConstructorDependencyTokens(parameterList) {
  const tokens = [];
  for (const parameter of splitTopLevelList(parameterList)) {
    let normalized = String(parameter || '').trim();
    if (!normalized) {
      continue;
    }
    const assignmentIndex = normalized.indexOf('=');
    if (assignmentIndex >= 0) {
      normalized = normalized.slice(0, assignmentIndex).trim();
    }
    while (normalized.startsWith('[')) {
      const attributeEnd = normalized.indexOf(']');
      if (attributeEnd < 0) {
        break;
      }
      normalized = normalized.slice(attributeEnd + 1).trim();
    }
    const parts = normalized.split(/\s+/).filter(Boolean);
    while (parts.length > 1 && C_SHARP_PARAMETER_MODIFIERS.has(parts[0].toLowerCase())) {
      parts.shift();
    }
    if (parts.length < 2) {
      continue;
    }
    const typeInfo = extractCSharpPrimaryTypeToken(parts.slice(0, -1).join(' '));
    if (typeInfo) {
      tokens.push(typeInfo.symbolName);
    }
  }
  return uniqueStrings(tokens);
}

function extractCSharpImplementedInterfaces(content) {
  const interfaces = [];
  const lines = String(content || '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = String(lines[index] || '').trim();
    if (!line || line.startsWith('//') || !/\b(?:class|record|struct)\b/.test(line)) {
      continue;
    }
    const declaration = collectCSharpSignatureBlock(lines, index);
    const match = declaration.match(/\b(?:class|record|struct)\s+[A-Za-z_][\w]*(?:\s*<[^>{]+>)?\s*:\s*([^{}]+)/);
    if (!match) {
      continue;
    }
    for (const baseType of splitTopLevelList(match[1])) {
      const typeInfo = extractCSharpPrimaryTypeToken(baseType);
      if (typeInfo && /^I[A-Z]/.test(typeInfo.symbolName)) {
        interfaces.push(typeInfo.symbolName);
      }
    }
  }
  return uniqueStrings(interfaces);
}

function extractServiceRegistrations(content) {
  const source = String(content || '');
  const registrations = [];
  const methods = ['AddScoped', 'AddTransient', 'AddSingleton'];
  let searchIndex = 0;

  while (searchIndex < source.length) {
    let nextMethod = null;
    let nextIndex = -1;
    for (const method of methods) {
      const methodIndex = source.indexOf(method, searchIndex);
      if (methodIndex >= 0 && (nextIndex < 0 || methodIndex < nextIndex)) {
        nextMethod = method;
        nextIndex = methodIndex;
      }
    }
    if (!nextMethod || nextIndex < 0) {
      break;
    }

    const beforeChar = nextIndex > 0 ? source[nextIndex - 1] : '';
    if (/[A-Za-z0-9_]/.test(beforeChar)) {
      searchIndex = nextIndex + 1;
      continue;
    }

    let cursor = nextIndex + nextMethod.length;
    while (cursor < source.length && /\s/.test(source[cursor])) {
      cursor += 1;
    }
    if (source[cursor] !== '<') {
      searchIndex = nextIndex + nextMethod.length;
      continue;
    }

    const genericEnd = findMatchingDelimiter(source, cursor, '<', '>');
    if (genericEnd < 0) {
      searchIndex = cursor + 1;
      continue;
    }

    let invocationCursor = genericEnd + 1;
    while (invocationCursor < source.length && /\s/.test(source[invocationCursor])) {
      invocationCursor += 1;
    }
    if (source[invocationCursor] !== '(') {
      searchIndex = genericEnd + 1;
      continue;
    }

    const genericArgs = source.slice(cursor + 1, genericEnd);
    const parts = splitTopLevelList(genericArgs);
    if (parts.length >= 2) {
      const interfaceType = extractCSharpPrimaryTypeToken(parts[0]);
      const implementationType = extractCSharpPrimaryTypeToken(parts[1]);
      if (interfaceType && implementationType) {
        registrations.push({
          interface: interfaceType.symbolName,
          implementation: implementationType.symbolName,
        });
      }
    }
    searchIndex = genericEnd + 1;
  }

  const deduped = [];
  const seen = new Set();
  for (const registration of registrations) {
    const key = `${registration.interface}:${registration.implementation}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(registration);
  }
  return deduped;
}

function extractCSharpReferenceHints(content, repoPath = '') {
  const normalizedContent = String(content || '');
  const usingNamespaces = extractCSharpUsingNamespaces(normalizedContent);
  const namespaceName = extractCSharpNamespaceName(normalizedContent);
  const fragments = [];
  const constructorInjectedTokens = [];
  const primaryTypeName = extractCSharpPrimaryTypeName(repoPath, normalizedContent);
  const lines = normalizedContent.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = String(rawLine || '').trim();
    if (!line || line.startsWith('//')) {
      continue;
    }
    if (
      /\b(?:public|private|protected|internal)\b/.test(line)
      || /\bnew\s+[A-Z]/.test(line)
      || /\bclass\s+[A-Z]/.test(line)
      || /\brecord\s+[A-Z]/.test(line)
      || /\binterface\s+[A-Z]/.test(line)
    ) {
      fragments.push(line);
    }
  }

  if (primaryTypeName) {
    const constructorPattern = new RegExp(`^(?:public|internal)\\s+${escapeRegExp(primaryTypeName)}\\s*\\(`);
    for (let index = 0; index < lines.length; index += 1) {
      const line = String(lines[index] || '').trim();
      if (!line || line.startsWith('//') || !constructorPattern.test(line)) {
        continue;
      }
      const declaration = collectCSharpSignatureBlock(lines, index);
      const openIndex = declaration.indexOf('(');
      const closeIndex = openIndex >= 0 ? findMatchingDelimiter(declaration, openIndex, '(', ')') : -1;
      if (openIndex < 0 || closeIndex <= openIndex) {
        continue;
      }
      const parameterList = declaration.slice(openIndex + 1, closeIndex);
      constructorInjectedTokens.push(...extractCSharpConstructorDependencyTokens(parameterList));
    }
  }

  const baseListPattern = /\b(?:class|record|struct|interface)\s+[A-Za-z_][\w]*\s*:\s*([^{\n]+)/g;
  let baseListMatch;
  while ((baseListMatch = baseListPattern.exec(normalizedContent)) !== null) {
    fragments.push(baseListMatch[1]);
  }

  const parameterPattern = /\(([^()]{1,300})\)/g;
  let parameterMatch;
  while ((parameterMatch = parameterPattern.exec(normalizedContent)) !== null) {
    fragments.push(parameterMatch[1]);
  }

  const rawTokens = uniqueStrings([
    ...fragments.flatMap((fragment) => extractNamedTypeIdentifiers(fragment)),
    ...constructorInjectedTokens,
  ]);
  return {
    namespaceName,
    usingNamespaces,
    dependencyTokens: rawTokens,
    constructorInjectedTokens: uniqueStrings(constructorInjectedTokens),
  };
}

function buildModuleEntryMap(entries) {
  return new Map((entries || []).map(entry => [entry.file, entry]));
}

function buildModuleExportLookup(entries) {
  const lookup = new Map();
  const addValue = (key, entry) => {
    const normalized = String(key || '').trim();
    if (!normalized) {
      return;
    }
    if (!lookup.has(normalized)) {
      lookup.set(normalized, []);
    }
    lookup.get(normalized).push(entry);
  };

  for (const entry of Array.isArray(entries) ? entries : []) {
    addValue(path.basename(entry.file, path.extname(entry.file)), entry);
    for (const exportName of uniqueStrings(entry.exports || [])) {
      addValue(exportName, entry);
    }
  }

  return lookup;
}

function buildInterfaceImplementationMap(entries) {
  const lookup = new Map();
  const addValue = (interfaceName, filePath) => {
    const normalizedInterface = String(interfaceName || '').trim();
    const normalizedPath = toRepoPath(filePath);
    if (!normalizedInterface || !normalizedPath) {
      return;
    }
    if (!lookup.has(normalizedInterface)) {
      lookup.set(normalizedInterface, []);
    }
    lookup.get(normalizedInterface).push(normalizedPath);
  };

  for (const entry of Array.isArray(entries) ? entries : []) {
    const extension = entry?._extension || path.extname(entry?.file || '').toLowerCase();
    if (extension !== '.cs') {
      continue;
    }
    const implementedInterfaces = uniqueStrings(
      entry?._implemented_interfaces || extractCSharpImplementedInterfaces(entry?._content || '')
    );
    for (const interfaceName of implementedInterfaces) {
      addValue(interfaceName, entry.file);
    }
  }

  for (const [interfaceName, paths] of lookup.entries()) {
    lookup.set(interfaceName, uniquePaths(paths));
  }
  return lookup;
}

function buildServiceRegistrationLookup(entries) {
  const lookup = new Map();
  const addValue = (interfaceName, implementationName) => {
    const normalizedInterface = String(interfaceName || '').trim();
    const normalizedImplementation = String(implementationName || '').trim();
    if (!normalizedInterface || !normalizedImplementation) {
      return;
    }
    if (!lookup.has(normalizedInterface)) {
      lookup.set(normalizedInterface, []);
    }
    lookup.get(normalizedInterface).push(normalizedImplementation);
  };

  for (const entry of Array.isArray(entries) ? entries : []) {
    const extension = entry?._extension || path.extname(entry?.file || '').toLowerCase();
    if (extension !== '.cs') {
      continue;
    }
    const registrations = Array.isArray(entry?._service_registrations)
      ? entry._service_registrations
      : extractServiceRegistrations(entry?._content || '');
    for (const registration of registrations) {
      addValue(registration.interface, registration.implementation);
    }
  }

  for (const [interfaceName, implementationNames] of lookup.entries()) {
    lookup.set(interfaceName, uniqueStrings(implementationNames));
  }
  return lookup;
}

function countSharedPrefixSegments(leftValue, rightValue, separator = '.') {
  const left = String(leftValue || '').split(separator).filter(Boolean);
  const right = String(rightValue || '').split(separator).filter(Boolean);
  let count = 0;
  while (count < left.length && count < right.length && left[count] === right[count]) {
    count += 1;
  }
  return count;
}

function countSharedPathSegments(leftPath, rightPath) {
  const left = toRepoPath(leftPath).split('/').slice(0, -1).filter(Boolean);
  const right = toRepoPath(rightPath).split('/').slice(0, -1).filter(Boolean);
  let count = 0;
  while (count < left.length && count < right.length && left[count] === right[count]) {
    count += 1;
  }
  return count;
}

function candidateMatchesTypeName(candidate, typeName) {
  const normalizedTypeName = String(typeName || '').trim().split('.').pop()?.toLowerCase() || '';
  if (!normalizedTypeName || !candidate?.file) {
    return false;
  }
  if (String(path.basename(candidate.file, path.extname(candidate.file))).toLowerCase() === normalizedTypeName) {
    return true;
  }
  return uniqueStrings(candidate.exports || []).some((value) => String(value).toLowerCase() === normalizedTypeName);
}

function isTestFile(repoPath) {
  return TEST_FILE_PATTERN.test(toRepoPath(repoPath));
}

function resolveCSharpDependencyCandidates(entry, exportLookup, options = {}) {
  const entryLookup = options.entryLookup instanceof Map ? options.entryLookup : new Map();
  const interfaceImplementationMap = options.interfaceImplementationMap instanceof Map
    ? options.interfaceImplementationMap
    : new Map();
  const serviceRegistrationLookup = options.serviceRegistrationLookup instanceof Map
    ? options.serviceRegistrationLookup
    : new Map();
  const exportNames = new Set(uniqueStrings(entry.exports || []).map((value) => String(value).toLowerCase()));
  const constructorInjectedTokens = new Set(
    uniqueStrings(entry._constructor_dependency_tokens || []).map((value) => String(value).trim().toLowerCase())
  );
  const tokens = uniqueStrings(entry._dependency_tokens || [])
    .filter((token) => {
      const normalized = String(token || '').trim().toLowerCase();
      return normalized && !exportNames.has(normalized);
    });
  const resolved = [];

  for (const token of tokens) {
    const normalizedToken = String(token || '').trim();
    if (!normalizedToken) {
      continue;
    }
    const symbolName = normalizedToken.split('.').pop();
    const interfaceImplementationFiles = uniquePaths([
      ...(interfaceImplementationMap.get(normalizedToken) || []),
      ...(interfaceImplementationMap.get(symbolName) || []),
    ]);
    const registeredImplementationNames = uniqueStrings([
      ...(serviceRegistrationLookup.get(normalizedToken) || []),
      ...(serviceRegistrationLookup.get(symbolName) || []),
    ]);
    const rawCandidates = [
      ...(exportLookup.get(normalizedToken) || []),
      ...(exportLookup.get(symbolName) || []),
      ...interfaceImplementationFiles.map((filePath) => entryLookup.get(filePath)).filter(Boolean),
      ...registeredImplementationNames.flatMap((implementationName) => {
        const implementationSymbol = String(implementationName || '').trim().split('.').pop();
        return [
          ...(exportLookup.get(implementationName) || []),
          ...(implementationSymbol ? (exportLookup.get(implementationSymbol) || []) : []),
        ];
      }),
    ];
    const candidates = rawCandidates.filter((candidate, index) => (
      candidate
      && candidate.file !== entry.file
      && rawCandidates.findIndex((item) => item.file === candidate.file) === index
    ));
    if (candidates.length === 0) {
      continue;
    }

    let bestCandidate = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    const isInterfaceToken = /^I[A-Z]/.test(symbolName);
    const interfaceImplementationFileSet = new Set(interfaceImplementationFiles.map(filePath => toRepoPath(filePath)));
    for (const candidate of candidates) {
      let score = 0;
      if (String(path.basename(candidate.file, path.extname(candidate.file))).toLowerCase() === symbolName.toLowerCase()) {
        score += 8;
      }
      if (uniqueStrings(candidate.exports || []).some((value) => String(value).toLowerCase() === symbolName.toLowerCase())) {
        score += 10;
      }
      if (!isTestFile(entry.file) && isTestFile(candidate.file)) {
        score -= 12;
      }
      if (entry.file.startsWith('src/') && candidate.file.startsWith('src/')) {
        score += 4;
      }
      if (entry.file.startsWith('tools/') === candidate.file.startsWith('tools/')) {
        score += 2;
      }
      if ((entry._using_namespaces || []).some((namespaceName) => candidate._namespace === namespaceName || String(candidate._namespace || '').startsWith(`${namespaceName}.`))) {
        score += 10;
      }
      if (entry._namespace && candidate._namespace) {
        score += countSharedPrefixSegments(entry._namespace, candidate._namespace) * 3;
      }
      score += countSharedPathSegments(entry.file, candidate.file) * 2;
      if (isInterfaceToken && interfaceImplementationFileSet.has(toRepoPath(candidate.file))) {
        score += 15;
      }
      if (
        constructorInjectedTokens.has(normalizedToken.toLowerCase())
        || constructorInjectedTokens.has(symbolName.toLowerCase())
      ) {
        score += 8;
      }
      if (registeredImplementationNames.some((implementationName) => candidateMatchesTypeName(candidate, implementationName))) {
        score += 20;
      }

      if (score > bestScore) {
        bestCandidate = candidate;
        bestScore = score;
      }
    }

    if (bestCandidate && bestScore >= 8) {
      resolved.push(bestCandidate.file);
    }
  }

  return uniquePaths(resolved);
}
