'use strict';

const path = require('path');

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

function createFlowDefinitions(deps = {}) {
  const toRepoPath = typeof deps.toRepoPath === 'function' ? deps.toRepoPath : defaultToRepoPath;
  const uniqueStrings = typeof deps.uniqueStrings === 'function' ? deps.uniqueStrings : defaultUniqueStrings;
  const uniquePaths = typeof deps.uniquePaths === 'function' ? deps.uniquePaths : createDefaultUniquePaths(toRepoPath);
  const getSubsystemForFile = typeof deps.getSubsystemForFile === 'function'
    ? deps.getSubsystemForFile
    : (() => ({ id: 'unknown', label: 'unknown', description: '' }));
  const buildModuleEntryMap = typeof deps.buildModuleEntryMap === 'function'
    ? deps.buildModuleEntryMap
    : (() => new Map());
  const isTestFile = typeof deps.isTestFile === 'function' ? deps.isTestFile : (() => false);
  const isStructuredContentFile = typeof deps.isStructuredContentFile === 'function' ? deps.isStructuredContentFile : (() => false);
  const isExecutableSurfaceFile = typeof deps.isExecutableSurfaceFile === 'function' ? deps.isExecutableSurfaceFile : (() => false);
  const buildReverseDependencyMap = typeof deps.buildReverseDependencyMap === 'function'
    ? deps.buildReverseDependencyMap
    : (() => new Map());
  const getEntrypointCorePathBoost = typeof deps.getEntrypointCorePathBoost === 'function'
    ? deps.getEntrypointCorePathBoost
    : (() => ({ boost: 0, evidence: [] }));
  const selectDiverseHotspots = typeof deps.selectDiverseHotspots === 'function'
    ? deps.selectDiverseHotspots
    : (items => Array.isArray(items) ? items : []);
  const GENERIC_FLOW_IDS = deps.GENERIC_FLOW_IDS && typeof deps.GENERIC_FLOW_IDS === 'object'
    ? deps.GENERIC_FLOW_IDS
    : Object.freeze({
        ENTRY_RUNTIME: 'generic-entry-runtime',
        CONFIG_CONTRACTS: 'generic-config-contracts',
        CHANGE_VALIDATION: 'generic-change-validation',
      });
  const SYMBOL_INDEX_EXTENSIONS = deps.SYMBOL_INDEX_EXTENSIONS instanceof Set
    ? deps.SYMBOL_INDEX_EXTENSIONS
    : new Set(['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.py', '.cs']);

  function isLikelyEntrypoint(repoPath) {
    const normalized = toRepoPath(repoPath);
    const base = path.basename(normalized);
    const lowerBase = base.toLowerCase();
    return normalized === 'server/index.js'
      || normalized === 'server/task-manager.js'
      || normalized === 'server/tools.js'
      || normalized === 'dashboard/src/main.jsx'
      || normalized === 'dashboard/src/App.jsx'
      || normalized === 'bin/torque.js'
      || normalized === 'cli/torque-cli.js'
      || lowerBase === 'program.cs'
      || lowerBase === 'app.xaml.cs'
      || lowerBase === '__main__.py'
      || lowerBase === 'cli.py'
      || lowerBase === 'server.py'
      || lowerBase === 'main.py'
      || lowerBase === 'main.cs'
      || lowerBase === 'index.js'
      || lowerBase === 'main.jsx'
      || lowerBase === 'main.js'
      || lowerBase === 'app.js'
      || lowerBase === 'bootstrap.js'
      || lowerBase === 'bootstrap.ts';
  }

  function inferGenericEntrypointCandidate(filePath, repoMetadata, repoSignals = null) {
    const normalized = toRepoPath(filePath);
    if (!normalized || isStructuredContentFile(normalized) || isTestFile(normalized)) {
      return null;
    }

    const base = path.basename(normalized).toLowerCase();
    const segments = normalized.split('/').filter(Boolean);
    let score = 0;
    let role = '';
    const evidence = [];

    if (normalized === toRepoPath(repoMetadata?.package_main)) {
      score = 180;
      role = 'Primary package runtime entrypoint';
      evidence.push('Detected from package.json main.');
    } else if ((repoMetadata?.bin_files || []).includes(normalized)) {
      score = 175;
      role = 'Primary CLI entrypoint';
      evidence.push('Detected from package.json bin.');
    } else if (normalized === 'server/index.js') {
      score = 170;
      role = 'Server bootstrap and background scheduler startup';
      evidence.push('Recognized server bootstrap path.');
    } else if (normalized === 'server/task-manager.js') {
      score = 166;
      role = 'Top-level task execution coordinator';
      evidence.push('Recognized task orchestration seam.');
    } else if (normalized === 'server/tools.js') {
      score = 164;
      role = 'Tool catalog and dispatch surface';
      evidence.push('Recognized tool dispatch seam.');
    } else if (normalized === 'server/api/v2-dispatch.js') {
      score = 162;
      role = 'Primary control-plane dispatch surface';
      evidence.push('Recognized control-plane dispatch seam.');
    } else if (normalized === 'dashboard/src/main.jsx') {
      score = 160;
      role = 'Dashboard client bootstrap';
      evidence.push('Recognized UI bootstrap path.');
    } else if (normalized === 'dashboard/src/App.jsx') {
      score = 158;
      role = 'Dashboard shell composition';
      evidence.push('Recognized UI shell path.');
    } else if (normalized === 'bin/torque.js') {
      score = 156;
      role = 'CLI bootstrap for local command use';
      evidence.push('Recognized CLI bootstrap path.');
    } else if (base === 'program.cs') {
      score = 152;
      role = 'Primary .NET application or CLI entrypoint';
      evidence.push('Matched conventional .NET Program.cs startup file.');
    } else if (base === 'app.xaml.cs') {
      score = 149;
      role = 'Desktop application startup entrypoint';
      evidence.push('Matched WPF App.xaml.cs startup file.');
    } else if (base === '__main__.py') {
      score = 146;
      role = 'Primary Python module entrypoint';
      evidence.push('Matched Python __main__ entrypoint.');
    } else if (base === 'cli.py') {
      score = 142;
      role = 'Python CLI bootstrap';
      evidence.push('Matched Python CLI entrypoint.');
    } else if (base === 'server.py') {
      score = 140;
      role = 'Python service or server bootstrap';
      evidence.push('Matched Python server entrypoint.');
    } else if (base === 'main.py') {
      score = 136;
      role = 'Primary Python runtime entrypoint';
      evidence.push('Matched Python main entrypoint.');
    } else if (base === 'index.js' || base === 'index.ts' || base === 'main.js' || base === 'main.ts') {
      score = 132;
      role = 'Primary JavaScript/TypeScript runtime entrypoint';
      evidence.push('Matched common runtime entrypoint name.');
    } else if (base === 'app.js' || base === 'app.ts' || base === 'app.jsx' || base === 'app.tsx') {
      score = 128;
      role = 'Application bootstrap entrypoint';
      evidence.push('Matched common application bootstrap file.');
    } else if (base === 'bootstrap.js' || base === 'bootstrap.ts' || base === 'bootstrap.py') {
      score = 126;
      role = 'Runtime bootstrap entrypoint';
      evidence.push('Matched bootstrap entrypoint name.');
    }

    if (!score && isLikelyEntrypoint(normalized)) {
      score = 120;
      role = 'Likely runtime or UI entrypoint';
      evidence.push('Matched generic entrypoint heuristic.');
    }
    if (!score) {
      return null;
    }

    if (normalized.startsWith('src/')) {
      score += 8;
      evidence.push('Located under src/, suggesting a primary implementation surface.');
    }
    if (normalized.startsWith('tools/')) {
      score += /(?:^|\/)(?:server|cli|launcher|runner|peek[_-]server)\b/i.test(normalized) ? 12 : -4;
    }
    if (normalized.startsWith('bin/') || normalized.startsWith('cli/')) {
      score += 10;
    }
    if ((repoSignals?.frameworks || []).includes('.NET') && (base === 'program.cs' || base === 'app.xaml.cs')) {
      score += 10;
    }
    if ((repoSignals?.frameworks || []).includes('Python') && (base === '__main__.py' || base === 'cli.py' || base === 'server.py' || base === 'main.py')) {
      score += 10;
    }
    if ((repoSignals?.archetype || '').includes('polyglot')) {
      score += 6;
    }

    score -= Math.max(0, segments.length - 3) * 4;

    return {
      file: normalized,
      role,
      confidence: score >= 155 ? 'high' : (score >= 128 ? 'medium' : 'low'),
      evidence: uniqueStrings(evidence),
      score,
    };
  }

  function collectInternalDependencies(moduleMap, sourceFiles, availableFiles, limit = 5) {
    return uniquePaths((sourceFiles || [])
      .flatMap((filePath) => moduleMap.get(filePath)?.deps || [])
      .filter((filePath) => availableFiles.has(filePath) && !isTestFile(filePath)))
      .slice(0, limit);
  }

  function isConfigOrContractFile(repoPath) {
    const normalized = toRepoPath(repoPath).toLowerCase();
    if (!normalized) return false;
    if (normalized === 'package.json' || normalized === 'package-lock.json' || normalized === 'tsconfig.json' || normalized === 'jsconfig.json') {
      return true;
    }
    if (/\.(json|ya?ml|toml|ini)$/.test(normalized)) {
      return true;
    }
    return /(^|\/)(config|configs|manifests?|lang|locales?|i18n|schemas?|fixtures)\//.test(normalized);
  }

  function buildGenericFlowDefinitions({ repoMetadata, trackedFiles, modules, entrypoints, hotspots } = {}) {
    const availableFiles = new Set(uniquePaths(trackedFiles));
    const moduleMap = buildModuleEntryMap(modules);
    const hotspotFiles = uniquePaths((hotspots || []).map(item => item.file));
    const entrypointFiles = uniquePaths((entrypoints || []).map(item => item.file));
    const runtimeEntrypoints = uniquePaths([
      toRepoPath(repoMetadata?.package_main),
      ...(repoMetadata?.bin_files || []),
      ...entrypointFiles,
      ...hotspotFiles,
    ]).filter(filePath => availableFiles.has(filePath)).slice(0, 4);
    const runtimeImplementation = collectInternalDependencies(moduleMap, runtimeEntrypoints, availableFiles, 5);

    const configFiles = uniquePaths((trackedFiles || []).filter(isConfigOrContractFile)).slice(0, 5);
    const configConsumers = uniquePaths((modules || [])
      .filter(entry => (entry.deps || []).some(dep => configFiles.includes(dep)))
      .map(entry => entry.file))
      .slice(0, 4);

    const testFiles = uniquePaths((trackedFiles || []).filter(isTestFile)).slice(0, 5);
    const validatedFiles = testFiles.length > 0
      ? uniquePaths((testFiles || [])
        .flatMap((filePath) => moduleMap.get(filePath)?.deps || [])
        .filter(filePath => availableFiles.has(filePath) && !isTestFile(filePath)))
        .slice(0, 5)
      : uniquePaths([...runtimeEntrypoints, ...runtimeImplementation, ...hotspotFiles]).slice(0, 5);
    const validationSurfaces = testFiles.length > 0
      ? testFiles
      : uniquePaths(['package.json', 'package-lock.json', ...(repoMetadata?.bin_files || [])])
        .filter(filePath => availableFiles.has(filePath))
        .slice(0, 4);

    const definitions = [];
    if (runtimeEntrypoints.length > 0 || runtimeImplementation.length > 0) {
      definitions.push({
        id: GENERIC_FLOW_IDS.ENTRY_RUNTIME,
        label: 'Entrypoints and runtime flow',
        summary: 'How a maintainer should enter the repo, then follow the first-hop runtime or UI implementation path.',
        questions: ['Where should a new reader start, and which files carry the main runtime surface deeper into the repo?'],
        evidence_quality: 'heuristic',
        evidence: ['Synthesized from entrypoints, hotspots, and internal dependency hops.'],
        steps: [
          {
            label: 'Entrypoints',
            description: 'Top-level files that expose the main CLI, UI, or runtime surface.',
            files: runtimeEntrypoints,
          },
          {
            label: 'Runtime implementation',
            description: 'First-hop implementation files that the entrypoints immediately delegate into.',
            files: runtimeImplementation,
          },
        ],
      });
    }

    if (configFiles.length > 0 || configConsumers.length > 0) {
      definitions.push({
        id: GENERIC_FLOW_IDS.CONFIG_CONTRACTS,
        label: 'Configuration and contract flow',
        summary: 'How config, manifests, locale packs, schemas, or other structured assets connect back to consuming code.',
        questions: ['Which files define the repo’s data contracts or config surfaces, and which modules consume them?'],
        evidence_quality: 'heuristic',
        evidence: ['Synthesized from config/content files and the modules that import them.'],
        steps: [
          {
            label: 'Source-of-truth files',
            description: 'Config, schema, manifest, or content files that act like contracts.',
            files: configFiles,
          },
          {
            label: 'Consumers',
            description: 'Runtime or tooling modules that read those contracts.',
            files: configConsumers,
          },
        ],
      });
    }

    if (validationSurfaces.length > 0 || validatedFiles.length > 0) {
      definitions.push({
        id: GENERIC_FLOW_IDS.CHANGE_VALIDATION,
        label: 'Change and validation flow',
        summary: 'Which tests, harnesses, or build surfaces should be checked after editing the repo’s riskier seams.',
        questions: ['If you change a key module, which validation surfaces and neighboring files should you inspect first?'],
        evidence_quality: 'heuristic',
        evidence: ['Synthesized from tests, scripts, build surfaces, and protected implementation files.'],
        steps: [
          {
            label: testFiles.length > 0 ? 'Tests and harnesses' : 'Validation surfaces',
            description: testFiles.length > 0
              ? 'Tests and harnesses that appear to cover the nearby implementation seams.'
              : 'Build or package surfaces that are still useful validation starting points when tests are sparse.',
            files: validationSurfaces,
          },
          {
            label: 'Protected implementation',
            description: 'Risky implementation files or hotspots that those validation surfaces should cover.',
            files: validatedFiles,
          },
        ],
      });
    }

    return definitions;
  }

  function buildFlowSummaries({ repoMetadata, trackedFiles, modules, entrypoints, hotspots, subsystemLookup, activeProfile }) {
    const profileFlowDefinitions = Array.isArray(activeProfile?.flow_definitions) ? activeProfile.flow_definitions : [];
    const syntheticDefinitions = activeProfile?.id === 'generic-javascript-repo' || activeProfile?.base_profile_id === 'generic-javascript-repo'
      ? buildGenericFlowDefinitions({ repoMetadata, trackedFiles, modules, entrypoints, hotspots })
      : [];
    const definitions = [];
    const seen = new Set();
    for (const definition of [...profileFlowDefinitions, ...syntheticDefinitions]) {
      const id = typeof definition?.id === 'string' ? definition.id.trim() : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      definitions.push(definition);
    }
    const availableFiles = new Set(uniquePaths(trackedFiles));

    return definitions.map((definition) => {
      const steps = definition.steps
        .map((step) => ({
          label: step.label,
          description: step.description,
          files: uniquePaths(step.files.filter(filePath => availableFiles.has(filePath))),
        }))
        .filter(step => step.files.length > 0);
      if (steps.length === 0) return null;
      const files = uniquePaths(steps.flatMap(step => step.files));
      return {
        id: definition.id,
        label: definition.label,
        summary: definition.summary,
        questions_it_answers: uniqueStrings(definition.questions || []),
        confidence: definition.evidence_quality === 'profile-defined' ? 'high' : 'medium',
        evidence_quality: definition.evidence_quality || (definition.steps.length >= 3 ? 'direct' : 'heuristic'),
        evidence: uniqueStrings(definition.evidence || []),
        files,
        subsystems: uniqueStrings(files.map(filePath => (subsystemLookup.get(filePath) || getSubsystemForFile(filePath, activeProfile)).label)),
        steps,
      };
    }).filter(Boolean);
  }

  function buildEntrypoints(repoMetadata, availableFiles, hotspots, modules, subsystemLookup, activeProfile, repoSignals = null) {
    const moduleMap = buildModuleEntryMap(modules);
    const reverseDeps = buildReverseDependencyMap(modules);
    const hotspotFiles = new Set((hotspots || []).map(item => toRepoPath(item.file)).filter(Boolean));
    const rankedCandidates = uniquePaths(Array.from(availableFiles))
      .map((filePath) => {
        const candidate = inferGenericEntrypointCandidate(filePath, repoMetadata, repoSignals);
        if (!candidate) return null;
        const corePath = getEntrypointCorePathBoost(filePath, moduleMap, hotspotFiles, reverseDeps);
        const score = candidate.score + corePath.boost;
        return {
          ...candidate,
          score,
          confidence: score >= 155 ? 'high' : (score >= 128 ? 'medium' : 'low'),
          evidence: uniqueStrings([...(candidate.evidence || []), ...(corePath.evidence || [])]),
        };
      })
      .filter(Boolean)
      .sort((left, right) => right.score - left.score || left.file.localeCompare(right.file));

    const entrypoints = [];
    const seen = new Set();
    const entrypointLimit = (repoSignals?.frameworks || []).some((framework) => framework === '.NET' || framework === 'Python')
      || String(repoSignals?.archetype || '').includes('polyglot')
      ? 8
      : 6;

    for (const candidate of rankedCandidates) {
      if (entrypoints.length >= entrypointLimit) break;
      const filePath = toRepoPath(candidate.file);
      if (!filePath || seen.has(filePath) || !availableFiles.has(filePath)) continue;
      seen.add(filePath);
      const subsystem = subsystemLookup.get(filePath) || getSubsystemForFile(filePath, activeProfile);
      entrypoints.push({
        file: filePath,
        role: candidate.role,
        subsystem: subsystem.label,
        signal_type: isStructuredContentFile(filePath) ? 'content' : (isExecutableSurfaceFile(filePath) ? 'runtime' : 'module'),
        confidence: candidate.confidence || 'medium',
        evidence: uniqueStrings(candidate.evidence || []),
      });
    }

    const hotspotFallbacks = selectDiverseHotspots([
      ...(hotspots || []).filter(item => !isConfigOrContractFile(item.file) && SYMBOL_INDEX_EXTENSIONS.has(path.extname(item.file).toLowerCase())),
      ...(hotspots || []).filter(item => !isConfigOrContractFile(item.file)),
      ...(hotspots || []),
    ], entrypointLimit);

    for (const hotspot of hotspotFallbacks) {
      if (entrypoints.length >= entrypointLimit) break;
      if (seen.has(hotspot.file)) continue;
      seen.add(hotspot.file);
      entrypoints.push({
        file: hotspot.file,
        role: 'High-signal hotspot to orient on the repo quickly',
        subsystem: hotspot.subsystem_label,
        signal_type: hotspot.signal_type || 'module',
        confidence: hotspot.confidence === 'high' ? 'medium' : (hotspot.confidence || 'low'),
        evidence: uniqueStrings([
          'Selected from high-signal hotspot ranking.',
          hotspot.evidence?.structured_content ? 'Structured content weighting applied.' : '',
          hotspot.evidence?.executable_surface ? 'Executable surface weighting applied.' : '',
        ]),
      });
    }

    return entrypoints;
  }

  return {
    buildGenericFlowDefinitions,
    buildFlowSummaries,
    buildEntrypoints,
    inferGenericEntrypointCandidate,
    isLikelyEntrypoint,
    isConfigOrContractFile,
    collectInternalDependencies,
  };
}

module.exports = { createFlowDefinitions };
