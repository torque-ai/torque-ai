'use strict';

const fs = require('fs');
const path = require('path');

const STUDY_DIR = path.join('docs', 'architecture');
const STUDY_STATE_FILE = path.join(STUDY_DIR, 'study-state.json');
const MODULE_INDEX_FILE = path.join(STUDY_DIR, 'module-index.json');
const KNOWLEDGE_PACK_FILE = path.join(STUDY_DIR, 'knowledge-pack.json');
const STUDY_DELTA_FILE = path.join(STUDY_DIR, 'study-delta.json');
const STUDY_EVALUATION_FILE = path.join(STUDY_DIR, 'study-evaluation.json');
const STUDY_BENCHMARK_FILE = path.join(STUDY_DIR, 'study-benchmark.json');
const SUMMARY_FILE = path.join(STUDY_DIR, 'SUMMARY.md');

const SIGNIFICANCE_ORDER = ['none', 'baseline', 'low', 'moderate', 'high', 'critical'];
const DEFAULT_PROPOSAL_SIGNIFICANCE_LEVEL = 'moderate';
const DEFAULT_PROPOSAL_MIN_SCORE = 0;
const MAX_EXISTING_PROPOSAL_SCAN = 500;
const EVALUATION_VERSION = 1;
const EVALUATION_PROBE_LIMIT = 12;
const BENCHMARK_VERSION = 1;
const DEFAULT_BOOTSTRAP_CRON = '*/15 * * * *';
const DEFAULT_BOOTSTRAP_BATCHES = 5;
const MAX_STUDY_CONTEXT_ITEMS = 3;
const TASK_STUDY_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'app',
  'build',
  'change',
  'code',
  'edit',
  'feature',
  'file',
  'fix',
  'for',
  'from',
  'help',
  'implement',
  'in',
  'into',
  'js',
  'json',
  'module',
  'of',
  'on',
  'or',
  'repo',
  'task',
  'tests',
  'the',
  'this',
  'to',
  'torque',
  'ts',
  'tsx',
  'update',
  'with',
]);

function toRepoPath(value) {
  return String(value || '').trim().replace(/\\/g, '/');
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

function truncateText(value, maxLength = 240) {
  const normalized = String(value || '').trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return '';
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function tokenizeText(value) {
  return String(value || '')
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9_-]*/g) || [];
}

function uniqueTokens(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function buildTokenSet(values) {
  return new Set(uniqueTokens(values));
}

function extractMentionedRepoPaths(taskDescription) {
  const matches = String(taskDescription || '')
    .match(/[\w./\\-]+\.(?:[a-z0-9]{1,6})/gi) || [];
  return uniquePaths(matches.map((match) => match.replace(/\\/g, '/')));
}

function normalizeTaskStudyFiles(files, workingDirectory) {
  const root = path.resolve(String(workingDirectory || '').trim());
  return uniquePaths((Array.isArray(files) ? files : []).map((value) => {
    const normalized = String(value || '').trim();
    if (!normalized) {
      return '';
    }

    if (path.isAbsolute(normalized)) {
      const absolutePath = path.resolve(normalized);
      const relativePath = path.relative(root, absolutePath);
      if (!relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
        return toRepoPath(relativePath);
      }
      return toRepoPath(normalized);
    }

    return toRepoPath(normalized);
  }));
}

function collectPathTokens(filePath) {
  const tokens = [];
  for (const segment of toRepoPath(filePath).split(/[/.\\_-]+/)) {
    const normalized = segment.trim().toLowerCase();
    if (!normalized || TASK_STUDY_STOP_WORDS.has(normalized) || normalized.length < 3) {
      continue;
    }
    tokens.push(normalized);
  }
  return tokens;
}

function buildPromptTokenSet(taskDescription, targetFiles) {
  const tokens = [
    ...tokenizeText(taskDescription).filter((token) => token.length >= 3 && !TASK_STUDY_STOP_WORDS.has(token)),
    ...targetFiles.flatMap((filePath) => collectPathTokens(filePath)),
  ];
  return buildTokenSet(tokens);
}

function collectKnowledgePackFiles(knowledgePack) {
  const fileSet = new Set();
  const addFiles = (values) => {
    uniquePaths(values).forEach((filePath) => fileSet.add(filePath));
  };

  addFiles((knowledgePack?.entrypoints || []).map((entry) => entry?.file));
  addFiles((knowledgePack?.hotspots || []).map((item) => item?.file));

  for (const subsystem of Array.isArray(knowledgePack?.subsystems) ? knowledgePack.subsystems : []) {
    addFiles(subsystem?.files || subsystem?.key_files || subsystem?.evidence_files || []);
  }
  for (const relationship of Array.isArray(knowledgePack?.subsystem_relationships) ? knowledgePack.subsystem_relationships : []) {
    addFiles(extractRelationshipEvidenceFiles(relationship));
  }
  for (const flow of Array.isArray(knowledgePack?.flows) ? knowledgePack.flows : []) {
    addFiles(flow?.files || []);
    for (const step of Array.isArray(flow?.steps) ? flow.steps : []) {
      addFiles(step?.files || []);
    }
  }
  for (const invariant of Array.isArray(knowledgePack?.expertise?.invariants) ? knowledgePack.expertise.invariants : []) {
    addFiles(collectInvariantEvidenceFiles(invariant));
  }
  for (const playbook of Array.isArray(knowledgePack?.expertise?.change_playbooks) ? knowledgePack.expertise.change_playbooks : []) {
    addFiles(collectPlaybookEvidenceFiles(playbook));
  }
  for (const impact of Array.isArray(knowledgePack?.expertise?.impact_guidance) ? knowledgePack.expertise.impact_guidance : []) {
    addFiles(impact?.related_files || []);
    addFiles(impact?.related_tests || impact?.tests || []);
  }
  for (const testArea of Array.isArray(knowledgePack?.expertise?.test_matrix) ? knowledgePack.expertise.test_matrix : []) {
    addFiles(testArea?.tests || []);
  }
  for (const hint of Array.isArray(knowledgePack?.navigation_hints) ? knowledgePack.navigation_hints : []) {
    addFiles(hint?.read_first || []);
  }

  return fileSet;
}

function extractRelationshipEvidenceFiles(relationship) {
  const exampleFiles = (Array.isArray(relationship?.example_edges) ? relationship.example_edges : [])
    .flatMap((edge) => String(edge || '').split(/\s*->\s*/).map((part) => part.trim()))
    .filter(Boolean);
  return uniquePaths([
    ...(relationship?.evidence_files || []),
    ...exampleFiles,
  ]);
}

function collectInvariantEvidenceFiles(invariant) {
  return uniquePaths([
    ...(invariant?.evidence_files || []),
    ...(invariant?.related_files || []),
    ...(invariant?.related_tests || []),
  ]);
}

function collectPlaybookEvidenceFiles(playbook) {
  return uniquePaths([
    ...(playbook?.read_first || []),
    ...(playbook?.inspect_also || []),
    ...(playbook?.edit_surface || []),
    ...(playbook?.related_files || []),
    ...(playbook?.related_tests || []),
  ]);
}

function scoreStudyItem(item, options = {}) {
  const targetFiles = new Set(uniquePaths(options.targetFiles || []));
  const targetBasenames = new Set(Array.from(targetFiles).map((filePath) => path.basename(filePath).toLowerCase()));
  const promptTokens = options.promptTokens instanceof Set ? options.promptTokens : new Set();
  const candidateFiles = uniquePaths(options.files || []);
  const candidateTokenSet = buildTokenSet([
    ...tokenizeText((options.textParts || []).join(' ')),
    ...candidateFiles.flatMap((filePath) => collectPathTokens(filePath)),
  ]);

  const matchedFiles = candidateFiles.filter((filePath) => {
    const normalized = toRepoPath(filePath);
    if (targetFiles.has(normalized)) {
      return true;
    }
    const basename = path.basename(normalized).toLowerCase();
    return basename && targetBasenames.has(basename);
  });
  const matchedTokens = Array.from(candidateTokenSet).filter((token) => promptTokens.has(token));

  let score = 0;
  score += matchedFiles.length * 9;
  score += matchedTokens.length * 2;
  if (options.bias) {
    score += options.bias;
  }

  return {
    item,
    score,
    matched_files: uniquePaths(matchedFiles),
    matched_tokens: uniqueStrings(matchedTokens).slice(0, 4),
  };
}

function buildStudyMatchReason(entry, fallback) {
  if (entry.matched_files.length > 0) {
    return `Matched files ${entry.matched_files.slice(0, 3).map((filePath) => `\`${filePath}\``).join(', ')}.`;
  }
  if (entry.matched_tokens.length > 0) {
    return `Matched task terms ${entry.matched_tokens.map((token) => `\`${token}\``).join(', ')}.`;
  }
  return fallback;
}

function rankStudyItems(items, options = {}) {
  const scored = [];
  for (const item of Array.isArray(items) ? items : []) {
    const entry = scoreStudyItem(item, {
      targetFiles: options.targetFiles,
      promptTokens: options.promptTokens,
      files: options.getFiles ? options.getFiles(item) : [],
      textParts: options.getTextParts ? options.getTextParts(item) : [],
      bias: options.getBias ? options.getBias(item) : 0,
    });
    if (entry.score > 0) {
      scored.push(entry);
    }
  }

  scored.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    const leftLabel = String(left.item?.label || left.item?.id || '');
    const rightLabel = String(right.item?.label || right.item?.id || '');
    return leftLabel.localeCompare(rightLabel);
  });

  if (scored.length > 0) {
    return scored.slice(0, options.limit || MAX_STUDY_CONTEXT_ITEMS);
  }

  const fallbackLimit = options.fallbackLimit || Math.min(MAX_STUDY_CONTEXT_ITEMS, Array.isArray(items) ? items.length : 0);
  return (Array.isArray(items) ? items : []).slice(0, fallbackLimit).map((item) => ({
    item,
    score: 0,
    matched_files: [],
    matched_tokens: [],
  }));
}

function flattenFlowFiles(flow) {
  const stepFiles = (Array.isArray(flow?.steps) ? flow.steps : []).flatMap((step) => step?.files || []);
  return uniquePaths([...(flow?.files || []), ...stepFiles]);
}

function isRepoBriefingPrompt(taskDescription) {
  const normalized = String(taskDescription || '').trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  if (
    normalized.includes('repo briefing')
    || normalized.includes('repository briefing')
    || normalized.includes('fast repo map')
  ) {
    return true;
  }

  let signalCount = 0;
  if (normalized.includes('primary runtime entrypoint')) signalCount += 1;
  if (normalized.includes('secondary important entrypoint') || normalized.includes('secondary entrypoint')) signalCount += 1;
  if (normalized.includes('high-risk subsystem') || normalized.includes('hotspot')) signalCount += 1;
  if (normalized.includes('validation command')) signalCount += 1;
  if (normalized.includes('read-only')) signalCount += 1;
  return signalCount >= 2;
}

function isLowSignalRepoBriefingLabel(label) {
  const normalized = String(label || '').trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    normalized.includes('validation and tests')
    || normalized.includes('documentation')
    || normalized.includes('docs')
    || normalized.includes('config')
    || normalized.includes('manifest')
    || normalized.includes('fixtures')
    || normalized.includes('examples')
    || normalized === 'project root and shared config'
    || /^(?:src|source|tools?|ops|samples?|docs?|tests?|fixtures?|schemas?|config|\.config|screenshots?) area$/.test(normalized)
  );
}

function isLowSignalRepoBriefingFile(filePath) {
  const normalized = toRepoPath(filePath).toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    /(^|\/)(__tests__|tests?|specs?)(\/|$)/.test(normalized)
    || /(^|\/)(docs?|examples?|fixtures?|schemas?|config|configs?|manifests?)(\/|$)/.test(normalized)
    || /\.(json|ya?ml|toml|ini|md)$/.test(normalized)
  );
}

function countHighSignalRepoBriefingFiles(filePaths) {
  return uniquePaths(filePaths || []).filter((filePath) => !isLowSignalRepoBriefingFile(filePath)).length;
}

function isLowSignalRepoBriefingChangeGuidanceEntry(entry) {
  const item = entry?.item || entry || {};
  const relatedFiles = uniquePaths(item?.related_files || []);
  const highSignalFileCount = countHighSignalRepoBriefingFiles(relatedFiles);
  if (isLowSignalRepoBriefingLabel(item?.label || item?.id)) {
    return true;
  }
  if (highSignalFileCount === 0) {
    return true;
  }
  return highSignalFileCount <= 1 && relatedFiles.length > highSignalFileCount;
}

function isWeakRepoBriefingHotspotEntry(entry, entrypointFiles = new Set()) {
  const item = entry?.item || entry || {};
  const filePath = toRepoPath(item?.file);
  const reason = String(item?.reason || '').trim().toLowerCase();
  if (!filePath || isLowSignalRepoBriefingFile(filePath)) {
    return true;
  }
  return entrypointFiles.has(filePath)
    && reason.startsWith('representative file in ')
    && item?.confidence !== 'high';
}

function collectStudyValidationCommands(knowledgePack) {
  return uniqueStrings([
    ...(Array.isArray(knowledgePack?.expertise?.change_playbooks)
      ? knowledgePack.expertise.change_playbooks.flatMap((item) => item?.validation_commands || [])
      : []),
    ...(Array.isArray(knowledgePack?.expertise?.impact_guidance)
      ? knowledgePack.expertise.impact_guidance.flatMap((item) => item?.validation_commands || [])
      : []),
    ...(Array.isArray(knowledgePack?.expertise?.test_matrix)
      ? knowledgePack.expertise.test_matrix.flatMap((item) => item?.validation_commands || [])
      : []),
  ]);
}

function scoreRepoBriefingValidationCommand(command) {
  const normalized = String(command || '').trim().toLowerCase();
  if (!normalized) {
    return Number.NEGATIVE_INFINITY;
  }

  let score = 0;
  if (/^(?:pwsh|powershell|bash|sh|npm run|pnpm |yarn |make |just )/.test(normalized)) {
    score += 5;
  }
  if (/(?:^|[\s"'`])scripts\//.test(normalized) || /\.(?:ps1|sh)\b/.test(normalized)) {
    score += 6;
  }
  if (/\bbuild\b/.test(normalized) || /\bverify\b/.test(normalized) || /\bcheck\b/.test(normalized)) {
    score += 4;
  }
  if (/\btest\b/.test(normalized) || /\bpytest\b/.test(normalized) || /\bvitest\b/.test(normalized)) {
    score += 1;
  }
  if (/--no-build\b/.test(normalized)) {
    score -= 2;
  }
  if (normalized === 'pytest') {
    score -= 2;
  }

  return score;
}

function selectRepoBriefingValidationCommands(commands, limit = 2) {
  return uniqueStrings(commands)
    .map((command) => ({
      command,
      score: scoreRepoBriefingValidationCommand(command),
    }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => right.score - left.score || left.command.localeCompare(right.command))
    .slice(0, Math.max(1, limit))
    .map((entry) => entry.command);
}

function intersectPaths(leftValues, rightValues) {
  const right = new Set(uniquePaths(rightValues));
  return uniquePaths(leftValues).filter((value) => right.has(value));
}

function intersectStrings(leftValues, rightValues) {
  const right = new Set(uniqueStrings(rightValues).map((value) => value.toLowerCase()));
  return uniqueStrings(leftValues).filter((value) => right.has(String(value || '').toLowerCase()));
}

function buildRepoBriefingProbe(knowledgePack, repoName) {
  const expectedEntrypoints = uniquePaths((knowledgePack?.entrypoints || []).slice(0, 2).map((item) => item?.file));
  const expectedHotspots = uniquePaths((knowledgePack?.hotspots || []).slice(0, 2).map((item) => item?.file));
  const expectedValidationCommands = selectRepoBriefingValidationCommands(
    collectStudyValidationCommands(knowledgePack),
    2
  );
  if (expectedEntrypoints.length === 0 && expectedHotspots.length === 0) {
    return null;
  }

  return {
    id: 'repo-briefing:onramp',
    scope_type: 'repo_briefing',
    scope_id: 'repo-briefing',
    expected_entrypoints: expectedEntrypoints,
    expected_hotspots: expectedHotspots,
    expected_validation_commands: expectedValidationCommands,
    ...buildProbe(
      [
        `Read-only repo briefing for ${repoName}. Return exactly 4 bullets and keep it under 140 words.`,
        '1. Primary runtime entrypoint.',
        '2. Secondary important entrypoint or startup surface.',
        '3. One high-risk subsystem or hotspot worth understanding first.',
        '4. One validation command worth running first.',
      ].join(' '),
      [...expectedEntrypoints, ...expectedHotspots],
      [
        ...(knowledgePack?.subsystems || []).slice(0, 2).map((item) => item?.label),
        ...expectedValidationCommands,
      ]
    ),
  };
}

function buildRepoBriefingPromptAlignment(probe, workingDirectory) {
  const normalizedWorkingDirectory = String(workingDirectory || '').trim();
  if (!normalizedWorkingDirectory) {
    return null;
  }
  const knowledgePackPath = path.join(path.resolve(normalizedWorkingDirectory), KNOWLEDGE_PACK_FILE);
  if (!fs.existsSync(knowledgePackPath)) {
    return null;
  }

  const envelope = buildTaskStudyContextEnvelope({
    workingDirectory: normalizedWorkingDirectory,
    taskDescription: probe.prompt,
  });
  if (!envelope?.study_context_summary) {
    return {
      score: 0,
      selected_entrypoints: [],
      selected_hotspots: [],
      selected_validation_commands: [],
      matched_entrypoints: [],
      matched_hotspots: [],
      matched_validation_commands: [],
    };
  }

  const selectedEntrypoints = uniquePaths(envelope.study_context_summary.entrypoint_files || []);
  const selectedHotspots = uniquePaths(envelope.study_context_summary.hotspot_files || []);
  const selectedValidationCommands = uniqueStrings(envelope.study_context_summary.validation_commands || []);
  const matchedEntrypoints = intersectPaths(probe.expected_entrypoints || [], selectedEntrypoints);
  const matchedHotspots = intersectPaths(probe.expected_hotspots || [], selectedHotspots);
  const matchedValidationCommands = intersectStrings(probe.expected_validation_commands || [], selectedValidationCommands);

  const entrypointRatio = (probe.expected_entrypoints || []).length > 0
    ? matchedEntrypoints.length / probe.expected_entrypoints.length
    : 1;
  const hotspotRatio = (probe.expected_hotspots || []).length > 0
    ? matchedHotspots.length / probe.expected_hotspots.length
    : 1;
  const validationRatio = (probe.expected_validation_commands || []).length > 0
    ? matchedValidationCommands.length / probe.expected_validation_commands.length
    : 1;
  const score = Math.round(((entrypointRatio * 0.5) + (hotspotRatio * 0.3) + (validationRatio * 0.2)) * 100);

  return {
    score,
    selected_entrypoints: selectedEntrypoints,
    selected_hotspots: selectedHotspots,
    selected_validation_commands: selectedValidationCommands,
    matched_entrypoints: matchedEntrypoints,
    matched_hotspots: matchedHotspots,
    matched_validation_commands: matchedValidationCommands,
  };
}

function buildRepoBriefingFallbackChangeGuidance({
  relevantEntrypoints,
  relevantHotspots,
  validationCommands,
  maxItems,
}) {
  const relatedFiles = uniquePaths([
    ...(Array.isArray(relevantHotspots) ? relevantHotspots.map((item) => item?.file) : []),
    ...(Array.isArray(relevantEntrypoints) ? relevantEntrypoints.map((item) => item?.file) : []),
  ])
    .filter((filePath) => !isLowSignalRepoBriefingFile(filePath))
    .slice(0, Math.max(1, maxItems));
  const commands = uniqueStrings(validationCommands || []).slice(0, 2);
  if (relatedFiles.length === 0 && commands.length === 0) {
    return [];
  }
  return [{
    id: 'repo-briefing-runtime-seams',
    label: 'Runtime seams',
    related_files: relatedFiles,
    validation_commands: commands,
  }];
}

function getEntrypointRuntimeFamily(filePath) {
  const normalized = toRepoPath(filePath).toLowerCase();
  const extension = path.extname(normalized);

  if (['.cs', '.vb', '.fs', '.xaml'].includes(extension)) return 'dotnet';
  if (extension === '.py') return 'python';
  if (['.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx'].includes(extension)) return 'node';
  if (extension === '.go') return 'go';
  if (extension === '.rs') return 'rust';
  if (extension === '.java' || extension === '.kt') return 'jvm';
  if (extension === '.rb') return 'ruby';
  if (extension === '.php') return 'php';
  return extension ? extension.slice(1) : 'other';
}

function getRepoBriefingEntrypointBias(item) {
  const filePath = toRepoPath(item?.file).toLowerCase();
  const role = String(item?.role || '').toLowerCase();
  const basename = path.basename(filePath);
  const segments = filePath.split('/').filter(Boolean);
  let bias = 0;

  if (/^(program|main)\./.test(basename) || basename === 'app.xaml.cs' || /^cli\./.test(basename)) {
    bias += 4;
  }
  if (/(^|\/)(cli|app|apps|dashboard|desktop|server|service|web)(\/|$)/.test(filePath)) {
    bias += 2;
  }
  if (/\b(cli|command|dashboard|desktop|ui|web|server|service|startup|entrypoint)\b/.test(role)) {
    bias += 2;
  }
  if (/^index\.(js|cjs|mjs|ts|tsx|jsx|py)$/.test(basename) && segments.length > 2) {
    bias -= 4;
  }
  if (isLowSignalRepoBriefingFile(filePath)) {
    bias -= 6;
  }

  return bias;
}

function selectRepoBriefingRankedEntries(entries, limit, isLowSignalEntry) {
  const rankedEntries = Array.isArray(entries) ? entries : [];
  if (rankedEntries.length <= limit) {
    return rankedEntries.slice(0, limit);
  }

  const preferred = rankedEntries.filter((entry) => !isLowSignalEntry(entry));
  const source = preferred.length > 0 ? preferred : rankedEntries;
  return source.slice(0, limit);
}

function selectRepoBriefingEntrypoints(entries, limit) {
  const rankedEntries = Array.isArray(entries) ? entries : [];
  if (rankedEntries.length <= limit) {
    return rankedEntries.slice(0, limit);
  }

  const families = uniqueStrings(rankedEntries.map((entry) => getEntrypointRuntimeFamily(entry?.item?.file)).filter(Boolean));
  if (families.length <= 1) {
    return rankedEntries.slice(0, limit);
  }

  const selected = [];
  const seenFiles = new Set();
  const seenFamilies = new Set();

  for (const entry of rankedEntries) {
    if (selected.length >= limit) {
      break;
    }
    const filePath = toRepoPath(entry?.item?.file);
    const family = getEntrypointRuntimeFamily(filePath);
    if (!filePath || seenFiles.has(filePath) || !family || seenFamilies.has(family)) {
      continue;
    }
    selected.push(entry);
    seenFiles.add(filePath);
    seenFamilies.add(family);
  }

  for (const entry of rankedEntries) {
    if (selected.length >= limit) {
      break;
    }
    const filePath = toRepoPath(entry?.item?.file);
    if (!filePath || seenFiles.has(filePath)) {
      continue;
    }
    selected.push(entry);
    seenFiles.add(filePath);
  }

  return selected;
}

const REPO_BRIEFING_GENERIC_DIRS = new Set([
  'src',
  'source',
  'lib',
  'libs',
  'app',
  'apps',
  'package',
  'packages',
  'module',
  'modules',
  'tool',
  'tools',
  'client',
  'clients',
  'server',
  'servers',
]);

function buildRepoBriefingFocusKey(filePath) {
  const normalized = toRepoPath(filePath);
  if (!normalized) {
    return '';
  }

  const segments = normalized.split('/').filter(Boolean);
  let dirSegments = segments.slice(0, -1);
  while (dirSegments.length > 1 && REPO_BRIEFING_GENERIC_DIRS.has(String(dirSegments[0] || '').toLowerCase())) {
    dirSegments = dirSegments.slice(1);
  }

  if (dirSegments.length === 0) {
    return path.basename(normalized, path.extname(normalized));
  }
  if (dirSegments.length === 1) {
    return dirSegments[0];
  }
  return dirSegments.slice(0, 2).join('/');
}

function formatRepoBriefingFocusOverview(sourceTypes, files) {
  const normalizedSourceTypes = Array.from(sourceTypes || []).filter(Boolean);
  const sourceSummary = normalizedSourceTypes.length > 1
    ? `${normalizedSourceTypes.slice(0, 2).join(' and ')} seams`
    : `${normalizedSourceTypes[0] || 'runtime'} seam`;
  return `Focused briefing area synthesized from ${sourceSummary}. Start with ${uniquePaths(files || []).slice(0, 3).map((filePath) => `\`${filePath}\``).join(', ')}.`;
}

function buildRepoBriefingFocusAreas({ relevantEntrypoints, relevantHotspots, relevantFlows, maxItems }) {
  const areaMap = new Map();
  const addAreaFile = (filePath, sourceType, weight) => {
    const normalized = toRepoPath(filePath);
    if (!normalized || isLowSignalRepoBriefingFile(normalized)) {
      return;
    }

    const focusKey = buildRepoBriefingFocusKey(normalized);
    if (!focusKey) {
      return;
    }

    const existing = areaMap.get(focusKey) || {
      id: `focus:${focusKey}`,
      label: focusKey,
      files: new Set(),
      sourceTypes: new Set(),
      score: 0,
    };

    existing.files.add(normalized);
    existing.sourceTypes.add(sourceType);
    existing.score += weight;
    areaMap.set(focusKey, existing);
  };

  (Array.isArray(relevantEntrypoints) ? relevantEntrypoints : []).forEach((item) => addAreaFile(item?.file, 'entrypoint', 4));
  (Array.isArray(relevantHotspots) ? relevantHotspots : []).forEach((item) => addAreaFile(item?.file, 'hotspot', 5));
  (Array.isArray(relevantFlows) ? relevantFlows : []).forEach((flow) => {
    uniquePaths(flow?.files || []).slice(0, 3).forEach((filePath) => addAreaFile(filePath, 'flow', 1));
  });

  return Array.from(areaMap.values())
    .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label))
    .slice(0, maxItems)
    .map((item) => {
      const files = Array.from(item.files);
      return {
        id: item.id,
        label: item.label,
        overview: truncateText(formatRepoBriefingFocusOverview(item.sourceTypes, files), 180),
        key_files: files.slice(0, Math.max(1, maxItems)),
        reason: `Selected as a repo-briefing focus area from ${Array.from(item.sourceTypes).join(' and ')} signals.`,
      };
    });
}

function buildTaskStudyContextPrompt(studyContext) {
  if (!studyContext || typeof studyContext !== 'object') {
    return '';
  }

  const lines = [
    '### Study Intelligence',
    `${studyContext.repo_name || 'Repository'} is currently rated ${studyContext.readiness || 'unknown'} (${studyContext.grade || 'n/a'}, score ${studyContext.score ?? 0}). Use this as a fast repo map and validate final edits against source.`,
  ];

  const pushSection = (title, values, formatter) => {
    if (!Array.isArray(values) || values.length === 0) {
      return;
    }
    lines.push('', title);
    values.slice(0, MAX_STUDY_CONTEXT_ITEMS).forEach((value) => {
      const rendered = formatter(value);
      if (rendered) {
        lines.push(rendered);
      }
    });
  };

  pushSection('Relevant Entrypoints', studyContext.relevant_entrypoints, (item) => (
    `- \`${item.file}\`: ${truncateText(item.role, 150)} ${item.reason}`.trim()
  ));
  pushSection('Relevant Hotspots', studyContext.relevant_hotspots, (item) => (
    `- \`${item.file}\`: ${truncateText(item.summary, 180)} ${item.reason}`.trim()
  ));
  pushSection('Relevant Subsystems', studyContext.relevant_subsystems, (item) => (
    `- ${item.label}: ${truncateText(item.overview || item.description, 180)} Read ${item.key_files.map((filePath) => `\`${filePath}\``).join(', ')}. ${item.reason}`.trim()
  ));
  pushSection('Relevant Flows', studyContext.relevant_flows, (item) => (
    `- ${item.label}: ${truncateText(item.summary, 180)} Start with ${item.files.map((filePath) => `\`${filePath}\``).join(', ')}. ${item.reason}`.trim()
  ));
  pushSection('Key Invariants', studyContext.invariants, (item) => (
    `- ${item.label}: ${truncateText(item.statement, 190)} Evidence: ${item.evidence_files.map((filePath) => `\`${filePath}\``).join(', ')}.`
  ));
  pushSection('Change Guidance', studyContext.change_guidance, (item) => (
    `- ${item.label}: Recheck ${item.related_files.map((filePath) => `\`${filePath}\``).join(', ')}. Validate with ${item.validation_commands.map((command) => `\`${command}\``).join(', ')}.`
  ));
  pushSection('Representative Tests', studyContext.representative_tests, (item) => (
    `- ${item.label}: ${item.tests.map((filePath) => `\`${filePath}\``).join(', ')}. ${truncateText(item.rationale, 160)}`
  ));

  if (studyContext.latest_delta?.level && studyContext.latest_delta.level !== 'none') {
    lines.push(
      '',
      `Latest delta: ${studyContext.latest_delta.level} (${studyContext.latest_delta.score ?? 0}). ${studyContext.latest_delta.reasons.join(' ')}`
    );
  }

  return `${lines.join('\n')}\n`;
}

function buildTaskStudyContextEnvelope({ workingDirectory, taskDescription, files, maxItems = MAX_STUDY_CONTEXT_ITEMS } = {}) {
  const normalizedWorkingDirectory = String(workingDirectory || '').trim();
  if (!normalizedWorkingDirectory) {
    return null;
  }

  const artifacts = readStudyArtifacts(normalizedWorkingDirectory, {
    includeKnowledgePack: true,
    includeDelta: true,
    includeEvaluation: true,
    includeBenchmark: true,
  });
  const knowledgePack = artifacts.knowledgePack;
  if (!knowledgePack || !knowledgePack.generated_at) {
    return null;
  }

  const targetFiles = normalizeTaskStudyFiles([
    ...normalizeTaskStudyFiles(files, normalizedWorkingDirectory),
    ...extractMentionedRepoPaths(taskDescription),
  ], normalizedWorkingDirectory);
  const promptTokens = buildPromptTokenSet(taskDescription, targetFiles);
  const repoBriefing = isRepoBriefingPrompt(taskDescription);
  const entrypointCandidates = rankStudyItems(knowledgePack.entrypoints, {
    targetFiles,
    promptTokens,
    limit: repoBriefing
      ? Math.max(Math.min(Array.isArray(knowledgePack.entrypoints) ? knowledgePack.entrypoints.length : 0, 6), Math.min(2, maxItems))
      : Math.min(2, maxItems),
    fallbackLimit: repoBriefing ? Math.min(4, maxItems + 1) : Math.min(2, maxItems),
    getFiles: (item) => [item?.file],
    getTextParts: (item) => [item?.file, item?.role, item?.subsystem, ...(item?.evidence || [])],
    getBias: (item) => (
      (item?.confidence === 'high' ? 3 : (item?.confidence === 'medium' ? 1 : 0))
      + (repoBriefing ? getRepoBriefingEntrypointBias(item) : 0)
    ),
  });
  const relevantEntrypoints = (repoBriefing
    ? selectRepoBriefingEntrypoints(entrypointCandidates, Math.min(2, maxItems))
    : entrypointCandidates.slice(0, Math.min(2, maxItems)))
    .map((entry) => ({
    file: entry.item.file,
    role: truncateText(entry.item.role, 150),
    reason: buildStudyMatchReason(entry, 'Selected as a high-signal runtime or UI entrypoint.'),
  }));

  const hotspotCandidates = rankStudyItems(knowledgePack.hotspots, {
    targetFiles,
    promptTokens,
    limit: repoBriefing
      ? Math.max(Math.min(Array.isArray(knowledgePack.hotspots) ? knowledgePack.hotspots.length : 0, 6), Math.min(2, maxItems))
      : Math.min(2, maxItems),
    fallbackLimit: Math.min(2, maxItems),
    getFiles: (item) => [item?.file],
    getTextParts: (item) => [item?.file, item?.subsystem_label, item?.reason, item?.signal_type],
    getBias: (item) => {
      let bias = item?.confidence === 'high' ? 3 : (item?.confidence === 'medium' ? 1 : 0);
      if (item?.signal_type === 'runtime') bias += 4;
      if (item?.signal_type === 'module') bias += 1;
      if (item?.signal_type === 'content') bias -= 2;
      if (item?.evidence?.executable_surface) bias += 3;
      if (repoBriefing && isLowSignalRepoBriefingFile(item?.file)) bias -= 8;
      return bias;
    },
  });
  const repoBriefingEntrypointFiles = new Set(relevantEntrypoints.map((item) => toRepoPath(item.file)).filter(Boolean));
  const selectedHotspotEntries = repoBriefing
    ? hotspotCandidates
      .filter((entry) => !isWeakRepoBriefingHotspotEntry(entry, repoBriefingEntrypointFiles))
      .slice(0, Math.min(2, maxItems))
    : hotspotCandidates.slice(0, Math.min(2, maxItems));
  const relevantHotspots = selectedHotspotEntries
    .map((entry) => ({
      file: entry.item.file,
      subsystem_label: entry.item.subsystem_label || null,
      signal_type: entry.item.signal_type || 'module',
      summary: truncateText(entry.item.reason, 180),
      reason: buildStudyMatchReason(entry, 'Selected as a high-signal hotspot to orient on coupling and blast radius.'),
    }));

  const subsystemCandidates = rankStudyItems(knowledgePack.subsystems, {
    targetFiles,
    promptTokens,
    limit: repoBriefing
      ? Math.max(Math.min(Array.isArray(knowledgePack.subsystems) ? knowledgePack.subsystems.length : 0, maxItems * 2), maxItems)
      : maxItems,
    fallbackLimit: Math.min(2, maxItems),
    getFiles: (item) => item?.files || item?.key_files || item?.evidence_files || [],
    getTextParts: (item) => [item?.id, item?.label, item?.overview, item?.description],
    getBias: (item) => {
      let bias = Number.isFinite(item?.priority) ? Math.round(item.priority / 25) : 0;
      if (repoBriefing && isLowSignalRepoBriefingLabel(item?.label)) {
        bias -= 8;
      }
      if (repoBriefing && uniquePaths(item?.files || item?.key_files || []).every((filePath) => isLowSignalRepoBriefingFile(filePath))) {
        bias -= 4;
      }
      return bias;
    },
  });
  const rankedSubsystems = (repoBriefing
    ? selectRepoBriefingRankedEntries(
        subsystemCandidates,
        maxItems,
        (entry) => (
          isLowSignalRepoBriefingLabel(entry?.item?.label)
          || uniquePaths(entry?.item?.files || entry?.item?.key_files || []).every((filePath) => isLowSignalRepoBriefingFile(filePath))
        )
      )
    : subsystemCandidates.slice(0, maxItems))
    .map((entry) => ({
      id: entry.item.id,
      label: entry.item.label,
      overview: truncateText(entry.item.overview || entry.item.description, 180),
      key_files: uniquePaths(entry.item.files || entry.item.key_files || []).slice(0, Math.max(1, maxItems)),
      reason: buildStudyMatchReason(entry, 'Selected from the study onramp as a likely starting subsystem.'),
    }));

  const briefingFocusAreas = repoBriefing
    ? buildRepoBriefingFocusAreas({
        relevantEntrypoints,
        relevantHotspots,
        relevantFlows: [],
        maxItems,
      })
    : [];

  const relevantSubsystems = repoBriefing && briefingFocusAreas.length > 0
    ? briefingFocusAreas
    : rankedSubsystems;

  const relevantFlows = rankStudyItems(knowledgePack.flows, {
    targetFiles,
    promptTokens,
    limit: maxItems,
    fallbackLimit: Math.min(2, maxItems),
    getFiles: flattenFlowFiles,
    getTextParts: (item) => [item?.id, item?.label, item?.summary, ...(item?.questions || [])],
  }).map((entry) => ({
    id: entry.item.id,
    label: entry.item.label,
    summary: truncateText(entry.item.summary, 180),
    files: flattenFlowFiles(entry.item).slice(0, Math.max(1, maxItems)),
    reason: buildStudyMatchReason(entry, 'Selected from the study flow map as a likely execution path.'),
  }));

  const invariants = rankStudyItems(knowledgePack?.expertise?.invariants, {
    targetFiles,
    promptTokens,
    limit: Math.min(2, maxItems),
    fallbackLimit: 1,
    getFiles: (item) => item?.evidence_files || item?.related_files || [],
    getTextParts: (item) => [item?.id, item?.label, item?.statement, ...(item?.watchouts || [])],
  }).map((entry) => ({
    id: entry.item.id || entry.item.label,
    label: entry.item.label || entry.item.id,
    statement: truncateText(entry.item.statement, 190),
    evidence_files: uniquePaths(entry.item.evidence_files || entry.item.related_files || []).slice(0, Math.max(1, maxItems)),
  }));

  const changeGuidanceCandidates = rankStudyItems(knowledgePack?.expertise?.impact_guidance, {
    targetFiles,
    promptTokens,
    limit: Math.min(2, maxItems),
    fallbackLimit: 1,
    getFiles: (item) => item?.related_files || item?.tests || [],
    getTextParts: (item) => [item?.id, item?.label, item?.summary, item?.rationale, ...(item?.invariants || [])],
    getBias: (item) => {
      let bias = 0;
      if ((item?.validation_commands || []).length > 0) bias += 2;
      if (uniquePaths(item?.related_files || []).some((filePath) => !isLowSignalRepoBriefingFile(filePath))) bias += 2;
      if (repoBriefing && isLowSignalRepoBriefingLabel(item?.label || item?.id)) bias -= 6;
      if (repoBriefing && uniquePaths(item?.related_files || []).every((filePath) => isLowSignalRepoBriefingFile(filePath))) {
        bias -= 6;
      }
      return bias;
    },
  });
  const selectedChangeGuidanceEntries = repoBriefing
    ? changeGuidanceCandidates
      .filter((entry) => !isLowSignalRepoBriefingChangeGuidanceEntry(entry))
      .slice(0, Math.min(2, maxItems))
    : changeGuidanceCandidates.slice(0, Math.min(2, maxItems));
  const fallbackValidationCommandsInput = uniqueStrings([
    ...selectedChangeGuidanceEntries.flatMap((entry) => entry?.item?.validation_commands || []),
    ...changeGuidanceCandidates.flatMap((entry) => entry?.item?.validation_commands || []),
    ...collectStudyValidationCommands(knowledgePack),
  ]);
  const fallbackValidationCommands = repoBriefing
    ? selectRepoBriefingValidationCommands(fallbackValidationCommandsInput, 4)
    : fallbackValidationCommandsInput.slice(0, 4);
  let changeGuidance = selectedChangeGuidanceEntries.map((entry) => ({
    id: entry.item.id || entry.item.label,
    label: entry.item.label || entry.item.id,
    related_files: uniquePaths(entry.item.related_files || []).slice(0, Math.max(1, maxItems)),
    validation_commands: repoBriefing
      ? selectRepoBriefingValidationCommands(entry.item.validation_commands || [], 2)
      : uniqueStrings(entry.item.validation_commands || []).slice(0, 2),
  }));
  if (repoBriefing && changeGuidance.length === 0) {
    changeGuidance = buildRepoBriefingFallbackChangeGuidance({
      relevantEntrypoints,
      relevantHotspots,
      validationCommands: fallbackValidationCommands,
      maxItems,
    });
  }

  const representativeTests = repoBriefing
    ? []
    : rankStudyItems(knowledgePack?.expertise?.test_matrix, {
        targetFiles,
        promptTokens,
        limit: Math.min(2, maxItems),
        fallbackLimit: 1,
        getFiles: (item) => item?.tests || [],
        getTextParts: (item) => [item?.id, item?.label, item?.rationale],
      }).map((entry) => ({
        id: entry.item.id || entry.item.label,
        label: entry.item.label || entry.item.id,
        tests: uniquePaths(entry.item.tests || []).slice(0, Math.max(1, maxItems)),
        rationale: truncateText(entry.item.rationale, 160),
      }));

  const latestDelta = artifacts.studyDelta?.significance
    ? {
        level: normalizeStudyThresholdLevel(artifacts.studyDelta.significance.level, 'none'),
        score: normalizeNonNegativeInteger(artifacts.studyDelta.significance.score),
        reasons: uniqueStrings(artifacts.studyDelta.significance.reasons || []).slice(0, 3),
      }
    : null;

  if (
    relevantEntrypoints.length === 0
    && relevantHotspots.length === 0
    && relevantSubsystems.length === 0
    && relevantFlows.length === 0
    && invariants.length === 0
    && changeGuidance.length === 0
    && representativeTests.length === 0
  ) {
    return null;
  }

  const studyContext = {
    generated_at: new Date().toISOString(),
    repo_name: knowledgePack?.repo?.name || path.basename(normalizedWorkingDirectory),
    study_profile_id: knowledgePack?.study_profile?.id || null,
    readiness: artifacts.studyEvaluation?.summary?.readiness || null,
    grade: artifacts.studyEvaluation?.summary?.grade || null,
    score: normalizeNonNegativeInteger(artifacts.studyEvaluation?.summary?.score),
    benchmark_grade: artifacts.studyBenchmark?.summary?.grade || null,
    benchmark_score: normalizeNonNegativeInteger(artifacts.studyBenchmark?.summary?.score),
    target_files: targetFiles,
    relevant_entrypoints: relevantEntrypoints,
    relevant_hotspots: relevantHotspots,
    relevant_subsystems: relevantSubsystems,
    relevant_flows: relevantFlows,
    invariants,
    change_guidance: changeGuidance,
    representative_tests: representativeTests,
    latest_delta: latestDelta,
    artifact_paths: {
      knowledge_pack: toRepoPath(KNOWLEDGE_PACK_FILE),
      study_delta: toRepoPath(STUDY_DELTA_FILE),
      study_evaluation: toRepoPath(STUDY_EVALUATION_FILE),
      study_benchmark: toRepoPath(STUDY_BENCHMARK_FILE),
    },
  };
  const studyContextPrompt = buildTaskStudyContextPrompt(studyContext);
  if (!studyContextPrompt.trim()) {
    return null;
  }

  return {
    study_context: studyContext,
    study_context_summary: {
      readiness: studyContext.readiness,
      grade: studyContext.grade,
      score: studyContext.score,
      benchmark_grade: studyContext.benchmark_grade,
      benchmark_score: studyContext.benchmark_score,
      study_profile_id: studyContext.study_profile_id,
      entrypoint_files: relevantEntrypoints.map((item) => item.file),
      subsystem_ids: relevantSubsystems.map((item) => item.id),
      flow_ids: relevantFlows.map((item) => item.id),
      target_files: targetFiles,
      validation_commands: (repoBriefing
        ? selectRepoBriefingValidationCommands([
            ...changeGuidance.flatMap((item) => item.validation_commands || []),
            ...fallbackValidationCommands,
          ], 4)
        : uniqueStrings([
            ...changeGuidance.flatMap((item) => item.validation_commands || []),
            ...fallbackValidationCommands,
          ])).slice(0, 4),
      hotspot_files: relevantHotspots.map((item) => item.file),
    },
    study_context_prompt: studyContextPrompt,
  };
}

function applyStudyContextPrompt(taskDescription, metadata = {}) {
  const baseDescription = String(taskDescription || '').trim();
  const prompt = typeof metadata?.study_context_prompt === 'string'
    ? metadata.study_context_prompt.trim()
    : '';
  if (!prompt) {
    return baseDescription;
  }
  if (!baseDescription) {
    return prompt;
  }
  if (baseDescription.includes(prompt)) {
    return baseDescription;
  }
  return `${baseDescription}\n\n${prompt}`;
}

function normalizeStudyThresholdLevel(value, fallback = DEFAULT_PROPOSAL_SIGNIFICANCE_LEVEL) {
  const normalized = String(value || '').trim().toLowerCase();
  return SIGNIFICANCE_ORDER.includes(normalized) ? normalized : fallback;
}

function compareStudySignificanceLevels(left, right) {
  return SIGNIFICANCE_ORDER.indexOf(normalizeStudyThresholdLevel(left, 'none'))
    - SIGNIFICANCE_ORDER.indexOf(normalizeStudyThresholdLevel(right, 'none'));
}

function normalizeNonNegativeInteger(value, fallback = 0) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function readJsonFileIfPresent(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw.trim() ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function getStudyArtifactPaths(workingDirectory) {
  const resolved = path.resolve(String(workingDirectory || '').trim());
  return {
    workingDirectory: resolved,
    statePath: path.join(resolved, STUDY_STATE_FILE),
    moduleIndexPath: path.join(resolved, MODULE_INDEX_FILE),
    knowledgePackPath: path.join(resolved, KNOWLEDGE_PACK_FILE),
    deltaPath: path.join(resolved, STUDY_DELTA_FILE),
    evaluationPath: path.join(resolved, STUDY_EVALUATION_FILE),
    benchmarkPath: path.join(resolved, STUDY_BENCHMARK_FILE),
    summaryPath: path.join(resolved, SUMMARY_FILE),
  };
}

function readStudyArtifacts(workingDirectory, options = {}) {
  const paths = getStudyArtifactPaths(workingDirectory);
  const bundle = {
    paths,
    state: null,
    moduleIndex: null,
    knowledgePack: null,
    studyDelta: null,
    studyEvaluation: null,
    studyBenchmark: null,
  };

  if (options.includeState !== false) {
    bundle.state = readJsonFileIfPresent(paths.statePath);
  }
  if (options.includeModuleIndex === true) {
    bundle.moduleIndex = readJsonFileIfPresent(paths.moduleIndexPath);
  }
  if (options.includeKnowledgePack === true) {
    bundle.knowledgePack = readJsonFileIfPresent(paths.knowledgePackPath);
  }
  if (options.includeDelta === true) {
    bundle.studyDelta = readJsonFileIfPresent(paths.deltaPath);
  }
  if (options.includeEvaluation === true) {
    bundle.studyEvaluation = readJsonFileIfPresent(paths.evaluationPath);
  }
  if (options.includeBenchmark === true) {
    bundle.studyBenchmark = readJsonFileIfPresent(paths.benchmarkPath);
  }

  return bundle;
}

function shouldSubmitStudyProposals(studyDelta, options = {}) {
  if (options.submitProposals !== true) {
    return { allowed: false, reason: 'submission_disabled' };
  }

  const runMode = String(studyDelta?.run?.mode || '').trim().toLowerCase();
  if (!studyDelta || runMode.startsWith('baseline')) {
    return { allowed: false, reason: 'baseline_run' };
  }

  const changedFiles = Array.isArray(studyDelta?.changed_files?.repo_delta)
    ? studyDelta.changed_files.repo_delta
    : [];
  if (changedFiles.length === 0) {
    return { allowed: false, reason: 'no_repo_delta' };
  }

  const significanceLevel = normalizeStudyThresholdLevel(studyDelta?.significance?.level, 'none');
  const thresholdLevel = normalizeStudyThresholdLevel(
    options.proposalSignificanceLevel,
    DEFAULT_PROPOSAL_SIGNIFICANCE_LEVEL
  );
  if (compareStudySignificanceLevels(significanceLevel, thresholdLevel) < 0) {
    return {
      allowed: false,
      reason: 'below_significance_threshold',
      threshold_level: thresholdLevel,
      actual_level: significanceLevel,
    };
  }

  const significanceScore = normalizeNonNegativeInteger(studyDelta?.significance?.score);
  const minimumScore = normalizeNonNegativeInteger(options.proposalMinScore, DEFAULT_PROPOSAL_MIN_SCORE);
  if (significanceScore < minimumScore) {
    return {
      allowed: false,
      reason: 'below_score_threshold',
      threshold_score: minimumScore,
      actual_score: significanceScore,
    };
  }

  return {
    allowed: true,
    threshold_level: thresholdLevel,
    threshold_score: minimumScore,
  };
}

function parseTaskMetadata(value) {
  if (!value) {
    return {};
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  if (typeof value !== 'string') {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isSuppressedStudyProposalTask(task) {
  const approvalStatus = String(task?.approval_status || '').trim().toLowerCase();
  const status = String(task?.status || '').trim().toLowerCase();
  if (approvalStatus === 'rejected') {
    return false;
  }
  return !['failed', 'cancelled'].includes(status);
}

function filterDuplicateStudyProposals(proposals, taskCore, options = {}) {
  const input = Array.isArray(proposals) ? proposals : [];
  if (!taskCore || typeof taskCore.listTasks !== 'function' || input.length === 0) {
    return {
      proposals: input,
      suppressed: [],
    };
  }

  const existingTasks = taskCore.listTasks({
    project: options.project,
    tag: 'study-delta-proposal',
    limit: MAX_EXISTING_PROPOSAL_SCAN,
    includeArchived: true,
  });
  const existingByKey = new Map();
  for (const task of Array.isArray(existingTasks) ? existingTasks : []) {
    if (!isSuppressedStudyProposalTask(task)) {
      continue;
    }
    const metadata = parseTaskMetadata(task.metadata);
    const key = String(metadata?.study_proposal?.key || '').trim();
    if (!key || existingByKey.has(key)) {
      continue;
    }
    existingByKey.set(key, task);
  }

  const seenKeys = new Set();
  const accepted = [];
  const suppressed = [];
  for (const proposal of input) {
    const key = String(proposal?.key || '').trim();
    if (!key) {
      accepted.push(proposal);
      continue;
    }
    if (seenKeys.has(key)) {
      suppressed.push({
        key,
        title: proposal.title,
        reason: 'duplicate_within_run',
      });
      continue;
    }
    seenKeys.add(key);
    if (existingByKey.has(key)) {
      suppressed.push({
        key,
        title: proposal.title,
        reason: 'existing_pending_or_active_proposal',
        existing_task_id: existingByKey.get(key)?.id || null,
      });
      continue;
    }
    accepted.push(proposal);
  }

  return {
    proposals: accepted,
    suppressed,
  };
}

function buildProbe(prompt, expectedEvidence, readinessSignals = []) {
  const evidence = uniquePaths(expectedEvidence);
  const signals = uniqueStrings(readinessSignals);
  const answerability = evidence.length >= 3 && signals.length >= 2
    ? 'strong'
    : evidence.length >= 1
      ? 'partial'
      : 'weak';
  return {
    prompt,
    expected_evidence: evidence,
    readiness_signals: signals,
    answerability,
  };
}

function buildReverseDependencyMap(modules) {
  const reverseDeps = new Map();
  for (const moduleEntry of Array.isArray(modules) ? modules : []) {
    const sourceFile = toRepoPath(moduleEntry?.file);
    if (!sourceFile) {
      continue;
    }
    for (const dependency of uniquePaths(moduleEntry?.deps || [])) {
      if (!reverseDeps.has(dependency)) {
        reverseDeps.set(dependency, new Set());
      }
      reverseDeps.get(dependency).add(sourceFile);
    }
  }
  return reverseDeps;
}

function buildEvaluationProbes(knowledgePack, moduleIndex = null) {
  const probes = [];
  const repoName = knowledgePack?.repo?.name || 'the repository';
  const modules = Array.isArray(moduleIndex?.modules) ? moduleIndex.modules : [];
  const subsystemMap = new Map((Array.isArray(knowledgePack?.subsystems) ? knowledgePack.subsystems : []).map((item) => [item.id, item]));
  const reverseDeps = buildReverseDependencyMap(modules);
  const repoBriefingProbe = buildRepoBriefingProbe(knowledgePack, repoName);

  if (repoBriefingProbe) {
    probes.push(repoBriefingProbe);
  }

  for (const flow of Array.isArray(knowledgePack?.flows) ? knowledgePack.flows.slice(0, 3) : []) {
    probes.push({
      id: `flow:${flow.id}`,
      scope_type: 'flow',
      scope_id: flow.id,
      ...buildProbe(
        `Explain the ${flow.label} in ${repoName}. Where does it start, what are the main phases, and which files anchor each phase?`,
        [
          ...(Array.isArray(flow.files) ? flow.files : []),
          ...((Array.isArray(flow.steps) ? flow.steps : []).flatMap((step) => step.files || [])),
        ],
        [
          ...(Array.isArray(flow.questions_it_answers) ? flow.questions_it_answers : []),
          ...((Array.isArray(flow.steps) ? flow.steps : []).map((step) => step.label)),
        ]
      ),
    });
  }

  for (const invariant of Array.isArray(knowledgePack?.expertise?.invariants)
    ? knowledgePack.expertise.invariants.slice(0, 2)
    : []) {
    probes.push({
      id: `invariant:${invariant.id || invariant.label}`,
      scope_type: 'invariant',
      scope_id: invariant.id || invariant.label,
      ...buildProbe(
        `What invariant governs ${invariant.label || 'this subsystem'} in ${repoName}, and where should an engineer look before editing it?`,
        collectInvariantEvidenceFiles(invariant),
        [
          invariant.statement,
          invariant.why_it_matters,
          ...(invariant.watchouts || []),
        ]
      ),
    });
  }

  for (const playbook of Array.isArray(knowledgePack?.expertise?.change_playbooks)
    ? knowledgePack.expertise.change_playbooks.slice(0, 3)
    : []) {
    probes.push({
      id: `playbook:${playbook.id || playbook.label}`,
      scope_type: 'change_playbook',
      scope_id: playbook.id || playbook.label,
      ...buildProbe(
        `If you change ${playbook.label || 'this subsystem'} in ${repoName}, which files should you edit, which tests should you run, and which invariants must you recheck?`,
        collectPlaybookEvidenceFiles(playbook),
        [
          ...(playbook.validation_commands || []),
          ...((playbook.invariants_to_recheck || []).map((item) => item.statement)),
        ]
      ),
    });
  }

  for (const relationship of Array.isArray(knowledgePack?.subsystem_relationships)
    ? knowledgePack.subsystem_relationships.slice(0, 1)
    : []) {
    const fromSubsystem = subsystemMap.get(relationship.from);
    const toSubsystem = subsystemMap.get(relationship.to);
    const expectedEvidence = uniquePaths([
      ...extractRelationshipEvidenceFiles(relationship),
      ...(fromSubsystem?.entrypoints || []).slice(0, 2),
      ...(toSubsystem?.entrypoints || []).slice(0, 2),
    ]);
    probes.push({
      id: `relationship:${relationship.from || 'source'}:${relationship.to || 'target'}`,
      scope_type: 'subsystem_relationship',
      scope_id: `${relationship.from || 'source'}:${relationship.to || 'target'}`,
      ...buildProbe(
        `Explain how ${relationship.from_label || 'one subsystem'} connects to ${relationship.to_label || 'another subsystem'} in ${repoName}. Where is the boundary, and which files show the integration seam?`,
        expectedEvidence,
        [
          `${relationship.from_label || relationship.from} depends on ${relationship.to_label || relationship.to}.`,
          ...(Array.isArray(relationship?.example_edges) ? relationship.example_edges : []).slice(0, 2),
        ]
      ),
    });
  }

  const impactGuidance = Array.isArray(knowledgePack?.expertise?.impact_guidance)
    ? knowledgePack.expertise.impact_guidance
    : [];
  const hotspotModules = (Array.isArray(knowledgePack?.hotspots) ? knowledgePack.hotspots : [])
    .map((hotspot) => {
      const filePath = toRepoPath(hotspot?.file);
      if (!filePath) {
        return null;
      }
      const moduleEntry = modules.find((item) => toRepoPath(item?.file) === filePath);
      if (!moduleEntry) {
        return null;
      }
      const impact = impactGuidance.find((item) => uniquePaths(item?.related_files || []).includes(filePath)) || null;
      return {
        hotspot,
        moduleEntry,
        impact,
      };
    })
    .filter(Boolean)
    .slice(0, 1);

  for (const candidate of hotspotModules) {
    const filePath = toRepoPath(candidate.moduleEntry.file);
    const expectedEvidence = uniquePaths([
      filePath,
      ...uniquePaths(candidate.moduleEntry.deps || []).slice(0, 2),
      ...Array.from(reverseDeps.get(filePath) || []).slice(0, 2),
      ...(candidate.impact?.related_tests || []),
    ]);
    probes.push({
      id: `impact:${filePath}`,
      scope_type: 'change_impact',
      scope_id: filePath,
      ...buildProbe(
        `If you edit ${filePath} in ${repoName}, which nearby files and tests should you inspect first, and why is that file a risky seam?`,
        expectedEvidence,
        [
          candidate.hotspot?.reason,
          ...(candidate.impact?.validation_commands || []),
        ]
      ),
    });
  }

  return probes.slice(0, EVALUATION_PROBE_LIMIT);
}

function pushFinding(findings, severity, code, message, recommendation) {
  findings.push({
    severity,
    code,
    message,
    recommendation,
  });
}

function evaluateStudyArtifacts({ knowledgePack, studyDelta, state, moduleIndex, workingDirectory } = {}) {
  const trackedFiles = normalizeNonNegativeInteger(knowledgePack?.coverage?.tracked_files, state?.file_counts?.tracked || 0);
  const pendingFiles = normalizeNonNegativeInteger(knowledgePack?.coverage?.pending_files, state?.file_counts?.pending || 0);
  const indexedModules = normalizeNonNegativeInteger(knowledgePack?.coverage?.indexed_modules, moduleIndex?.modules?.length || 0);
  const indexedPercent = trackedFiles > 0
    ? Math.round((indexedModules / trackedFiles) * 100)
    : normalizeNonNegativeInteger(knowledgePack?.coverage?.indexed_percent, 0);
  const flowCount = Array.isArray(knowledgePack?.flows) ? knowledgePack.flows.length : 0;
  const invariantCount = Array.isArray(knowledgePack?.expertise?.invariants) ? knowledgePack.expertise.invariants.length : 0;
  const failureModeCount = Array.isArray(knowledgePack?.expertise?.failure_modes) ? knowledgePack.expertise.failure_modes.length : 0;
  const traceCount = Array.isArray(knowledgePack?.expertise?.canonical_traces) ? knowledgePack.expertise.canonical_traces.length : 0;
  const playbookCount = Array.isArray(knowledgePack?.expertise?.change_playbooks) ? knowledgePack.expertise.change_playbooks.length : 0;
  const testAreaCount = Array.isArray(knowledgePack?.expertise?.test_matrix) ? knowledgePack.expertise.test_matrix.length : 0;
  const impactGuidanceCount = Array.isArray(knowledgePack?.expertise?.impact_guidance) ? knowledgePack.expertise.impact_guidance.length : 0;
  const onrampReadCount = Array.isArray(knowledgePack?.expertise?.onramp?.read_order)
    ? knowledgePack.expertise.onramp.read_order.length
    : 0;

  let score = 100;
  const findings = [];
  const strengths = [];

  if (trackedFiles === 0 || indexedModules === 0) {
    score -= 50;
    pushFinding(
      findings,
      'critical',
      'missing_index',
      'The study artifacts do not contain any indexed modules yet.',
      'Run the study loop until module-index and knowledge-pack are populated.'
    );
  } else if (indexedPercent < 90 || pendingFiles > 0) {
    score -= indexedPercent < 75 ? 20 : 10;
    pushFinding(
      findings,
      pendingFiles > 0 ? 'important' : 'suggestion',
      'incomplete_coverage',
      `Coverage is incomplete: ${indexedModules}/${trackedFiles} modules indexed with ${pendingFiles} files still pending.`,
      'Let the local-first study finish or run additional manual batches before relying on the pack as a repo-wide briefing layer.'
    );
  } else {
    strengths.push(`Coverage is effectively complete at ${indexedPercent}% with no pending files.`);
  }

  if (flowCount < 3) {
    score -= 12;
    pushFinding(
      findings,
      'important',
      'thin_flow_map',
      `Only ${flowCount} canonical flow maps are available.`,
      'Add more flow maps for the most important runtime paths so downstream models can reason about execution boundaries quickly.'
    );
  } else {
    strengths.push(`The pack captures ${flowCount} canonical flows, which gives downstream models a usable execution map.`);
  }

  if (invariantCount < 5) {
    score -= 10;
    pushFinding(
      findings,
      'important',
      'thin_invariants',
      `Only ${invariantCount} invariants are present in the expertise layer.`,
      'Add more invariant sheets for subsystem boundaries, scheduling behavior, and provider/runtime assumptions.'
    );
  }

  if (failureModeCount < 4) {
    score -= 8;
    pushFinding(
      findings,
      'suggestion',
      'thin_failure_modes',
      `Only ${failureModeCount} failure modes are recorded.`,
      'Capture more common regression signatures and remediation notes so the pack feels operational instead of descriptive.'
    );
  }

  if (traceCount < 3) {
    score -= 8;
    pushFinding(
      findings,
      'important',
      'thin_traces',
      `Only ${traceCount} canonical traces are available.`,
      'Add more end-to-end traces for the dominant product workflows.'
    );
  }

  if (playbookCount < 4 || impactGuidanceCount < 4) {
    score -= 10;
    pushFinding(
      findings,
      'important',
      'thin_change_guidance',
      `Change guidance is shallow (${playbookCount} playbooks, ${impactGuidanceCount} impact entries).`,
      'Expand edit-surface guidance, validation commands, and invariant recheck notes for the main subsystems.'
    );
  } else {
    strengths.push('Change playbooks and impact guidance are present, which makes the pack useful for execution as well as understanding.');
  }

  if (testAreaCount < 4) {
    score -= 7;
    pushFinding(
      findings,
      'suggestion',
      'thin_test_matrix',
      `Only ${testAreaCount} test areas are represented.`,
      'Tie more subsystem and flow guidance back to representative tests and validation commands.'
    );
  }

  if (onrampReadCount < 5) {
    score -= 6;
    pushFinding(
      findings,
      'suggestion',
      'thin_onramp',
      `The LLM onramp only lists ${onrampReadCount} initial files.`,
      'Expand the read order so a new model can ramp from entrypoints into execution, workflows, and scheduling with less source chasing.'
    );
  }

  const deltaReasons = uniqueStrings(studyDelta?.significance?.reasons || []);
  if (deltaReasons.length > 0) {
    strengths.push('The latest delta includes explicit significance reasons, which supports explainable follow-up proposals.');
  }

  const normalizedScore = Math.max(0, Math.min(100, score));
  const readiness = normalizedScore >= 90
    ? 'expert_ready'
    : normalizedScore >= 75
      ? 'operator_ready'
      : normalizedScore >= 60
        ? 'guided_ready'
        : 'map_only';
  const grade = normalizedScore >= 93
    ? 'A'
    : normalizedScore >= 85
      ? 'B'
      : normalizedScore >= 75
        ? 'C'
        : normalizedScore >= 60
          ? 'D'
          : 'F';

  return {
    version: EVALUATION_VERSION,
    generated_at: new Date().toISOString(),
    repo: {
      name: knowledgePack?.repo?.name || path.basename(workingDirectory || process.cwd()),
      working_directory: workingDirectory || knowledgePack?.repo?.working_directory || null,
      study_profile_id: knowledgePack?.study_profile?.id || null,
    },
    summary: {
      score: normalizedScore,
      grade,
      readiness,
      findings_count: findings.length,
      strengths_count: strengths.length,
      indexed_percent: indexedPercent,
    },
    checks: {
      tracked_files: trackedFiles,
      indexed_modules: indexedModules,
      pending_files: pendingFiles,
      flow_count: flowCount,
      invariant_count: invariantCount,
      failure_mode_count: failureModeCount,
      trace_count: traceCount,
      playbook_count: playbookCount,
      impact_guidance_count: impactGuidanceCount,
      test_area_count: testAreaCount,
      onramp_read_count: onrampReadCount,
    },
    strengths,
    findings,
    probes: buildEvaluationProbes(knowledgePack, moduleIndex),
    artifacts: {
      knowledge_pack_path: toRepoPath(KNOWLEDGE_PACK_FILE),
      study_delta_path: toRepoPath(STUDY_DELTA_FILE),
      study_state_path: toRepoPath(STUDY_STATE_FILE),
      module_index_path: toRepoPath(MODULE_INDEX_FILE),
      summary_path: toRepoPath(SUMMARY_FILE),
    },
  };
}

function benchmarkStudyArtifacts({
  knowledgePack,
  studyDelta,
  studyEvaluation,
  moduleIndex,
  workingDirectory,
} = {}) {
  const modules = Array.isArray(moduleIndex?.modules) ? moduleIndex.modules : [];
  const moduleMap = new Map(modules.map((entry) => [toRepoPath(entry.file), entry]));
  const packFileSet = collectKnowledgePackFiles(knowledgePack);
  const probes = buildEvaluationProbes(knowledgePack, moduleIndex);

  const cases = probes.map((probe) => {
    const expectedEvidence = uniquePaths(probe.expected_evidence || []);
    const sourceEvidence = expectedEvidence.filter((filePath) => moduleMap.has(filePath));
    const packHits = sourceEvidence.filter((filePath) => packFileSet.has(filePath));
    const coverageRatio = sourceEvidence.length > 0
      ? packHits.length / sourceEvidence.length
      : 0;
    const answerabilityWeight = probe.answerability === 'strong'
      ? 1
      : probe.answerability === 'partial'
        ? 0.75
        : 0.4;
    const baseScore = Math.max(
      0,
      Math.min(100, Math.round(((coverageRatio * 0.7) + (answerabilityWeight * 0.3)) * 100))
    );
    const promptAlignment = probe.scope_type === 'repo_briefing'
      ? buildRepoBriefingPromptAlignment(probe, workingDirectory)
      : null;
    const score = promptAlignment
      ? Math.max(0, Math.min(100, Math.round((baseScore * 0.65) + (promptAlignment.score * 0.35))))
      : baseScore;
    const verdict = score >= 85
      ? 'pass'
      : score >= 60
        ? 'partial'
        : 'fail';

    const answerKey = sourceEvidence.slice(0, 4).map((filePath) => {
      const moduleEntry = moduleMap.get(filePath);
      return {
        file: filePath,
        purpose: moduleEntry?.purpose || null,
        exports: uniqueStrings(moduleEntry?.exports || []).slice(0, 4),
        deps: uniquePaths(moduleEntry?.deps || []).slice(0, 4),
      };
    });

    const notes = [];
    if (sourceEvidence.length === 0) {
      notes.push('No source-grounded module evidence was available for this probe.');
    }
    if (packHits.length !== sourceEvidence.length) {
      notes.push(`Pack coverage hit ${packHits.length}/${sourceEvidence.length} expected evidence files.`);
    }
    if (probe.answerability !== 'strong') {
      notes.push(`Probe answerability is ${probe.answerability}, so a downstream model will still need source reads.`);
    }
    if (promptAlignment && promptAlignment.score < 100) {
      notes.push(`Repo-briefing prompt alignment scored ${promptAlignment.score}.`);
    }

    return {
      id: probe.id,
      scope_type: probe.scope_type,
      scope_id: probe.scope_id,
      prompt: probe.prompt,
      expected_evidence: expectedEvidence,
      source_grounded_answer: answerKey,
      readiness_signals: uniqueStrings(probe.readiness_signals || []),
      pack_coverage: {
        matched_files: packHits,
        coverage_ratio: sourceEvidence.length > 0 ? Math.round(coverageRatio * 1000) / 1000 : 0,
      },
      answerability: probe.answerability,
      prompt_alignment: promptAlignment,
      score,
      verdict,
      notes,
    };
  });

  const totalScore = cases.length > 0
    ? Math.round(cases.reduce((sum, item) => sum + item.score, 0) / cases.length)
    : 0;
  const passedCount = cases.filter((item) => item.verdict === 'pass').length;
  const partialCount = cases.filter((item) => item.verdict === 'partial').length;
  const failedCount = cases.filter((item) => item.verdict === 'fail').length;
  const readiness = totalScore >= 90 && failedCount === 0
    ? 'expert_ready'
    : totalScore >= 75
      ? 'operator_ready'
      : totalScore >= 60
        ? 'guided_ready'
        : 'map_only';
  const grade = totalScore >= 93
    ? 'A'
    : totalScore >= 85
      ? 'B'
      : totalScore >= 75
        ? 'C'
        : totalScore >= 60
          ? 'D'
          : 'F';
  const findings = cases
    .filter((item) => item.verdict !== 'pass')
    .slice(0, 5)
    .map((item) => ({
      severity: item.verdict === 'fail' ? 'important' : 'suggestion',
      probe_id: item.id,
      message: `Benchmark probe ${item.id} scored ${item.score} (${item.verdict}).`,
      recommendation: item.notes[0] || 'Strengthen the expertise pack for this scope.',
    }));

  return {
    version: BENCHMARK_VERSION,
    generated_at: new Date().toISOString(),
    repo: {
      name: knowledgePack?.repo?.name || path.basename(workingDirectory || process.cwd()),
      working_directory: workingDirectory || null,
      study_profile_id: knowledgePack?.study_profile?.id || null,
    },
    summary: {
      score: totalScore,
      grade,
      readiness,
      total_cases: cases.length,
      passed_cases: passedCount,
      partial_cases: partialCount,
      failed_cases: failedCount,
      delta_significance_level: normalizeStudyThresholdLevel(studyDelta?.significance?.level, 'none'),
      evaluation_grade: studyEvaluation?.summary?.grade || null,
    },
    findings,
    cases,
    artifacts: {
      knowledge_pack_path: toRepoPath(KNOWLEDGE_PACK_FILE),
      study_delta_path: toRepoPath(STUDY_DELTA_FILE),
      study_evaluation_path: toRepoPath(STUDY_EVALUATION_FILE),
      module_index_path: toRepoPath(MODULE_INDEX_FILE),
      summary_path: toRepoPath(SUMMARY_FILE),
    },
  };
}

function buildStudyBootstrapPlan({
  workingDirectory,
  repoMetadata,
  trackedFiles,
  profile,
  project,
  scheduleName,
  cronExpression,
  timezone,
  versionIntent,
  proposalSignificanceLevel,
  proposalMinScore,
  proposalLimit,
  submitProposals,
  initialMaxBatches,
} = {}) {
  const trackedCount = Array.isArray(trackedFiles) ? trackedFiles.length : 0;
  const recommendedBatches = Number.isInteger(initialMaxBatches) && initialMaxBatches > 0
    ? initialMaxBatches
    : trackedCount > 1200
      ? 10
      : trackedCount > 400
        ? DEFAULT_BOOTSTRAP_BATCHES
        : 3;

  return {
    generated_at: new Date().toISOString(),
    repo: {
      name: repoMetadata?.name || path.basename(workingDirectory || process.cwd()),
      description: repoMetadata?.description || null,
      working_directory: workingDirectory || null,
      tracked_file_count: trackedCount,
      project: typeof project === 'string' && project.trim()
        ? project.trim()
        : (repoMetadata?.name || path.basename(workingDirectory || process.cwd())),
    },
    study_profile: profile
      ? {
          id: profile.id,
          label: profile.label,
          description: profile.description,
          reusable_strategy: profile.reusable_strategy,
        }
      : null,
    recommendations: {
      run_initial_study: true,
      run_benchmark: true,
      create_schedule: true,
      initial_run: {
        max_batches: recommendedBatches,
        strategy: 'local-deterministic',
      },
      schedule: {
        name: scheduleName || `codebase-study:${path.basename(workingDirectory || process.cwd())}`,
        cron_expression: cronExpression || DEFAULT_BOOTSTRAP_CRON,
        timezone: typeof timezone === 'string' && timezone.trim() ? timezone.trim() : null,
        version_intent: typeof versionIntent === 'string' && versionIntent.trim() ? versionIntent.trim() : 'fix',
        submit_proposals: submitProposals === true,
        proposal_significance_level: normalizeStudyThresholdLevel(
          proposalSignificanceLevel,
          DEFAULT_PROPOSAL_SIGNIFICANCE_LEVEL
        ),
        proposal_min_score: normalizeNonNegativeInteger(proposalMinScore, DEFAULT_PROPOSAL_MIN_SCORE),
        proposal_limit: Number.isInteger(proposalLimit) && proposalLimit > 0 ? proposalLimit : 2,
      },
    },
    steps: [
      `Detect the repo study profile (${profile?.label || 'generic repo'}).`,
      `Run an initial local-first study for up to ${recommendedBatches} batches.`,
      'Persist the knowledge pack, delta, evaluation, and benchmark artifacts.',
      `Create or refresh the study schedule \`${scheduleName || `codebase-study:${path.basename(workingDirectory || process.cwd())}`}\`.`,
    ],
  };
}

module.exports = {
  STUDY_STATE_FILE,
  MODULE_INDEX_FILE,
  KNOWLEDGE_PACK_FILE,
  STUDY_DELTA_FILE,
  STUDY_EVALUATION_FILE,
  STUDY_BENCHMARK_FILE,
  SUMMARY_FILE,
  DEFAULT_PROPOSAL_SIGNIFICANCE_LEVEL,
  DEFAULT_PROPOSAL_MIN_SCORE,
  DEFAULT_BOOTSTRAP_CRON,
  DEFAULT_BOOTSTRAP_BATCHES,
  normalizeStudyThresholdLevel,
  compareStudySignificanceLevels,
  readStudyArtifacts,
  shouldSubmitStudyProposals,
  filterDuplicateStudyProposals,
  evaluateStudyArtifacts,
  benchmarkStudyArtifacts,
  buildStudyBootstrapPlan,
  buildTaskStudyContextEnvelope,
  applyStudyContextPrompt,
};
