'use strict';

const fs = require('fs');
const fsPromises = require('node:fs/promises');
const path = require('path');

const defaultSymbolIndexer = require('../../utils/symbol-indexer');
const { createScanner } = require('./scan');
const { createParsers } = require('./parsers');

function createNoopLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function defaultToRepoPath(filePath) {
  return String(filePath || '').trim().replace(/\\/g, '/');
}

function defaultUniqueStrings(values) {
  const seen = new Set();
  const output = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function createDefaultUniquePaths(toRepoPath) {
  return function uniquePaths(values) {
    const seen = new Set();
    const output = [];
    for (const value of Array.isArray(values) ? values : []) {
      const normalized = toRepoPath(value);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      output.push(normalized);
    }
    return output;
  };
}

/**
 * Creates the symbol extraction subsystem — scanner, parsers, and enrichment functions.
 *
 * Encapsulates all language-specific symbol extraction, C# hydration, module entry building,
 * and dependency resolution into a single cohesive module.
 *
 * @param {object} deps
 * @param {object} [deps.symbolIndexer] - The tree-sitter symbol indexer instance (default: require('../../utils/symbol-indexer'))
 * @param {object} [deps.logger] - Logger instance
 * @param {function} [deps.toRepoPath] - Path normalizer
 * @param {function} [deps.uniqueStrings] - String deduplication helper
 * @param {function} [deps.uniquePaths] - Path deduplication helper
 * @param {function} [deps.buildScanLookup] - Builds a scan lookup from scan results
 * @returns {object} Symbol extraction subsystem interface
 */
function createSymbolExtraction(deps = {}) {
  const symbolIndexer = deps.symbolIndexer || defaultSymbolIndexer;
  const logger = deps.logger || createNoopLogger();
  const toRepoPath = typeof deps.toRepoPath === 'function' ? deps.toRepoPath : defaultToRepoPath;
  const uniqueStrings = typeof deps.uniqueStrings === 'function' ? deps.uniqueStrings : defaultUniqueStrings;
  const uniquePaths = typeof deps.uniquePaths === 'function' ? deps.uniquePaths : createDefaultUniquePaths(toRepoPath);
  const buildScanLookup = typeof deps.buildScanLookup === 'function' ? deps.buildScanLookup : null;

  // Create scanner with symbol indexer
  const scanner = createScanner({ symbolIndexer, logger });

  // Create parsers for language-specific extraction
  const parsers = createParsers({ logger });

  // Destructure parser functions for direct access
  const buildModuleEntryMap = parsers.buildModuleEntryMap;
  const buildModuleExportLookup = parsers.buildModuleExportLookup;
  const buildInterfaceImplementationMap = parsers.buildInterfaceImplementationMap;
  const buildServiceRegistrationLookup = parsers.buildServiceRegistrationLookup;
  const extractCSharpExplicitExports = parsers.extractCSharpExplicitExports;
  const extractCSharpImplementedInterfaces = parsers.extractCSharpImplementedInterfaces;
  const extractCSharpReferenceHints = parsers.extractCSharpReferenceHints;
  const extractServiceRegistrations = parsers.extractServiceRegistrations;
  const resolveCSharpDependencyCandidates = parsers.resolveCSharpDependencyCandidates;

  /**
   * Hydrates C# module entries with namespace, dependency tokens, interface implementations,
   * and service registrations by reading file content and running extraction.
   */
  async function hydrateCSharpModuleEntries(entries, workingDirectory) {
    const hydratedEntries = [];

    for (const rawEntry of Array.isArray(entries) ? entries : []) {
      const entry = rawEntry && typeof rawEntry === 'object' ? { ...rawEntry } : rawEntry;
      const extension = entry?._extension || path.extname(entry?.file || '').toLowerCase();
      if (!entry || extension !== '.cs') {
        hydratedEntries.push(entry);
        continue;
      }

      let content = typeof entry._content === 'string' ? entry._content : null;
      if (content === null && workingDirectory && entry.file) {
        const fullPath = path.join(workingDirectory, entry.file);
        if (fs.existsSync(fullPath)) {
          content = await fsPromises.readFile(fullPath, 'utf8');
        }
      }

      if (typeof content !== 'string') {
        hydratedEntries.push({
          ...entry,
          _extension: extension,
        });
        continue;
      }

      const cSharpHints = extractCSharpReferenceHints(content, entry.file);
      hydratedEntries.push({
        ...entry,
        exports: uniqueStrings([...(entry.exports || []), ...extractCSharpExplicitExports(content)]),
        _content: content,
        _extension: extension,
        _namespace: cSharpHints.namespaceName || entry._namespace || null,
        _using_namespaces: uniqueStrings([...(entry._using_namespaces || []), ...(cSharpHints.usingNamespaces || [])]),
        _dependency_tokens: uniqueStrings([...(entry._dependency_tokens || []), ...(cSharpHints.dependencyTokens || [])]),
        _constructor_dependency_tokens: uniqueStrings([
          ...(entry._constructor_dependency_tokens || []),
          ...(cSharpHints.constructorInjectedTokens || []),
        ]),
        _implemented_interfaces: uniqueStrings([
          ...(entry._implemented_interfaces || []),
          ...extractCSharpImplementedInterfaces(content),
        ]),
        _service_registrations: extractServiceRegistrations(content),
      });
    }

    return hydratedEntries;
  }

  /**
   * Enriches module entries with inferred C# dependencies and normalized exports/deps.
   * Hydrates C# entries, builds lookup maps, then resolves dependency candidates.
   */
  async function enrichModuleEntries(entries, workingDirectory) {
    const normalizedEntries = Array.isArray(entries) ? entries.slice() : [];
    const hydratedEntries = await hydrateCSharpModuleEntries(normalizedEntries, workingDirectory);
    const exportLookup = buildModuleExportLookup(hydratedEntries);
    const entryLookup = buildModuleEntryMap(hydratedEntries);
    const interfaceImplementationMap = buildInterfaceImplementationMap(hydratedEntries);
    const serviceRegistrationLookup = buildServiceRegistrationLookup(hydratedEntries);

    return hydratedEntries.map((entry) => {
      const extension = entry._extension || path.extname(entry.file).toLowerCase();
      const inferredDeps = extension === '.cs'
        ? resolveCSharpDependencyCandidates(entry, exportLookup, {
          entryLookup,
          interfaceImplementationMap,
          serviceRegistrationLookup,
        })
        : [];
      const combinedDeps = uniquePaths([...(entry.deps || []), ...inferredDeps]);
      const exports = uniqueStrings(entry.exports || []);
      return {
        ...entry,
        exports,
        deps: combinedDeps,
        purpose: buildPurpose(entry.file, { exports, deps: combinedDeps }),
      };
    });
  }

  function getRoleLabel(repoPath, extension) {
    const normalized = toRepoPath(repoPath);
    if (normalized.startsWith('.claude-plugin/')) return 'Claude plugin module';
    if (normalized.startsWith('agent/tests/') || /\.test\.[^.]+$/.test(path.basename(normalized))) return 'Test module';
    if (normalized.startsWith('agent/')) return 'Agent module';
    if (normalized.startsWith('bin/') || normalized.startsWith('cli/')) return 'CLI module';
    if (normalized.startsWith('dashboard/')) return 'Dashboard module';
    if (normalized.startsWith('server/tests/')) return 'Server test module';
    if (normalized.startsWith('server/')) return 'Server module';
    if (normalized.startsWith('scripts/')) return 'Automation script';
    if (extension === '.cs') {
      if (/program\.cs$/i.test(normalized)) return 'C# startup module';
      if (/app\.xaml\.cs$/i.test(normalized)) return 'Desktop startup module';
      return 'C# module';
    }
    if (extension === '.py') {
      if (/(^|\/)__main__\.py$/i.test(normalized) || /(?:^|\/)(cli|server|main)\.py$/i.test(normalized)) {
        return 'Python entrypoint module';
      }
      return normalized.startsWith('tools/') ? 'Python automation module' : 'Python module';
    }
    if (extension === '.json') return 'JSON data/config file';
    return 'Project module';
  }

  function formatInlineList(values) {
    const items = (values || []).filter(Boolean);
    if (items.length === 0) return '';
    if (items.length === 1) return items[0];
    if (items.length === 2) return `${items[0]} and ${items[1]}`;
    return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
  }

  function summarizePlainList(values, maxItems = 3) {
    const items = uniqueStrings(values).slice(0, maxItems);
    return items.length === 0 ? '' : formatInlineList(items);
  }

  function buildPurpose(repoPath, details) {
    const extension = path.extname(repoPath).toLowerCase();
    const roleLabel = getRoleLabel(repoPath, extension);
    const exportSummary = summarizePlainList(details.exports, 3);
    const dependencySummary = summarizePlainList(details.deps, 3);

    if (extension === '.json') {
      return exportSummary ? `${roleLabel} exposing ${exportSummary}.` : `${roleLabel}.`;
    }
    if (roleLabel === 'Test module' || roleLabel === 'Server test module') {
      if (dependencySummary) return `${roleLabel} covering ${dependencySummary}.`;
      if (exportSummary) return `${roleLabel} exporting ${exportSummary}.`;
      return `${roleLabel}.`;
    }
    if (exportSummary && dependencySummary) return `${roleLabel} exporting ${exportSummary} and depending on ${dependencySummary}.`;
    if (exportSummary) return `${roleLabel} exporting ${exportSummary}.`;
    if (dependencySummary) return `${roleLabel} depending on ${dependencySummary}.`;
    return `${roleLabel}.`;
  }

  /**
   * Builds a single module entry from a file, using scanner results and C# extraction.
   */
  async function buildModuleEntry(workingDirectory, repoPath, scanLookup = null) {
    const fullPath = path.join(workingDirectory, repoPath);
    if (!fs.existsSync(fullPath)) return null;

    const extension = path.extname(repoPath).toLowerCase();
    const scannedFile = scanLookup?.scannedFiles?.has(repoPath) === true;
    const scannedSymbolsEntry = scanLookup?.symbolLookup?.get(repoPath) || null;
    const scannedImportEntry = scanLookup?.importLookup?.get(repoPath) || null;
    const fallbackScanLookup = scannedFile || !scanner
      ? null
      : (buildScanLookup
        ? buildScanLookup(await scanner.scanRepo(workingDirectory, { files: [repoPath] }))
        : null);
    const hasScanData = scannedFile || fallbackScanLookup?.scannedFiles?.has(repoPath) === true;
    const symbolsEntry = scannedSymbolsEntry || fallbackScanLookup?.symbolLookup?.get(repoPath) || null;
    const importEntry = scannedImportEntry || fallbackScanLookup?.importLookup?.get(repoPath) || null;
    const needsContent = extension === '.cs' || !hasScanData;
    const content = needsContent ? await fsPromises.readFile(fullPath, 'utf8') : null;
    const symbols = Array.isArray(symbolsEntry?.symbols) ? symbolsEntry.symbols : [];
    const cSharpHints = extension === '.cs'
      ? extractCSharpReferenceHints(content, repoPath)
      : {
        namespaceName: null,
        usingNamespaces: [],
        dependencyTokens: [],
        constructorInjectedTokens: [],
      };
    const symbolExports = symbols
      .filter(symbol => symbol && symbol.exported && typeof symbol.name === 'string' && !(extension === '.cs' && symbol.kind === 'method'))
      .map(symbol => symbol.name);
    const explicitExports = Array.isArray(symbolsEntry?.exports) ? uniqueStrings(symbolsEntry.exports) : [];
    const dependencies = Array.isArray(importEntry?.imports) ? uniquePaths(importEntry.imports) : [];
    const exportsList = uniqueStrings([...symbolExports, ...explicitExports]);

    return {
      file: repoPath,
      purpose: buildPurpose(repoPath, {
        exports: exportsList,
        deps: dependencies,
      }),
      exports: exportsList,
      deps: dependencies,
      _extension: extension,
      _namespace: cSharpHints.namespaceName,
      _using_namespaces: uniqueStrings(cSharpHints.usingNamespaces || []),
      _dependency_tokens: uniqueStrings(cSharpHints.dependencyTokens || []),
      _constructor_dependency_tokens: uniqueStrings(cSharpHints.constructorInjectedTokens || []),
      _implemented_interfaces: extension === '.cs' ? extractCSharpImplementedInterfaces(content) : [],
      _service_registrations: extension === '.cs' ? extractServiceRegistrations(content) : [],
      _content: extension === '.cs' ? content : null,
    };
  }

  return {
    // Scanner instance
    scanner,

    // Parser functions (language-specific extraction)
    buildModuleEntryMap,
    buildModuleExportLookup,
    buildInterfaceImplementationMap,
    buildServiceRegistrationLookup,
    extractCSharpExplicitExports,
    extractCSharpImplementedInterfaces,
    extractCSharpReferenceHints,
    extractServiceRegistrations,
    resolveCSharpDependencyCandidates,

    // Module entry enrichment
    hydrateCSharpModuleEntries,
    enrichModuleEntries,
    buildModuleEntry,

    // Purpose/role helpers
    getRoleLabel,
    buildPurpose,
    formatInlineList,
    summarizePlainList,
  };
}

module.exports = { createSymbolExtraction };
