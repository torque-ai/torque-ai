'use strict';

const path = require('path');

const DEFAULT_HOTSPOT_LIMIT = 6;
const DEFAULT_LOW_SIGNAL_HOTSPOT_BASENAMES = new Set(['logger.js', 'constants.js']);
const DEFAULT_SYMBOL_INDEX_EXTENSIONS = new Set(['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.py', '.cs']);

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

function normalizeHotspotLimit(value) {
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_HOTSPOT_LIMIT;
}

function normalizeStringSet(values, fallback, uniqueStrings) {
  if (values instanceof Set) {
    return new Set(uniqueStrings(Array.from(values)));
  }
  if (Array.isArray(values)) {
    return new Set(uniqueStrings(values));
  }
  return new Set(uniqueStrings(Array.from(fallback)));
}

function normalizeLowercaseStringSet(values, fallback, uniqueStrings) {
  const source = values instanceof Set
    ? Array.from(values)
    : (Array.isArray(values) ? values : Array.from(fallback));
  return new Set(
    uniqueStrings(source)
      .map(value => String(value || '').trim().toLowerCase())
      .filter(Boolean)
  );
}

function createMissingDependencyError(name) {
  return new Error(`createHotspotsAnalyzer requires deps.${name}`);
}

function createHotspotsAnalyzer(deps = {}) {
  const toRepoPath = typeof deps.toRepoPath === 'function' ? deps.toRepoPath : defaultToRepoPath;
  const uniqueStrings = typeof deps.uniqueStrings === 'function' ? deps.uniqueStrings : defaultUniqueStrings;
  const uniquePaths = typeof deps.uniquePaths === 'function' ? deps.uniquePaths : createDefaultUniquePaths(toRepoPath);
  const HOTSPOT_LIMIT = normalizeHotspotLimit(deps.HOTSPOT_LIMIT);
  const LOW_SIGNAL_HOTSPOT_BASENAMES = normalizeStringSet(
    deps.LOW_SIGNAL_HOTSPOT_BASENAMES,
    DEFAULT_LOW_SIGNAL_HOTSPOT_BASENAMES,
    uniqueStrings
  );
  const SYMBOL_INDEX_EXTENSIONS = normalizeLowercaseStringSet(
    deps.SYMBOL_INDEX_EXTENSIONS,
    DEFAULT_SYMBOL_INDEX_EXTENSIONS,
    uniqueStrings
  );
  const getSubsystemForFile = deps.getSubsystemForFile;
  const isLikelyEntrypoint = deps.isLikelyEntrypoint;

  function resolveSubsystem(filePath, activeProfile) {
    if (typeof getSubsystemForFile !== 'function') {
      throw createMissingDependencyError('getSubsystemForFile');
    }
    return getSubsystemForFile(filePath, activeProfile);
  }

  function resolveEntrypoint(filePath) {
    if (typeof isLikelyEntrypoint !== 'function') {
      throw createMissingDependencyError('isLikelyEntrypoint');
    }
    return isLikelyEntrypoint(filePath);
  }

  function isLowSignalHotspotFile(repoPath) {
    return LOW_SIGNAL_HOTSPOT_BASENAMES.has(path.basename(toRepoPath(repoPath)));
  }

  function isStructuredContentFile(repoPath) {
    const normalized = toRepoPath(repoPath).toLowerCase();
    if (!normalized) {
      return false;
    }
    if (/\.(json|ya?ml|toml|ini)$/.test(normalized)) {
      return true;
    }
    return /(^|\/)(lang|locales?|i18n|manifests?|schemas?|fixtures|contracts)\//.test(normalized);
  }

  function isExecutableSurfaceFile(repoPath) {
    const normalized = toRepoPath(repoPath);
    const ext = path.extname(normalized).toLowerCase();
    if (SYMBOL_INDEX_EXTENSIONS.has(ext)) {
      return true;
    }
    const base = path.basename(normalized).toLowerCase();
    return base === 'index.html'
      || base === 'gulpfile.js'
      || base === 'dev-server.js'
      || base === 'app.xaml'
      || base === 'app.xaml.cs';
  }

  function isPrimaryRuntimeSurface(repoPath) {
    const normalized = toRepoPath(repoPath).toLowerCase();
    if (!normalized || normalized.startsWith('tools/')) {
      return false;
    }
    return normalized.startsWith('src/')
      || normalized.startsWith('server/')
      || normalized.startsWith('app/')
      || normalized.startsWith('client/')
      || normalized.startsWith('dashboard/')
      || normalized.startsWith('bin/')
      || normalized.startsWith('cli/');
  }

  function getHotspotStructuralBoost(repoPath) {
    const normalized = toRepoPath(repoPath).toLowerCase();
    if (!normalized) {
      return 0;
    }

    let boost = 0;
    if (isPrimaryRuntimeSurface(normalized)) {
      boost += 4;
    }
    if (/(?:^|\/)(?:application|domain|core|runtime|services?|infrastructure|ledger|accounting|banking|workflow|pipeline|state|parser|execution|setup)\//.test(normalized)) {
      boost += 6;
    }
    if (/(?:engine|service|manager|coordinator|provider|handler|dispatcher|repository|store|validator|processor|orchestrator)\.[^.]+$/.test(normalized)) {
      boost += 8;
    }
    if (/(?:initializer|seeder|bootstrapper|builder)\.[^.]+$/.test(normalized)) {
      boost += 6;
    }
    if (/(?:controller)\.[^.]+$/.test(normalized)) {
      boost += 5;
    }
    if (/(?:viewmodel|window|dialog|page|screen|panel|form|view)\.[^.]+$/.test(normalized)) {
      boost += 2;
    }
    if (/(?:tabviewmodel|window|dialog|page|screen)\.[^.]+$/.test(normalized)) {
      boost -= 3;
    }
    return boost;
  }

  function isShallowToolEntrypoint(filePath, inboundDependents, outboundDependencies, exportCount) {
    const normalized = toRepoPath(filePath).toLowerCase();
    if (!normalized || !normalized.startsWith('tools/') || !resolveEntrypoint(normalized)) {
      return false;
    }
    return (Number(inboundDependents) || 0) <= 1
      && (Number(outboundDependencies) || 0) <= 3
      && (Number(exportCount) || 0) <= 2;
  }

  function getHotspotRoleBucket(repoPath) {
    const normalized = toRepoPath(repoPath).toLowerCase();
    if (!normalized) {
      return 'module';
    }
    if (resolveEntrypoint(normalized)) {
      return 'entrypoint';
    }
    if (/(?:engine|service|manager|coordinator|provider|handler|dispatcher|validator|processor|orchestrator)\.[^.]+$/.test(normalized)) {
      return 'logic';
    }
    if (/(?:initializer|seeder|bootstrapper|builder|migration)\.[^.]+$/.test(normalized) || /(^|\/)setup\//.test(normalized)) {
      return 'setup';
    }
    if (/(?:repository|store|client|gateway|adapter|dbcontext)\.[^.]+$/.test(normalized)) {
      return 'integration';
    }
    if (/(?:viewmodel|window|dialog|page|screen|panel|form|view|promptservice)\.[^.]+$/.test(normalized)) {
      return 'presentation';
    }
    if (isStructuredContentFile(normalized)) {
      return 'content';
    }
    return 'module';
  }

  function getHotspotAreaKey(filePath) {
    const segments = toRepoPath(filePath).split('/').filter(Boolean);
    if (segments.length === 0) {
      return '';
    }
    if (segments[0] === 'src' && segments.length >= 3) {
      return segments.slice(0, 3).join('/');
    }
    return segments.slice(0, Math.min(2, segments.length)).join('/');
  }

  function getHotspotCategoryPriority(roleBucket, signalType) {
    if (roleBucket === 'entrypoint') return 6;
    if (roleBucket === 'logic') return 5;
    if (roleBucket === 'setup') return 4;
    if (roleBucket === 'integration') return 3;
    if (signalType === 'runtime') return 2;
    if (roleBucket === 'module') return 1;
    if (roleBucket === 'presentation') return 0;
    if (roleBucket === 'content') return -1;
    return 0;
  }

  function selectDiverseHotspots(candidates, limit = HOTSPOT_LIMIT) {
    const selected = [];
    const selectedFiles = new Set();
    const areaCounts = new Map();
    const roleCounts = new Map();

    const trySelect = (candidate, enforceDiversity) => {
      const areaKey = candidate.area_key || getHotspotAreaKey(candidate.file);
      const roleBucket = candidate.role_bucket || getHotspotRoleBucket(candidate.file);
      const areaLimit = roleBucket === 'presentation' ? 1 : 2;
      const roleLimit = roleBucket === 'presentation' ? 2 : 3;
      if (selectedFiles.has(candidate.file)) {
        return false;
      }
      if (enforceDiversity) {
        if ((areaCounts.get(areaKey) || 0) >= areaLimit) {
          return false;
        }
        if ((roleCounts.get(roleBucket) || 0) >= roleLimit) {
          return false;
        }
      }

      selected.push(candidate);
      selectedFiles.add(candidate.file);
      areaCounts.set(areaKey, (areaCounts.get(areaKey) || 0) + 1);
      roleCounts.set(roleBucket, (roleCounts.get(roleBucket) || 0) + 1);
      return true;
    };

    for (const candidate of candidates || []) {
      if (selected.length >= limit) {
        break;
      }
      trySelect(candidate, true);
    }

    for (const candidate of candidates || []) {
      if (selected.length >= limit) {
        break;
      }
      trySelect(candidate, false);
    }

    return selected;
  }

  function getEntrypointCorePathBoost(filePath, moduleMap, hotspotFiles, reverseDeps) {
    const normalized = toRepoPath(filePath);
    const effectiveModuleMap = moduleMap && typeof moduleMap.get === 'function' ? moduleMap : new Map();
    const effectiveHotspotFiles = hotspotFiles instanceof Set ? hotspotFiles : new Set(uniquePaths(hotspotFiles || []));
    const effectiveReverseDeps = reverseDeps && typeof reverseDeps.get === 'function' ? reverseDeps : new Map();
    const moduleEntry = effectiveModuleMap.get(normalized);
    if (!moduleEntry) {
      return { boost: 0, evidence: [] };
    }

    const evidence = [];
    const directDeps = uniquePaths(moduleEntry.deps || []);
    const directHotspots = directDeps.filter(dependency => effectiveHotspotFiles.has(dependency));
    const coreDeps = directDeps.filter(dependency => ['logic', 'setup', 'integration'].includes(getHotspotRoleBucket(dependency)));
    const secondHopHotspots = uniquePaths(directDeps.flatMap(dependency => effectiveModuleMap.get(dependency)?.deps || []))
      .filter(dependency => effectiveHotspotFiles.has(dependency));

    let boost = 0;
    if (directHotspots.length > 0) {
      boost += Math.min(14, directHotspots.length * 7);
      evidence.push('Direct dependencies reach hotspot-ranked implementation seams.');
    }
    if (coreDeps.length > 0) {
      boost += Math.min(10, coreDeps.length * 4);
      evidence.push('Direct dependencies lead into core logic or setup layers.');
    }
    if (secondHopHotspots.length > 0) {
      boost += Math.min(6, secondHopHotspots.length * 2);
      evidence.push('One dependency hop reaches a high-signal implementation seam.');
    }
    if (directDeps.length > 0) {
      boost += Math.min(4, directDeps.length);
    }
    const inboundDependents = effectiveReverseDeps.get(normalized)?.size || 0;
    if (inboundDependents > 0) {
      boost += Math.min(4, inboundDependents);
      evidence.push('Referenced by additional modules, suggesting it is a shared runtime seam.');
    }

    return {
      boost,
      evidence,
    };
  }

  function scoreToConfidence(score) {
    if (score >= 24) {
      return 'high';
    }
    if (score >= 12) {
      return 'medium';
    }
    return 'low';
  }

  function buildReverseDependencyMap(entries) {
    const moduleFiles = new Set((entries || []).map(entry => entry.file));
    const reverseDeps = new Map();
    for (const entry of entries || []) {
      for (const dep of entry.deps || []) {
        if (!moduleFiles.has(dep)) {
          continue;
        }
        if (!reverseDeps.has(dep)) {
          reverseDeps.set(dep, new Set());
        }
        reverseDeps.get(dep).add(entry.file);
      }
    }
    return reverseDeps;
  }

  function buildHotspotReason(entry, inboundDependents, subsystemLabel) {
    const outboundDependencies = (entry.deps || []).length;
    const exportCount = (entry.exports || []).length;
    if (isStructuredContentFile(entry.file)) {
      if (inboundDependents >= 2) {
        return `Structured content or contract file reused by ${inboundDependents} indexed modules in ${subsystemLabel}.`;
      }
      return `Structured content or contract file that anchors ${subsystemLabel}.`;
    }
    if (inboundDependents >= 3 && outboundDependencies >= 3) {
      return `High fan-in (${inboundDependents}) and fan-out (${outboundDependencies}) inside ${subsystemLabel}.`;
    }
    if (inboundDependents >= 3) {
      return `Shared internal dependency reused by ${inboundDependents} indexed modules in ${subsystemLabel}.`;
    }
    if (outboundDependencies >= 5) {
      return `Touches many dependencies (${outboundDependencies}), so changes here can ripple broadly.`;
    }
    if (exportCount >= 4) {
      return `Exports a broad surface (${exportCount} symbols), making it a likely API seam.`;
    }
    return `Representative file in ${subsystemLabel}.`;
  }

  function buildHotspots(entries, reverseDeps, subsystemLookup, activeProfile, repoSignals = null) {
    const hasPrimaryAppSurface = (entries || []).some((entry) => {
      const normalized = toRepoPath(entry?.file).toLowerCase();
      if (!isPrimaryRuntimeSurface(normalized)) {
        return false;
      }
      return resolveEntrypoint(normalized)
        || (entry?.deps || []).length > 0
        || (entry?.exports || []).length > 0
        || getHotspotStructuralBoost(normalized) >= 10;
    });
    const candidates = (entries || [])
      .map((entry) => {
        const inboundDependents = reverseDeps.get(entry.file)?.size || 0;
        const subsystem = subsystemLookup.get(entry.file) || resolveSubsystem(entry.file, activeProfile);
        const outboundDependencies = (entry.deps || []).length;
        const exportCount = (entry.exports || []).length;
        const lowSignalPenalty = isLowSignalHotspotFile(entry.file) ? 25 : 0;
        const structuredContent = isStructuredContentFile(entry.file);
        const executableSurface = isExecutableSurfaceFile(entry.file);
        const contentPenalty = structuredContent
          ? ((repoSignals?.archetype === 'content-heavy-javascript-repo' || (repoSignals?.traits || []).includes('content')) ? 8 : 18)
          : 0;
        const executableBoost = executableSurface ? 6 : 0;
        const structuralBoost = getHotspotStructuralBoost(entry.file);
        const shallowToolPenalty = hasPrimaryAppSurface && isShallowToolEntrypoint(
          entry.file,
          inboundDependents,
          outboundDependencies,
          exportCount
        ) ? 18 : 0;
        const score = ((inboundDependents * 4) + (outboundDependencies * 2) + exportCount + (resolveEntrypoint(entry.file) ? 3 : 0))
          - lowSignalPenalty
          - contentPenalty
          - shallowToolPenalty
          + executableBoost
          + structuralBoost;
        const roleBucket = getHotspotRoleBucket(entry.file);
        return {
          file: entry.file,
          subsystem: subsystem.id,
          subsystem_label: subsystem.label,
          inbound_dependents: inboundDependents,
          outbound_dependencies: outboundDependencies,
          export_count: exportCount,
          signal_type: structuredContent ? 'content' : (executableSurface ? 'runtime' : 'module'),
          reason: buildHotspotReason(entry, inboundDependents, subsystem.label),
          confidence: scoreToConfidence(score),
          evidence: {
            inbound_dependents: inboundDependents,
            outbound_dependencies: outboundDependencies,
            export_count: exportCount,
            structured_content: structuredContent,
            executable_surface: executableSurface,
          },
          role_bucket: roleBucket,
          area_key: getHotspotAreaKey(entry.file),
          category_priority: getHotspotCategoryPriority(roleBucket, structuredContent ? 'content' : (executableSurface ? 'runtime' : 'module')),
          score,
        };
      })
      .sort((left, right) => (
        right.score - left.score
        || right.category_priority - left.category_priority
        || left.file.localeCompare(right.file)
      ));

    return selectDiverseHotspots(candidates, HOTSPOT_LIMIT)
      .map(({ score, area_key, category_priority, role_bucket, ...rest }) => rest);
  }

  function analyzeHotspots(input = {}) {
    const entries = Array.isArray(input.entries) ? input.entries : [];
    const reverseDeps = input.reverseDeps && typeof input.reverseDeps.get === 'function'
      ? input.reverseDeps
      : buildReverseDependencyMap(entries);
    const subsystemLookup = input.subsystemLookup && typeof input.subsystemLookup.get === 'function'
      ? input.subsystemLookup
      : new Map();
    return buildHotspots(entries, reverseDeps, subsystemLookup, input.activeProfile, input.repoSignals || null);
  }

  function summarizeHotspots(results) {
    const items = Array.isArray(results) ? results.filter(result => result && typeof result === 'object') : [];
    const byRoleBucket = {};
    for (const result of items) {
      const roleBucket = getHotspotRoleBucket(result.file);
      byRoleBucket[roleBucket] = (byRoleBucket[roleBucket] || 0) + 1;
    }
    return {
      count: items.length,
      byRoleBucket,
      topFiles: uniquePaths(items.map(result => result.file)).slice(0, HOTSPOT_LIMIT),
    };
  }

  return {
    analyzeHotspots,
    summarizeHotspots,
    buildHotspots,
    buildHotspotReason,
    buildReverseDependencyMap,
    selectDiverseHotspots,
    scoreToConfidence,
    isLowSignalHotspotFile,
    isStructuredContentFile,
    isExecutableSurfaceFile,
    isPrimaryRuntimeSurface,
    getHotspotStructuralBoost,
    isShallowToolEntrypoint,
    getHotspotRoleBucket,
    getHotspotAreaKey,
    getHotspotCategoryPriority,
    getEntrypointCorePathBoost,
  };
}

module.exports = {
  createHotspotsAnalyzer,
};
