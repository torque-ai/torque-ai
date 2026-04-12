'use strict';

const fs = require('fs');
const fsPromises = require('node:fs/promises');
const path = require('path');
const { spawnSync } = require('child_process');

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

function createNoopLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function createOrchestratorHelpers(deps = {}) {
  const scanner = deps.scanner || null;
  const studyLogger = deps.logger || createNoopLogger();
  const toRepoPath = typeof deps.toRepoPath === 'function' ? deps.toRepoPath : defaultToRepoPath;
  const uniqueStrings = typeof deps.uniqueStrings === 'function' ? deps.uniqueStrings : defaultUniqueStrings;
  const uniquePaths = typeof deps.uniquePaths === 'function' ? deps.uniquePaths : createDefaultUniquePaths(toRepoPath);
  const GENERATED_STUDY_FILES = deps.GENERATED_STUDY_FILES instanceof Set ? deps.GENERATED_STUDY_FILES : new Set();
  const ALLOWED_EXTENSIONS = deps.ALLOWED_EXTENSIONS instanceof Set ? deps.ALLOWED_EXTENSIONS : new Set();
  const MAX_RUN_BATCH_COUNT = Number.isInteger(deps.MAX_RUN_BATCH_COUNT) && deps.MAX_RUN_BATCH_COUNT > 0
    ? deps.MAX_RUN_BATCH_COUNT
    : Number.MAX_SAFE_INTEGER;
  const buildModuleExportLookup = typeof deps.buildModuleExportLookup === 'function'
    ? deps.buildModuleExportLookup
    : (() => new Map());
  const buildModuleEntryMap = typeof deps.buildModuleEntryMap === 'function'
    ? deps.buildModuleEntryMap
    : (() => new Map());
  const buildInterfaceImplementationMap = typeof deps.buildInterfaceImplementationMap === 'function'
    ? deps.buildInterfaceImplementationMap
    : (() => new Map());
  const buildServiceRegistrationLookup = typeof deps.buildServiceRegistrationLookup === 'function'
    ? deps.buildServiceRegistrationLookup
    : (() => new Map());
  const extractCSharpExplicitExports = typeof deps.extractCSharpExplicitExports === 'function'
    ? deps.extractCSharpExplicitExports
    : (() => []);
  const extractCSharpImplementedInterfaces = typeof deps.extractCSharpImplementedInterfaces === 'function'
    ? deps.extractCSharpImplementedInterfaces
    : (() => []);
  const extractCSharpReferenceHints = typeof deps.extractCSharpReferenceHints === 'function'
    ? deps.extractCSharpReferenceHints
    : (() => ({
        namespaceName: null,
        usingNamespaces: [],
        dependencyTokens: [],
        constructorInjectedTokens: [],
      }));
  const extractServiceRegistrations = typeof deps.extractServiceRegistrations === 'function'
    ? deps.extractServiceRegistrations
    : (() => []);
  const resolveCSharpDependencyCandidates = typeof deps.resolveCSharpDependencyCandidates === 'function'
    ? deps.resolveCSharpDependencyCandidates
    : (() => []);

  function isStudyCandidate(filePath) {
    const normalized = toRepoPath(filePath);
    if (!normalized) return false;
    if (GENERATED_STUDY_FILES.has(normalized)) return false;
    return ALLOWED_EXTENSIONS.has(path.extname(normalized).toLowerCase());
  }

  function filterStudyCandidates(values) {
    return uniquePaths(values).filter(isStudyCandidate);
  }

  function splitGitOutput(output) {
    return String(output || '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
  }

  function normalizeNonNegativeInteger(value, fallback = 0) {
    return Number.isInteger(value) && value >= 0 ? value : fallback;
  }

  function normalizePositiveInteger(value, fallback = 1, maxValue = MAX_RUN_BATCH_COUNT) {
    if (!Number.isInteger(value) || value <= 0) {
      return fallback;
    }
    return Math.min(value, maxValue);
  }

  function buildCounts(trackedFiles, pendingFiles) {
    return {
      tracked: trackedFiles.length,
      pending: pendingFiles.length,
      up_to_date: Math.max(0, trackedFiles.length - pendingFiles.length),
    };
  }

  function extractReadmeIntro(content) {
    const lines = String(content || '').split(/\r?\n/);
    const collected = [];
    let started = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!started) {
        if (!trimmed || trimmed.startsWith('#')) continue;
        started = true;
        collected.push(trimmed);
        continue;
      }
      if (!trimmed) break;
      collected.push(trimmed);
    }
    return collected.join(' ');
  }

  async function writeTextFileIfChanged(filePath, nextContent) {
    let currentContent = null;
    try {
      currentContent = await fsPromises.readFile(filePath, 'utf8');
    } catch {
      currentContent = null;
    }
    if (currentContent === nextContent) {
      return false;
    }
    await fsPromises.writeFile(filePath, nextContent, 'utf8');
    return true;
  }

  function runGitCommand(workingDirectory, args) {
    const result = spawnSync('git', args, {
      cwd: workingDirectory,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      const stderr = (result.stderr || '').trim();
      throw new Error(stderr || `git ${args.join(' ')} failed with exit code ${result.status}`);
    }

    return (result.stdout || '').trim();
  }

  function safeHeadSha(workingDirectory) {
    try {
      return runGitCommand(workingDirectory, ['rev-parse', 'HEAD']);
    } catch (error) {
      studyLogger.warn('[codebase-study] unable to resolve HEAD sha: ' + (error.message || error));
      return null;
    }
  }

  function loadTrackedFiles(workingDirectory) {
    return filterStudyCandidates(splitGitOutput(runGitCommand(workingDirectory, ['ls-files'])));
  }

  function loadDeltaChanges(workingDirectory, lastSha) {
    if (!lastSha) {
      return {
        changed: loadTrackedFiles(workingDirectory),
        removed: [],
      };
    }

    try {
      const lines = splitGitOutput(runGitCommand(workingDirectory, ['diff', '--name-status', '--find-renames', lastSha, 'HEAD']));
      const changed = [];
      const removed = [];
      for (const line of lines) {
        const parts = line.split(/\t+/).map(part => part.trim()).filter(Boolean);
        if (parts.length === 0) continue;
        const status = parts[0];
        if (status.startsWith('R') || status.startsWith('C')) {
          const previousPath = parts[1];
          const nextPath = parts[2];
          if (isStudyCandidate(previousPath) && previousPath !== nextPath) removed.push(previousPath);
          if (isStudyCandidate(nextPath)) changed.push(nextPath);
          continue;
        }
        const filePath = parts[1];
        if (status.startsWith('D')) {
          if (isStudyCandidate(filePath)) removed.push(filePath);
          continue;
        }
        if (isStudyCandidate(filePath)) changed.push(filePath);
      }
      return {
        changed: uniquePaths(changed),
        removed: uniquePaths(removed),
      };
    } catch (error) {
      studyLogger.warn('[codebase-study] diff failed, falling back to ls-files: ' + (error.message || error));
      return {
        changed: loadTrackedFiles(workingDirectory),
        removed: [],
      };
    }
  }

  function mergeUnique(baseValues, newValues) {
    return uniquePaths([...(baseValues || []), ...(newValues || [])]);
  }

  function buildScanLookup(scanResult) {
    const scannedFiles = new Set(uniquePaths(scanResult?.files || []));
    const symbolLookup = new Map();
    const importLookup = new Map();

    for (const entry of Array.isArray(scanResult?.symbols) ? scanResult.symbols : []) {
      if (entry && typeof entry.file === 'string') {
        symbolLookup.set(entry.file, entry);
      }
    }
    for (const entry of Array.isArray(scanResult?.imports) ? scanResult.imports : []) {
      if (entry && typeof entry.file === 'string') {
        importLookup.set(entry.file, entry);
      }
    }

    return {
      scannedFiles,
      symbolLookup,
      importLookup,
    };
  }

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
      const deps = uniquePaths([...(entry.deps || []), ...inferredDeps]);
      const exports = uniqueStrings(entry.exports || []);
      return {
        ...entry,
        exports,
        deps,
        purpose: buildPurpose(entry.file, { exports, deps }),
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

  async function buildModuleEntry(workingDirectory, repoPath, scanLookup = null) {
    const fullPath = path.join(workingDirectory, repoPath);
    if (!fs.existsSync(fullPath)) return null;

    const extension = path.extname(repoPath).toLowerCase();
    const scannedFile = scanLookup?.scannedFiles?.has(repoPath) === true;
    const scannedSymbolsEntry = scanLookup?.symbolLookup?.get(repoPath) || null;
    const scannedImportEntry = scanLookup?.importLookup?.get(repoPath) || null;
    const fallbackScanLookup = scannedFile || !scanner
      ? null
      : buildScanLookup(await scanner.scanRepo(workingDirectory, { files: [repoPath] }));
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

  function formatCodeList(values, maxItems = 3) {
    const items = uniqueStrings(values).slice(0, maxItems).map(value => `\`${value}\``);
    return formatInlineList(items);
  }

  return {
    isStudyCandidate,
    filterStudyCandidates,
    splitGitOutput,
    normalizeNonNegativeInteger,
    normalizePositiveInteger,
    buildCounts,
    extractReadmeIntro,
    writeTextFileIfChanged,
    runGitCommand,
    safeHeadSha,
    loadTrackedFiles,
    loadDeltaChanges,
    mergeUnique,
    buildScanLookup,
    hydrateCSharpModuleEntries,
    enrichModuleEntries,
    getRoleLabel,
    summarizePlainList,
    buildPurpose,
    buildModuleEntry,
    formatInlineList,
    formatCodeList,
  };
}

module.exports = { createOrchestratorHelpers };
