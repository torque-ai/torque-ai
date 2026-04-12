'use strict';

function defaultToRepoPath(filePath) {
  return String(filePath || '').trim().replace(/\\/g, '/');
}

function defaultUniqueStrings(values) {
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

function createDefaultUniquePaths(toRepoPath) {
  return function uniquePaths(values) {
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
  };
}

function defaultFormatInlineList(values) {
  const items = (values || []).filter(Boolean);
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function createDefaultFormatCodeList(uniqueStrings, formatInlineList) {
  return function formatCodeList(values, maxItems = 3) {
    const items = uniqueStrings(values).slice(0, maxItems).map(value => `\`${value}\``);
    return formatInlineList(items);
  };
}

function createSubsystems(deps = {}) {
  const toRepoPath = typeof deps.toRepoPath === 'function' ? deps.toRepoPath : defaultToRepoPath;
  const uniqueStrings = typeof deps.uniqueStrings === 'function' ? deps.uniqueStrings : defaultUniqueStrings;
  const uniquePaths = typeof deps.uniquePaths === 'function' ? deps.uniquePaths : createDefaultUniquePaths(toRepoPath);
  const formatInlineList = typeof deps.formatInlineList === 'function'
    ? deps.formatInlineList
    : defaultFormatInlineList;
  const formatCodeList = typeof deps.formatCodeList === 'function'
    ? deps.formatCodeList
    : createDefaultFormatCodeList(uniqueStrings, formatInlineList);
  const isLikelyEntrypoint = typeof deps.isLikelyEntrypoint === 'function'
    ? deps.isLikelyEntrypoint
    : (() => false);
  const ROOT_DOC_FILES = deps.ROOT_DOC_FILES instanceof Set
    ? deps.ROOT_DOC_FILES
    : new Set(['README.md', 'CLAUDE.md', 'CONTRIBUTING.md']);
  const LOW_SIGNAL_EXPORT_NAMES = deps.LOW_SIGNAL_EXPORT_NAMES instanceof Set
    ? deps.LOW_SIGNAL_EXPORT_NAMES
    : new Set(['default', 'test', 'tests', 'value', 'values', 'data', 'result', 'results', 'foo', 'bar', 'baz']);
  const RELATIONSHIP_LIMIT = Number.isInteger(deps.RELATIONSHIP_LIMIT) && deps.RELATIONSHIP_LIMIT > 0
    ? deps.RELATIONSHIP_LIMIT
    : 8;

  function matchesSubsystemDefinition(definition, repoPath) {
    const normalized = toRepoPath(repoPath);
    if (Array.isArray(definition.exact) && definition.exact.includes(normalized)) {
      return true;
    }
    if (Array.isArray(definition.prefixes) && definition.prefixes.some(prefix => normalized.startsWith(prefix))) {
      return true;
    }
    if (Array.isArray(definition.patterns) && definition.patterns.some(pattern => pattern.test(normalized))) {
      return true;
    }
    return false;
  }

  function buildFallbackSubsystem(repoPath) {
    const normalized = toRepoPath(repoPath);
    if (ROOT_DOC_FILES.has(normalized)) {
      return {
        id: 'docs-and-guides',
        label: 'Documentation and guides',
        description: 'Documentation, generated architecture artifacts, and reference material for humans and models.',
      };
    }
    if (!normalized.includes('/')) {
      return {
        id: 'project-root',
        label: 'Project root and shared config',
        description: 'Root config, package metadata, and entrypoints that tie the repository together.',
      };
    }
    const segments = normalized.split('/').filter(Boolean);
    const topLevel = segments[0];
    if (topLevel === 'server' && segments.length >= 2) {
      const secondLevel = segments[1];
      return {
        id: `server-${secondLevel}-area`,
        label: `server ${secondLevel}`,
        description: `Files rooted under \`server/${secondLevel}/\`.`,
      };
    }
    return {
      id: `${topLevel}-area`,
      label: `${topLevel} area`,
      description: `Files rooted under \`${topLevel}/\`.`,
    };
  }

  function getSubsystemForFile(repoPath, activeProfile) {
    const normalized = toRepoPath(repoPath);
    const definition = (activeProfile?.subsystem_definitions || []).find(def => matchesSubsystemDefinition(def, normalized));
    if (definition) {
      return {
        id: definition.id,
        label: definition.label,
        description: definition.description,
      };
    }
    return buildFallbackSubsystem(normalized);
  }

  function buildSubsystemLookup(values, activeProfile) {
    const lookup = new Map();
    for (const repoPath of uniquePaths(values)) {
      lookup.set(repoPath, getSubsystemForFile(repoPath, activeProfile));
    }
    return lookup;
  }

  function countOccurrences(values) {
    const counts = new Map();
    for (const value of values || []) {
      const normalized = String(value || '').trim();
      if (!normalized) {
        continue;
      }
      counts.set(normalized, (counts.get(normalized) || 0) + 1);
    }
    return counts;
  }

  function getSubsystemPriority(activeProfile, subsystemId) {
    return activeProfile?.subsystem_priority?.[subsystemId] || 30;
  }

  function isMeaningfulExportName(name) {
    const normalized = String(name || '').trim();
    if (!normalized) return false;
    const lowered = normalized.toLowerCase();
    if (LOW_SIGNAL_EXPORT_NAMES.has(lowered)) return false;
    if (normalized.length <= 1) return false;
    if (/^test\d*$/i.test(normalized)) return false;
    return true;
  }

  function buildDetectionSummary(repoSignals) {
    if (!repoSignals || typeof repoSignals !== 'object') {
      return null;
    }
    return {
      archetype: repoSignals.archetype || 'generic-javascript-repo',
      confidence: repoSignals.confidence || 'medium',
      frameworks: uniqueStrings(repoSignals.frameworks || []),
      traits: uniqueStrings(repoSignals.traits || []),
      evidence: uniqueStrings(repoSignals.evidence || []),
    };
  }

  function toFrequencyEntries(values, limit = 5) {
    return Array.from(countOccurrences(values).entries())
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, limit)
      .map(([name, count]) => ({ name, count }));
  }

  function formatFrequencyList(items, maxItems = 3) {
    return formatInlineList((items || []).slice(0, maxItems).map(item => `\`${item.name}\` (${item.count})`));
  }

  function buildSubsystemRows(entries, context = {}) {
    const trackedFiles = uniquePaths(context.trackedFiles);
    const pendingFiles = uniquePaths(context.pendingFiles);
    const reverseDeps = context.reverseDeps || new Map();
    const activeProfile = context.activeProfile || null;
    const subsystemLookup = context.subsystemLookup || buildSubsystemLookup([...trackedFiles, ...entries.map(entry => entry.file)], activeProfile);
    const trackedBySubsystem = new Map();
    const pendingBySubsystem = new Map();
    const entriesBySubsystem = new Map();
    const subsystemMeta = new Map();

    const recordSubsystem = (filePath) => {
      const subsystem = subsystemLookup.get(filePath) || getSubsystemForFile(filePath, activeProfile);
      subsystemLookup.set(filePath, subsystem);
      subsystemMeta.set(subsystem.id, subsystem);
      return subsystem;
    };

    for (const filePath of trackedFiles) {
      const subsystem = recordSubsystem(filePath);
      if (!trackedBySubsystem.has(subsystem.id)) trackedBySubsystem.set(subsystem.id, []);
      trackedBySubsystem.get(subsystem.id).push(filePath);
    }

    for (const filePath of pendingFiles) {
      const subsystem = recordSubsystem(filePath);
      if (!pendingBySubsystem.has(subsystem.id)) pendingBySubsystem.set(subsystem.id, []);
      pendingBySubsystem.get(subsystem.id).push(filePath);
    }

    for (const entry of entries || []) {
      const subsystem = recordSubsystem(entry.file);
      if (!entriesBySubsystem.has(subsystem.id)) entriesBySubsystem.set(subsystem.id, []);
      entriesBySubsystem.get(subsystem.id).push(entry);
    }

    const subsystemIds = uniqueStrings([
      ...subsystemMeta.keys(),
      ...trackedBySubsystem.keys(),
      ...pendingBySubsystem.keys(),
      ...entriesBySubsystem.keys(),
    ]);

    return subsystemIds.map((subsystemId) => {
      const subsystem = subsystemMeta.get(subsystemId);
      const subsystemEntries = (entriesBySubsystem.get(subsystemId) || []).slice();
      const tracked = uniquePaths(trackedBySubsystem.get(subsystemId) || []);
      const pending = uniquePaths(pendingBySubsystem.get(subsystemId) || []);
      const rankedEntries = subsystemEntries
        .map((entry) => {
          const inboundDependents = reverseDeps.get(entry.file)?.size || 0;
          return {
            entry,
            inboundDependents,
            score: (inboundDependents * 4) + ((entry.deps || []).length * 2) + (entry.exports || []).length + (isLikelyEntrypoint(entry.file) ? 3 : 0),
          };
        })
        .sort((left, right) => right.score - left.score || left.entry.file.localeCompare(right.entry.file));

      const representativeFiles = uniquePaths([
        ...rankedEntries.map(item => item.entry.file),
        ...tracked,
      ]).slice(0, 5);
      const entrypoints = representativeFiles.filter(isLikelyEntrypoint).slice(0, 4);
      const keyExports = subsystem.id === 'validation-tests'
        ? []
        : toFrequencyEntries(subsystemEntries.flatMap(entry => entry.exports || []).filter(isMeaningfulExportName), 8);
      const keyDependencies = toFrequencyEntries(subsystemEntries.flatMap(entry => entry.deps || []), 8);
      const centralFiles = rankedEntries.slice(0, 3).map((item) => ({
        file: item.entry.file,
        inbound_dependents: item.inboundDependents,
        outbound_dependencies: (item.entry.deps || []).length,
        export_count: (item.entry.exports || []).length,
      }));

      let overview = subsystem?.description || 'Repository subsystem.';
      overview += ` Coverage: ${subsystemEntries.length}/${tracked.length || subsystemEntries.length} indexed`;
      if (pending.length > 0) overview += `, ${pending.length} pending`;
      overview += '.';
      if (representativeFiles.length > 0) overview += ` Representative files: ${formatCodeList(representativeFiles)}.`;
      if (subsystem.id === 'validation-tests') {
        overview += ' Test-heavy area; representative suites and helper dependencies matter more than exported symbols.';
      } else if (keyExports.length > 0) {
        overview += ` Key exports: ${formatFrequencyList(keyExports)}.`;
      }
      if (keyDependencies.length > 0) overview += ` Key dependencies: ${formatFrequencyList(keyDependencies, 2)}.`;

      return {
        id: subsystem.id,
        label: subsystem.label,
        description: subsystem.description,
        summary_priority: getSubsystemPriority(activeProfile, subsystem.id),
        overview,
        coverage: {
          tracked_files: tracked.length,
          indexed_modules: subsystemEntries.length,
          pending_files: pending.length,
        },
        representative_files: representativeFiles,
        entrypoints: entrypoints.length > 0 ? entrypoints : representativeFiles.slice(0, 3),
        key_exports: keyExports,
        key_dependencies: keyDependencies,
        central_files: centralFiles,
      };
    }).sort((left, right) => {
      const priorityDiff = (right.summary_priority || 0) - (left.summary_priority || 0);
      if (priorityDiff !== 0) return priorityDiff;
      const moduleDiff = right.coverage.indexed_modules - left.coverage.indexed_modules;
      if (moduleDiff !== 0) return moduleDiff;
      const trackedDiff = right.coverage.tracked_files - left.coverage.tracked_files;
      if (trackedDiff !== 0) return trackedDiff;
      return left.label.localeCompare(right.label);
    });
  }

  function buildSubsystemRelationships(entries, subsystemLookup, activeProfile) {
    const moduleFiles = new Set((entries || []).map(entry => entry.file));
    const edgeMap = new Map();

    for (const entry of entries || []) {
      const sourceSubsystem = subsystemLookup.get(entry.file) || getSubsystemForFile(entry.file, activeProfile);
      for (const dep of entry.deps || []) {
        if (!moduleFiles.has(dep)) continue;
        const targetSubsystem = subsystemLookup.get(dep) || getSubsystemForFile(dep, activeProfile);
        if (sourceSubsystem.id === targetSubsystem.id) continue;
        const key = `${sourceSubsystem.id}->${targetSubsystem.id}`;
        if (!edgeMap.has(key)) {
          edgeMap.set(key, {
            from: sourceSubsystem.id,
            from_label: sourceSubsystem.label,
            to: targetSubsystem.id,
            to_label: targetSubsystem.label,
            count: 0,
            example_edges: [],
            evidence_files: [],
          });
        }
        const edge = edgeMap.get(key);
        edge.count += 1;
        const example = `${entry.file} -> ${dep}`;
        if (edge.example_edges.length < 3 && !edge.example_edges.includes(example)) {
          edge.example_edges.push(example);
        }
        for (const evidenceFile of [entry.file, dep]) {
          if (edge.evidence_files.length >= 6 || edge.evidence_files.includes(evidenceFile)) continue;
          edge.evidence_files.push(evidenceFile);
        }
      }
    }

    return Array.from(edgeMap.values())
      .sort((left, right) => right.count - left.count || `${left.from_label}:${left.to_label}`.localeCompare(`${right.from_label}:${right.to_label}`))
      .slice(0, RELATIONSHIP_LIMIT);
  }

  return {
    buildSubsystemRows,
    buildFallbackSubsystem,
    matchesSubsystemDefinition,
    getSubsystemForFile,
    buildSubsystemLookup,
    getSubsystemPriority,
    buildDetectionSummary,
    toFrequencyEntries,
    formatFrequencyList,
    buildSubsystemRelationships,
    countOccurrences,
  };
}

module.exports = { createSubsystems };
