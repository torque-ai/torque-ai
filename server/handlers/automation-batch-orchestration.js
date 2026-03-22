/**
 * Batch orchestration handlers for TORQUE.
 * Extracted from automation-handlers.js — Part 2 decomposition.
 *
 * Contains:
 * - generate_feature_tasks — generate 6 task descriptions for a feature workflow
 * - cache_feature_gaps — scan Deluge vs Headwaters for implemented/missing features
 * - run_batch — full one-shot orchestration (generate + workflow + execute)
 * - detect_file_conflicts — post-workflow file conflict detection
 * - auto_commit_batch — verify + commit + push in one call
 * - extract_feature_spec — extract structured spec from a Deluge plan doc
 * - plan_next_batch — rank unimplemented features by readiness score
 * - run_full_batch — end-to-end: plan -> spec -> batch -> wire -> commit
 */

const path = require('path');
const fs = require('fs');
const { TASK_TIMEOUTS } = require('../constants');
const { safeExecChain } = require('../utils/safe-exec');
const { executeValidatedCommand, executeValidatedCommandSync } = require('../execution/command-policy');
const { ErrorCodes, makeError, isPathTraversalSafe } = require('./shared');
const logger = require('../logger').child({ component: 'automation-batch' });

// Lazy-load to avoid circular deps
let _taskCore;
function taskCore() { return _taskCore || (_taskCore = require('../db/task-core')); }
let _configCore;
function configCore() { return _configCore || (_configCore = require('../db/config-core')); }
let _fileTracking;
function fileTracking() { return _fileTracking || (_fileTracking = require('../db/file-tracking')); }
let _projectConfigCore;
function projectConfigCore() { return _projectConfigCore || (_projectConfigCore = require('../db/project-config-core')); }
let _workflowEngine;
function workflowEngine() { return _workflowEngine || (_workflowEngine = require('../db/workflow-engine')); }

function hasShellMetacharacters(value) {
  return /[;&$`|><\n\r]/.test(value);
}

function normalizeCommitPath(filePath, workingDir) {
  if (!workingDir || typeof filePath !== 'string') return null;

  const trimmed = filePath.trim().replace(/^"+|"+$/g, '');
  if (!trimmed) return null;

  const resolvedWorkingDir = path.resolve(workingDir);
  if (path.isAbsolute(trimmed)) {
    const resolvedFile = path.resolve(trimmed);
    const relativePath = path.relative(resolvedWorkingDir, resolvedFile);
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      return null;
    }
    return relativePath.replace(/\\/g, '/');
  }

  const normalizedRelative = path.normalize(trimmed);
  if (!normalizedRelative || normalizedRelative === '.' || normalizedRelative === path.sep) {
    return null;
  }
  if (normalizedRelative === '..' || normalizedRelative.startsWith(`..${path.sep}`)) {
    return null;
  }

  return normalizedRelative.replace(/\\/g, '/');
}

function addTrackedCommitPath(target, filePath, workingDir) {
  const normalized = normalizeCommitPath(filePath, workingDir);
  if (normalized) {
    target.add(normalized);
  }
}

function collectTrackedTaskFiles(taskId, workingDir) {
  const files = new Set();
  if (!taskId || !workingDir) return files;

  try {
    const taskChanges = fileTracking().getTaskFileChanges(taskId) || [];
    for (const change of taskChanges) {
      if (!change || change.is_outside_workdir) continue;
      addTrackedCommitPath(files, change.relative_path || change.file_path, workingDir);
    }
  } catch (err) {
    logger.debug('[automation-batch-orchestration] non-critical error reading task_file_changes:', err.message || err);
  }

  if (files.size > 0) {
    return files;
  }

  try {
    const task = taskCore().getTask(taskId);
    const modifiedFiles = Array.isArray(task?.files_modified) ? task.files_modified : [];
    for (const file of modifiedFiles) {
      const candidate = typeof file === 'string'
        ? file
        : file?.path || file?.file_path || '';
      addTrackedCommitPath(files, candidate, workingDir);
    }
  } catch (err) {
    logger.debug('[automation-batch-orchestration] non-critical error reading files_modified fallback:', err.message || err);
  }

  return files;
}

function resolveTaskIdsForCommit(args) {
  const taskIds = new Set();

  if (typeof args.task_id === 'string' && args.task_id.trim()) {
    taskIds.add(args.task_id.trim());
  }

  if (Array.isArray(args.task_ids)) {
    for (const taskId of args.task_ids) {
      if (typeof taskId === 'string' && taskId.trim()) {
        taskIds.add(taskId.trim());
      }
    }
  }

  if (typeof args.workflow_id === 'string' && args.workflow_id.trim()) {
    try {
      const workflowTasks = workflowEngine().getWorkflowTasks(args.workflow_id) || [];
      for (const task of workflowTasks) {
        if (task?.id) {
          taskIds.add(task.id);
        }
      }
    } catch (err) {
      logger.debug('[automation-batch-orchestration] non-critical error loading workflow task ids for commit:', err.message || err);
    }
  }

  return [...taskIds];
}

function resolveTrackedCommitFiles(args, workingDir) {
  const files = new Set();
  for (const taskId of resolveTaskIdsForCommit(args)) {
    for (const file of collectTrackedTaskFiles(taskId, workingDir)) {
      files.add(file);
    }
  }
  return [...files];
}

function getFallbackCommitFiles(workingDir) {
  try {
    const diffOutput = executeValidatedCommandSync('git', ['diff', '--name-only', '--relative', 'HEAD', '--', '.'], {
      profile: 'safe_verify',
      source: 'auto_commit_batch',
      caller: 'getFallbackCommitFiles',
      cwd: workingDir,
      timeout: TASK_TIMEOUTS.GIT_STATUS,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    if (!diffOutput) {
      return [];
    }

    return [...new Set(
      diffOutput
        .split(/\r?\n/)
        .map(file => normalizeCommitPath(file, workingDir))
        .filter(Boolean)
    )];
  } catch (err) {
    logger.debug('[automation-batch-orchestration] non-critical error reading git diff fallback:', err.message || err);
    return [];
  }
}

// ─── Feature 7: Generate Feature Task Descriptions ───────────────────────────

function handleGenerateFeatureTasks(args) {
  const workingDir = args.working_directory;
  if (!workingDir) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory is required');
  }

  const featureName = args.feature_name;
  if (!featureName) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'feature_name is required');
  }

  const description = args.feature_description || '';
  const kebab = featureName.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
  const pascal = featureName.charAt(0).toUpperCase() + featureName.slice(1);

  // Read project structure to find template files
  const typesDir = path.join(workingDir, 'src', 'types');
  const systemsDir = path.join(workingDir, 'src', 'systems');
  const dataDir = path.join(workingDir, 'src', 'data');
  const testsDir = path.join(workingDir, 'src', 'systems', '__tests__');

  // Find a reference type file, system file, data file, test file
  const refType = findLargestFile(typesDir, '.ts', ['index.ts']);
  const refSystem = findLargestFile(systemsDir, '.ts', ['EventSystem.ts', 'index.ts'], true);
  const refData = findLargestFile(dataDir, '.ts', ['index.ts']);
  const refTest = findLargestFile(testsDir, '.test.ts', []);

  // Read EventSystem to find event pattern
  const eventSystemPath = path.join(systemsDir, 'EventSystem.ts');
  let lastEventName = 'business_tier_up';
  try {
    const esContent = fs.readFileSync(eventSystemPath, 'utf8');
    const eventMatches = [...esContent.matchAll(/^\s+(\w+):\s*\{/gm)];
    if (eventMatches.length > 0) {
      lastEventName = eventMatches[eventMatches.length - 1][1];
    }
  } catch (err) {
    logger.debug('[automation-batch-orchestration] non-critical error parsing event names from route file:', err.message || err);
  }

  // Read GameScene to find wiring pattern
  const gameScenePath = path.join(workingDir, 'src', 'scenes', 'GameScene.ts');
  let lastSystemImport = '';
  let lastSystemField = '';
  try {
    const gsContent = fs.readFileSync(gameScenePath, 'utf8');
    const importMatches = [...gsContent.matchAll(/import\s*\{\s*(\w+System)\s*\}\s*from/g)];
    if (importMatches.length > 0) {
      lastSystemImport = importMatches[importMatches.length - 1][1];
    }
    const fieldMatches = [...gsContent.matchAll(/private\s+(\w+System)!/g)];
    if (fieldMatches.length > 0) {
      lastSystemField = fieldMatches[fieldMatches.length - 1][1];
    }
  } catch (err) {
    logger.debug('[automation-batch-orchestration] non-critical error parsing fields from route file:', err.message || err);
  }

  // Extract user-provided specs
  const typesSpec = args.types_spec || '';
  const eventsSpec = args.events_spec || '';
  const dataSpec = args.data_spec || '';
  const systemSpec = args.system_spec || '';

  // Build the 6 task descriptions
  const tasks = {};

  // 1. Types task
  tasks.types = `Create src/types/${kebab}.ts with type definitions for the ${pascal} feature.${refType ? `\n\nFollow the exact pattern used in ${refType.relative} as a reference.` : ''}

${description ? `Feature description: ${description}\n` : ''}${typesSpec ? `\nTypes to define:\n${typesSpec}` : `\nDefine the following:\n- Status enum (string enum with relevant states)\n- Core entity interface (the main data type for this feature)\n- Definition interface (static config for creating entities)\n- SystemState interface (for serialization: arrays of entities + aggregate stats)\n\nExport all types. Use readonly where sensible. Keep the file clean — no logic, no imports from other systems.`}`;

  // 2. Events task
  tasks.events = `Edit src/systems/EventSystem.ts to add event types for the ${pascal} feature.

Add new event types to the GameEvents interface after the "${lastEventName}" event (before the closing brace of GameEvents).

${eventsSpec ? `Events to add:\n${eventsSpec}` : `Add 3-4 events with typed payloads for the key actions in this feature (e.g., creation, completion, milestone).`}

Use 2-space indentation matching the style of existing events. Do NOT modify any existing events.`;

  // 3. Data task
  tasks.data = `Create src/data/${kebab}s.ts with static definitions for the ${pascal} feature.${refData ? `\n\nFollow the pattern in ${refData.relative} as a reference.` : ''}\n\nImport types from ../types/${kebab}.

${dataSpec ? `Data to define:\n${dataSpec}` : `Export a definitions array with 8-12 entries covering the feature's main categories. Each entry should have an id, name, description, and category-specific fields matching the Definition interface from the types file.`}`;

  // 4. System task
  tasks.system = `Create src/systems/${pascal}System.ts implementing the ${pascal} feature.${refSystem ? `\n\nFollow the EXACT pattern of ${refSystem.relative} (constructor-based, no scene dependency, event-driven).` : ''}

Import types from ../types/${kebab}, data from ../data/${kebab}s, and EventSystem from ./EventSystem.

${systemSpec || `The system should:
- Initialize from definitions in constructor (index into Map, create entities)
- Have public methods for the core CRUD operations
- Emit events via EventSystem.instance.emit() on key state changes
- Track aggregate stats (totals, counts)
- Include toJSON(): SystemState for serialization
- Include loadState(state): void with defensive deserialization (validate types, sanitize numbers, reconstruct from definitions)
- Use private clone helpers for defensive copies in getters
- Include a private sanitizeNumber(value, fallback) helper`}`;

  // 5. Tests task
  tasks.tests = `Create src/systems/__tests__/${pascal}System.test.ts with ~16 tests using vitest.${refTest ? `\n\nFollow the pattern from ${refTest.relative}.` : ''}

Import { describe, it, expect, beforeEach, vi } from 'vitest'.

Setup: beforeEach creates a fresh ${pascal}System instance and resets EventSystem.instance with clear().

Test the following areas:
1. Initialization (correct entity count from definitions, initial state)
2. Core operations (each public method — success and failure cases)
3. Event emission (subscribe to events, verify payloads)
4. State queries (filtering, counting, aggregation)
5. Serialization round-trip (toJSON → new instance → loadState → verify stats match)
6. Edge cases (invalid IDs, duplicate operations, boundary conditions)

Use EventSystem.instance.subscribe to listen for events. Use Date.now = vi.fn(() => 1000) to control timestamps.`;

  // 6. Wire task
  tasks.wire = `Edit two existing files to wire ${pascal}System into the game:

1. src/scenes/GameScene.ts:
- Add import: import { ${pascal}System } from "../systems/${pascal}System";
- Add private field: private ${kebab.replace(/-./g, c => c[1].toUpperCase())}System!: ${pascal}System;${lastSystemField ? ` (near ${lastSystemField})` : ''}
- In the create() method, after the last system instantiation, add: this.${kebab.replace(/-./g, c => c[1].toUpperCase())}System = new ${pascal}System();
- Add public getter: public get${pascal}System(): ${pascal}System { return this.${kebab.replace(/-./g, c => c[1].toUpperCase())}System; }

2. src/systems/NotificationBridge.ts:
- Add a relevant event name to the NotificationEvent type union
- In the connect() method, add a new bind call with an appropriate toast notification

Follow the EXACT same patterns as the existing ${lastSystemImport || 'system'} wiring in both files.`;

  let output = `## Generated Task Descriptions: ${pascal}System\n\n`;
  output += `**Feature:** ${featureName}\n`;
  output += `**Description:** ${description || '(none provided)'}\n\n`;

  output += '### Tasks\n\n';
  for (const [step, desc] of Object.entries(tasks)) {
    output += `#### ${step}\n\`\`\`\n${desc}\n\`\`\`\n\n`;
  }

  // Return structured data for use with create_feature_workflow
  output += '### Usage\n\n';
  output += 'Pass these directly to `create_feature_workflow`:\n';
  output += '```json\n';
  output += JSON.stringify({
    feature_name: kebab,
    working_directory: workingDir,
    types_task: tasks.types,
    events_task: tasks.events,
    data_task: tasks.data,
    system_task: tasks.system,
    tests_task: tasks.tests,
    wire_task: tasks.wire,
  }, null, 2).substring(0, 200) + '...\n```\n';

  return {
    content: [{ type: 'text', text: output }],
    _tasks: tasks,
  };
}

// Helper: find largest file in a directory matching extension
function findLargestFile(dirPath, ext, exclude, skipTests) {
  if (!fs.existsSync(dirPath)) return null;

  let best = null;
  let bestSize = 0;

  try {
    const entries = fs.readdirSync(dirPath);
    for (const entry of entries) {
      if (!entry.endsWith(ext)) continue;
      if (exclude.includes(entry)) continue;
      if (skipTests && entry.includes('__tests__')) continue;
      if (entry.startsWith('.')) continue;

      const fullPath = path.join(dirPath, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile() && stat.size > bestSize) {
          bestSize = stat.size;
          best = { name: entry, relative: path.relative(path.join(dirPath, '..', '..'), fullPath).replace(/\\/g, '/') };
        }
      } catch (err) {
        logger.debug('[automation-batch-orchestration] non-critical error reading feature file entry:', err.message || err);
      }
    }
  } catch (err) {
    logger.debug('[automation-batch-orchestration] non-critical error resolving feature directories:', err.message || err);
  }

  return best;
}

// ─── Feature 8: Feature Gap Cache ────────────────────────────────────────────

const CACHE_DIR = path.join(__dirname, '..', '.cache');
const GAP_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function handleCacheFeatureGaps(args) {
  const headwatersPath = args.headwaters_path || args.game_path;
  const delugePath = args.deluge_path || args.platform_path;

  if (!headwatersPath || !delugePath) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'Both headwaters_path and deluge_path are required');
  }

  const cacheFile = path.join(CACHE_DIR, 'feature-gaps.json');
  const forceRefresh = args.force_refresh === true;

  // Scan Headwaters for existing systems (needed for both cache check and fresh scan)
  const systemsDir = path.join(headwatersPath, 'src', 'systems');
  const existingSystems = new Set();
  try {
    const files = fs.readdirSync(systemsDir);
    for (const f of files) {
      if (f.endsWith('System.ts') && !f.includes('__tests__') && !f.startsWith('.')) {
        existingSystems.add(f.replace('.ts', ''));
      }
    }
  } catch (err) {
    logger.debug('[automation-batch-orchestration] non-critical error scanning feature systems:', err.message || err);
  }

  // Check cache freshness — invalidate if TTL expired OR system count changed
  if (!forceRefresh && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      const withinTTL = cached.timestamp && (Date.now() - cached.timestamp) < GAP_CACHE_TTL_MS;
      const systemCountMatch = cached.systemCount === existingSystems.size;
      if (withinTTL && systemCountMatch) {
        let output = `## Feature Gap Analysis (cached ${new Date(cached.timestamp).toLocaleString()})\n\n`;
        output += formatGapAnalysis(cached);
        output += `\n*Cache expires in ${Math.round((GAP_CACHE_TTL_MS - (Date.now() - cached.timestamp)) / 3600000)}h. Use \`force_refresh: true\` to update.*\n`;
        return { content: [{ type: 'text', text: output }] };
      }
    } catch (err) {
      logger.debug('[automation-batch-orchestration] non-critical error reading gap cache:', err.message || err);
    }
  }

  // Scan Deluge for feature modules
  const delugeFeatures = [];

  // Scan src/lib/ for feature files
  const libDir = path.join(delugePath, 'src', 'lib');
  if (fs.existsSync(libDir)) {
    try {
      const libFiles = fs.readdirSync(libDir);
      for (const f of libFiles) {
        if (f.endsWith('.ts') && !f.startsWith('_') && !f.startsWith('.')) {
          const name = f.replace('.ts', '');
          const fullPath = path.join(libDir, f);
          let lines = 0;
          try {
            lines = fs.readFileSync(fullPath, 'utf8').split('\n').length;
          } catch (err) {
            logger.debug('[automation-batch-orchestration] non-critical error reading lib feature file:', err.message || err);
          }
          delugeFeatures.push({ name, path: `src/lib/${f}`, lines, source: 'lib' });
        }
      }
    } catch (err) {
      logger.debug('[automation-batch-orchestration] non-critical error scanning lib feature directory:', err.message || err);
    }
  }

  // Scan docs/plans/ for feature plans
  const plansDir = path.join(delugePath, 'docs', 'plans');
  if (fs.existsSync(plansDir)) {
    try {
      const plans = fs.readdirSync(plansDir);
      for (const f of plans) {
        if (f.endsWith('.md')) {
          const name = f.replace(/^plan-\d+-/, '').replace('.md', '').replace(/-/g, ' ');
          delugeFeatures.push({ name, path: `docs/plans/${f}`, lines: 0, source: 'plan' });
        }
      }
    } catch (err) {
      logger.debug('[automation-batch-orchestration] non-critical error scanning docs plans directory:', err.message || err);
    }
  }

  // Map Deluge features to potential Headwaters systems
  // Static map for non-obvious mappings
  const systemNameMap = {
    'volunteer': 'VolunteerSystem',
    'referral': 'ReferralSystem',
    'family': 'FamilySystem',
    'verification': 'VerificationSystem',
    'badges': 'BadgeSystem',
    'circles': 'CircleSystem',
    'notifications': 'NotificationSystem',
    'donations': 'DonationSystem',
    'giving': 'GivingSystem',
    'matching': 'MatchingSystem',
    'impact': 'ImpactTrackingSystem',
    'skills': 'SkillsSystem',
    'in-kind': 'InKindSystem',
    'streak': 'StreakSystem',
    'seasonal': 'SeasonalSystem',
    'community-trust': 'CommunityTrustSystem',
    'loans': 'LoanSystem',
    'projects': 'ProjectManager',
    'voting': 'CommunityVotingSystem',
    'sponsorship': 'SponsorshipSystem',
    'rally': 'RallySystem',
    'business': 'BusinessDirectorySystem',
  };

  // Build a lowercase lookup set from existing systems for fuzzy matching
  const systemNamesLower = new Map();
  for (const sys of existingSystems) {
    // "CreditBureauSystem" -> "creditbureau", "AmbassadorSystem" -> "ambassador"
    systemNamesLower.set(sys.replace(/System$/, '').toLowerCase(), sys);
  }

  // Derive a PascalCase system name from a feature name
  // "credit bureau" -> "CreditBureauSystem", "ambassador program" -> "AmbassadorProgramSystem"
  function deriveSystemName(featureName) {
    const pascal = featureName
      .split(/[\s\-_]+/)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join('');
    return pascal + 'System';
  }

  // Check if a derived system name (or any prefix of it) matches an existing system
  function findDerivedMatch(featureName) {
    const derived = deriveSystemName(featureName);
    // Exact match: "CreditBureauSystem" exists
    if (existingSystems.has(derived)) return derived;
    // Fuzzy: strip trailing words and check
    const words = featureName.split(/[\s\-_]+/);
    for (let len = words.length; len >= 1; len--) {
      const prefix = words.slice(0, len).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
      const candidate = prefix + 'System';
      if (existingSystems.has(candidate)) return candidate;
      // Also check lowercase fuzzy against the set
      const lower = prefix.toLowerCase();
      if (systemNamesLower.has(lower)) return systemNamesLower.get(lower);
    }
    return null;
  }

  // Categorize features
  const implemented = [];
  const gaps = [];
  const partialMatches = [];

  for (const feature of delugeFeatures) {
    const featureKey = feature.name.toLowerCase().replace(/[^a-z]/g, '');

    // 1. Try static map first
    const matchedSystem = Object.entries(systemNameMap).find(([key]) => featureKey.includes(key));

    if (matchedSystem && existingSystems.has(matchedSystem[1])) {
      implemented.push({ ...feature, system: matchedSystem[1] });
    } else if (matchedSystem) {
      // Static map matched but system doesn't exist yet — check derived match too
      const derived = findDerivedMatch(feature.name);
      if (derived) {
        implemented.push({ ...feature, system: derived });
      } else {
        partialMatches.push({ ...feature, suggestedSystem: matchedSystem[1] });
      }
    } else {
      // 2. No static map match — try deriving system name from feature name
      const derived = findDerivedMatch(feature.name);
      if (derived) {
        implemented.push({ ...feature, system: derived });
      } else {
        // 3. Suggest a system name for the gap
        const suggested = deriveSystemName(feature.name);
        gaps.push({ ...feature, suggestedSystem: suggested });
      }
    }
  }

  // Sort gaps by relevance (plan docs first, then by lines)
  gaps.sort((a, b) => {
    if (a.source === 'plan' && b.source !== 'plan') return -1;
    if (a.source !== 'plan' && b.source === 'plan') return 1;
    return b.lines - a.lines;
  });

  const cacheData = {
    timestamp: Date.now(),
    headwatersPath,
    delugePath,
    existingSystems: [...existingSystems],
    systemCount: existingSystems.size,
    implemented,
    gaps,
    partialMatches,
    totalDelugeFeatures: delugeFeatures.length,
  };

  // Write cache
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
  fs.writeFileSync(cacheFile, JSON.stringify(cacheData, null, 2));

  let output = '## Feature Gap Analysis (fresh scan)\n\n';
  output += formatGapAnalysis(cacheData);

  return { content: [{ type: 'text', text: output }] };
}

function formatGapAnalysis(data) {
  let output = `**Headwaters systems:** ${data.existingSystems.length}\n`;
  output += `**Deluge features:** ${data.totalDelugeFeatures}\n`;
  output += `**Implemented:** ${data.implemented.length}\n`;
  output += `**Gaps:** ${data.gaps.length}\n\n`;

  if (data.gaps.length > 0) {
    output += '### Unimplemented Features\n\n';
    output += '| Feature | Source | Lines | Path |\n|---------|--------|-------|------|\n';
    for (const gap of data.gaps.slice(0, 15)) {
      output += `| ${gap.name} | ${gap.source} | ${gap.lines || '-'} | ${gap.path} |\n`;
    }
    output += '\n';
  }

  if (data.partialMatches.length > 0) {
    output += '### Partially Matched (Deluge feature exists, system name identified)\n\n';
    output += '| Feature | Suggested System | Path |\n|---------|-----------------|------|\n';
    for (const pm of data.partialMatches) {
      output += `| ${pm.name} | ${pm.suggestedSystem} | ${pm.path} |\n`;
    }
    output += '\n';
  }

  if (data.implemented.length > 0) {
    output += '### Already Implemented\n\n';
    output += '| Deluge Feature | Headwaters System |\n|---------------|------------------|\n';
    for (const imp of data.implemented) {
      output += `| ${imp.name} | ${imp.system} |\n`;
    }
    output += '\n';
  }

  return output;
}

// ─── Feature 9: Run Batch (Full Orchestration) ──────────────────────────────

async function handleRunBatch(args) {
  try {
  
  const workingDir = args.working_directory;
  if (!workingDir) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory is required');
  }
  
  if (!isPathTraversalSafe(workingDir)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'working_directory contains path traversal');
  }
  if (hasShellMetacharacters(workingDir)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'working_directory contains unsupported shell metacharacters');
  }

  const featureName = args.feature_name;
  if (!featureName) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'feature_name is required. Use `cache_feature_gaps` to identify the next feature.');
  }
  if (typeof featureName !== 'string') {
    return makeError(ErrorCodes.INVALID_PARAM, 'feature_name must be a string');
  }
  if (hasShellMetacharacters(featureName)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'feature_name contains unsupported shell metacharacters');
  }

  const featureDescription = args.feature_description || '';
  let rawParallelTestCount = args.parallel_test_count;
  if (rawParallelTestCount !== undefined) {
    const parsedParallelTestCount = parseInt(rawParallelTestCount, 10);
    if (Number.isNaN(parsedParallelTestCount)) {
      return makeError(ErrorCodes.INVALID_PARAM, 'parallel_test_count must be an integer');
    }
    rawParallelTestCount = parsedParallelTestCount;
  }
  const parallelTestCount = Math.min(Math.max(rawParallelTestCount || 3, 0), 5);
  const _provider = args.provider || 'codex';
  const batchName = args.batch_name || `Batch — ${featureName}System`;

  // Merge saved step_providers with per-call overrides (per-call wins)
  const project = projectConfigCore().getProjectFromPath(workingDir);
  const savedStepProviders = (() => {
    try { return JSON.parse(projectConfigCore().getProjectMetadata(project, 'step_providers') || '{}'); }
    catch { return {}; }
  })();
  const stepProviders = { ...savedStepProviders, ...(args.step_providers || {}) };

  let output = `## Run Batch: ${featureName}\n\n`;

  // Step 1: Generate feature task descriptions
  output += '### Step 1: Generating task descriptions...\n\n';
  const featureTaskResult = handleGenerateFeatureTasks({
    working_directory: workingDir,
    feature_name: featureName,
    feature_description: featureDescription,
    types_spec: args.types_spec || '',
    events_spec: args.events_spec || '',
    data_spec: args.data_spec || '',
    system_spec: args.system_spec || '',
  });

  const tasks = featureTaskResult._tasks;
  if (!tasks) {
    return makeError(ErrorCodes.OPERATION_FAILED, output + 'Failed to generate task descriptions.');
  }
  output += `Generated 6 task descriptions.\n\n`;

  // Step 2: Generate parallel test tasks
  // Note: handleGenerateTestTasks is imported from the main automation-handlers module
  let parallelTasks = [];
  if (parallelTestCount > 0) {
    output += '### Step 2: Scanning for test gaps...\n\n';
    const automationHandlers = require('./automation-handlers');
    const testGapResult = automationHandlers.handleGenerateTestTasks({
      working_directory: workingDir,
      count: parallelTestCount,
    });

    // Extract generated tasks from the output (they're in the JSON block)
    try {
      const jsonMatch = testGapResult.content[0].text.match(/```json\n([\s\S]+?)\n```/);
      if (jsonMatch) {
        parallelTasks = JSON.parse(jsonMatch[1]);
        output += `Found ${parallelTasks.length} untested files for parallel tasks.\n\n`;
      }
    } catch (err) {
      logger.debug('[automation-batch-orchestration] non-critical error parsing feature generation response:', err.message || err);
    }
  }

  // Step 3: Create workflow
  output += '### Step 3: Creating workflow...\n\n';
  const workflowHandlers = require('./workflow');

  const kebab = featureName.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
  const workflowResult = workflowHandlers.handleCreateFeatureWorkflow({
    feature_name: kebab,
    working_directory: workingDir,
    workflow_name: batchName,
    types_task: tasks.types,
    events_task: tasks.events,
    data_task: tasks.data,
    system_task: tasks.system,
    tests_task: tasks.tests,
    wire_task: tasks.wire,
    parallel_tasks: parallelTasks.map(t => ({
      node_id: t.node_id,
      task: t.task,
    })),
    auto_run: true,
    step_providers: stepProviders,
  });

  // Extract workflow ID from result
  const workflowIdMatch = workflowResult.content[0].text.match(/\*\*ID:\*\*\s*([a-f0-9-]+)/);
  const workflowId = workflowIdMatch ? workflowIdMatch[1] : null;

  if (!workflowId) {
    output += 'Failed to create workflow.\n';
    output += workflowResult.content[0].text;
    return makeError(ErrorCodes.OPERATION_FAILED, output);
  }

  output += `Workflow created and running: \`${workflowId}\`\n`;
  output += `**Total tasks:** ${6 + parallelTasks.length} (6 feature + ${parallelTasks.length} parallel tests)\n\n`;

  // Step 4: Return workflow ID for monitoring
  output += '### Next Steps\n\n';
  output += `Use \`await_workflow\` to wait for completion:\n`;
  output += '```json\n';
  output += JSON.stringify({
    workflow_id: workflowId,
    verify_command: 'npx tsc --noEmit && npx vitest run',
    auto_commit: true,
    commit_message: `feat: add ${featureName}System + batch tests`,
    auto_push: false,
  }, null, 2);
  output += '\n```\n';
  output += `\nOr use \`workflow_status\` to check progress: \`workflow_status({ workflow_id: "${workflowId}" })\`\n`;

  return {
    content: [{ type: 'text', text: output }],
    _workflow_id: workflowId,
  };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }}

// ─── Feature 10: Detect File Conflicts ───────────────────────────────────────

function handleDetectFileConflicts(args) {
  const workflowId = args.workflow_id;
  if (!workflowId) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'workflow_id is required');
  }

  const workflow = workflowEngine().getWorkflow(workflowId);
  if (!workflow) {
    return makeError(ErrorCodes.WORKFLOW_NOT_FOUND, `Workflow not found: ${workflowId}`);
  }

  const status = workflowEngine().getWorkflowStatus(workflowId);
  if (!status) {
    return makeError(ErrorCodes.OPERATION_FAILED, 'Could not get workflow status');
  }

  const workingDir = args.working_directory || workflow.working_directory;
  const tasks = Object.values(status.tasks || {});
  const completedTasks = tasks.filter(t => t.status === 'completed');

  let output = `## File Conflict Detection: ${status.name}\n\n`;
  output += `**Completed tasks:** ${completedTasks.length}/${tasks.length}\n\n`;

  // Get files modified by each task using git
  const taskFiles = new Map(); // taskId -> Set<filePath>
  const fileModifiers = new Map(); // filePath -> [taskNodeIds]

  for (const task of completedTasks) {
    const taskId = task.id;
    const nodeId = task.node_id || taskId.substring(0, 8);

    // Check task result for files_modified
    const fullTask = taskCore().getTask(taskId);
    if (!fullTask) continue;

    const modifiedFiles = new Set();

    // Try parsing files_modified from task
    if (fullTask.files_modified) {
      try {
        const files = JSON.parse(fullTask.files_modified);
        if (Array.isArray(files)) {
          for (const f of files) {
            const normalized = (typeof f === 'string' ? f : f.path || '').replace(/\\/g, '/');
            if (normalized) modifiedFiles.add(normalized);
          }
        }
      } catch (err) {
        logger.debug('[automation-batch-orchestration] non-critical error normalizing modified file list:', err.message || err);
      }
    }

    // Also try git diff between task's before/after SHAs
    if (fullTask.git_before_sha && fullTask.git_after_sha && workingDir) {
      try {
        // Validate SHAs are hex-only to prevent shell injection
        const shaPattern = /^[0-9a-fA-F]{6,40}$/;
        if (!shaPattern.test(fullTask.git_before_sha) || !shaPattern.test(fullTask.git_after_sha)) {
          logger.debug('[automation-batch-orchestration] skipping file diff due to invalid git SHA format:', fullTask.git_before_sha, fullTask.git_after_sha);
          continue;
        }
        const diff = executeValidatedCommandSync('git', ['diff', '--name-only', fullTask.git_before_sha, fullTask.git_after_sha], {
          profile: 'safe_verify',
          source: 'detect_file_conflicts',
          caller: 'handleDetectFileConflicts',
          cwd: workingDir,
          timeout: TASK_TIMEOUTS.GIT_STATUS,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe']
        }).trim();
        if (diff) {
          for (const f of diff.split('\n')) {
            modifiedFiles.add(f.replace(/\\/g, '/'));
          }
        }
      } catch (err) {
        logger.debug('[automation-batch-orchestration] non-critical error reading git diff for task:', err.message || err);
      }
    }

    taskFiles.set(nodeId, modifiedFiles);

    for (const file of modifiedFiles) {
      if (!fileModifiers.has(file)) {
        fileModifiers.set(file, []);
      }
      fileModifiers.get(file).push(nodeId);
    }
  }

  // Find conflicts (files modified by 2+ tasks)
  const conflicts = [];
  for (const [file, modifiers] of fileModifiers) {
    if (modifiers.length > 1) {
      conflicts.push({ file, tasks: modifiers });
    }
  }

  if (conflicts.length === 0) {
    output += '### Result: No Conflicts\n\n';
    output += 'No files were modified by multiple tasks.\n';

    // Show file summary
    output += '\n### Files Modified\n\n';
    output += '| Task | Files |\n|------|-------|\n';
    for (const [nodeId, files] of taskFiles) {
      output += `| ${nodeId} | ${files.size > 0 ? [...files].join(', ') : '(none tracked)'} |\n`;
    }
  } else {
    output += `### Result: ${conflicts.length} Potential Conflict${conflicts.length !== 1 ? 's' : ''}\n\n`;
    output += '| File | Modified By |\n|------|------------|\n';
    for (const conflict of conflicts) {
      output += `| ${conflict.file} | ${conflict.tasks.join(', ')} |\n`;
    }

    // Check for actual syntax errors in conflicted files
    if (workingDir) {
      output += '\n### Syntax Check\n\n';
      try {
        executeValidatedCommandSync('npx', ['tsc', '--noEmit'], {
          profile: 'safe_verify',
          source: 'detect_file_conflicts',
          caller: 'handleDetectFileConflicts',
          cwd: workingDir,
          timeout: TASK_TIMEOUTS.TEST_RUN,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe']
        });
        output += 'TypeScript compilation: **PASSED** (no errors)\n';
      } catch (err) {
        const stderr = (err.stdout || '') + '\n' + (err.stderr || '');
        const errorCount = (stderr.match(/error TS/g) || []).length;
        output += `TypeScript compilation: **FAILED** (${errorCount} errors)\n\n`;

        // Show errors only for conflicted files
        for (const conflict of conflicts) {
          const fileErrors = stderr.split('\n').filter(l => l.includes(conflict.file) && /error TS/.test(l));
          if (fileErrors.length > 0) {
            output += `**${conflict.file}:**\n`;
            for (const e of fileErrors.slice(0, 5)) {
              output += `  ${e.trim()}\n`;
            }
            output += '\n';
          }
        }

        output += 'Use `auto_verify_and_fix` to auto-submit fix tasks.\n';
      }
    }
  }

  return { content: [{ type: 'text', text: output }] };
}

// ─── Feature 11: Auto Commit Batch ───────────────────────────────────────────

async function handleAutoCommitBatch(args) {
  try {
  
  const workingDir = args.working_directory;
  if (!workingDir) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory is required');
  }
  

  const batchName = args.batch_name || 'batch';
  const push = args.auto_push === true || args.push === true;
  const verifyFirst = args.verify !== false;
  const stagePaths = args.stage_paths || ['.'];
  const coAuthor = args.co_author || 'Claude Opus 4.6 <noreply@anthropic.com>';

  // Resolve verify command: explicit arg > project defaults > fallback
  let verifyCmd = args.verify_command;
  if (!verifyCmd) {
    try {
      const defaults = configCore().getConfig(`project_defaults_${workingDir}`);
      if (defaults) {
        const parsed = JSON.parse(defaults);
        verifyCmd = parsed.verify_command;
      }
    } catch (err) {
      logger.debug('[automation-batch-orchestration] non-critical error loading project verify defaults:', err.message || err);
    }
  }
  if (!verifyCmd) verifyCmd = 'npx tsc --noEmit && npx vitest run';

  // Resource gate: warn if any host is overloaded before running verify
  try {
    const { checkResourceGate } = require('../utils/resource-gate');
    const { hostActivityCache } = require('../utils/host-monitoring');
    if (hostActivityCache && hostActivityCache.size > 0) {
      for (const [hostId] of hostActivityCache) {
        const gateResult = checkResourceGate(hostActivityCache, hostId, db());
        if (gateResult && !gateResult.allowed) {
          logger.info(`[auto-commit-batch] Resource warning: host ${hostId} overloaded — ${gateResult.reason || 'CPU/RAM >= 85%'}`);
          break;
        }
      }
    }
  } catch (gateErr) {
    // Missing module or unexpected error — don't break existing functionality
    logger.debug('[auto-commit-batch] Resource gate check skipped: ' + (gateErr.message || gateErr));
  }

  // Validate shell commands against allowlist policy
  const { validateShellCommand } = require('../utils/shell-policy');
  const verifyCheck = validateShellCommand(verifyCmd);
  if (!verifyCheck.ok) {
    return makeError(ErrorCodes.INVALID_PARAM, `verify_command rejected: ${verifyCheck.reason}`);
  }

  const resolvedWorkingDir = path.resolve(workingDir);
  const workingDirPrefix = process.platform === 'win32'
    ? `${resolvedWorkingDir.toLowerCase()}${path.sep}`
    : `${resolvedWorkingDir}${path.sep}`;

  const validatedStagePaths = [];
  for (const sp of stagePaths) {
    const resolvedStagePath = path.resolve(resolvedWorkingDir, sp);
    const normalizedResolvedStagePath = process.platform === 'win32'
      ? resolvedStagePath.toLowerCase()
      : resolvedStagePath;
    if (!(normalizedResolvedStagePath === (process.platform === 'win32' ? resolvedWorkingDir.toLowerCase() : resolvedWorkingDir)
      || normalizedResolvedStagePath.startsWith(workingDirPrefix))) {
      return makeError(ErrorCodes.INVALID_PARAM, `Invalid stage path: ${sp}`);
    }
    validatedStagePaths.push(sp);
  }

  let output = `## Auto Commit Batch: ${batchName}\n\n`;

  // Step 1: Verify (tsc + vitest)
  if (verifyFirst) {
    output += '### Step 1: Verify\n\n';
    try {
      const verifyResult = safeExecChain(verifyCmd, {
        cwd: workingDir,
        timeout: TASK_TIMEOUTS.VERIFY_COMMAND,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (verifyResult.exitCode !== 0) {
        const stderr = (verifyResult.stderr || verifyResult.error || '');
        const tsErrors = (stderr.match(/error TS/g) || []).length;
        const testFailMatch = stderr.match(/(\d+)\s+failed/);
        output += `Verification **FAILED**\n`;
        if (tsErrors > 0) output += `- ${tsErrors} TypeScript errors\n`;
        if (testFailMatch) output += `- ${testFailMatch[1]} test failures\n`;
        output += '\nAborting commit. Fix errors first.\n';
        return makeError(ErrorCodes.OPERATION_FAILED, output);
      }

      // Extract test count from vitest output
      const testMatch = verifyResult.output.match(/(\d+)\s+passed/);
      const testCount = testMatch ? testMatch[1] : '?';
      output += `Verification **PASSED** (${testCount} tests)\n\n`;
    } catch (err) {
      const stderr = (err.stderr || err.message || '');
      const tsErrors = (stderr.match(/error TS/g) || []).length;
      const testFailMatch = stderr.match(/(\d+)\s+failed/);
      output += `Verification **FAILED**\n`;
      if (tsErrors > 0) output += `- ${tsErrors} TypeScript errors\n`;
      if (testFailMatch) output += `- ${testFailMatch[1]} test failures\n`;
      output += '\nAborting commit. Fix errors first.\n';
      return makeError(ErrorCodes.OPERATION_FAILED, output);
    }
  }

  // Step 2: Check for changes
  output += '### Step 2: Stage changes\n\n';
  try {
    await executeValidatedCommand('git', ['rev-parse', '--show-toplevel'], {
      profile: 'advanced_shell',
      dangerous: true,
      source: 'auto_commit_batch',
      caller: 'handleAutoCommitBatch',
      cwd: workingDir,
      timeout: TASK_TIMEOUTS.GIT_STATUS,
      encoding: 'utf8',
    });
  } catch (err) {
    output += `Error checking git status: ${err.message}\n`;
    return makeError(ErrorCodes.OPERATION_FAILED, output);
  }

  const trackedCommitFiles = resolveTrackedCommitFiles(args, workingDir);
  const filesToCommit = trackedCommitFiles.length > 0
    ? trackedCommitFiles
    : getFallbackCommitFiles(workingDir);

  if (filesToCommit.length === 0) {
    output += 'No changes to commit — working tree is clean.\n';
    return { content: [{ type: 'text', text: output }] };
  }

  output += `${filesToCommit.length} file(s) selected for commit\n\n`;

  try {
    await executeValidatedCommand('git', ['add', '--', ...filesToCommit], {
      profile: 'advanced_shell',
      dangerous: true,
      source: 'auto_commit_batch',
      caller: 'handleAutoCommitBatch',
      cwd: workingDir,
      timeout: TASK_TIMEOUTS.GIT_ADD,
      encoding: 'utf8'
    });
  } catch (err) {
    output += `Error staging files: ${err.message}\n`;
    return makeError(ErrorCodes.OPERATION_FAILED, output);
  }

  let stagedOutput = '';
  try {
    stagedOutput = (await executeValidatedCommand('git', ['diff', '--cached', '--name-only', '--relative', '--', ...filesToCommit], {
      profile: 'safe_verify',
      source: 'auto_commit_batch',
      caller: 'handleAutoCommitBatch',
      cwd: workingDir,
      timeout: TASK_TIMEOUTS.GIT_STATUS,
      encoding: 'utf8',
    })).stdout.trim();
  } catch (err) {
    output += `Error checking staged files: ${err.message}\n`;
    return makeError(ErrorCodes.OPERATION_FAILED, output);
  }

  if (!stagedOutput) {
    output += 'No changes to commit — no tracked files were staged.\n';
    return { content: [{ type: 'text', text: output }] };
  }

  // Step 4: Get test count for commit message
  let testCount = '?';
  const testCountCmd = args.test_count_command || verifyCmd;
  const testCmdCheck = validateShellCommand(testCountCmd);
  if (!testCmdCheck.ok) {
    output += `Test count command rejected: ${testCmdCheck.reason}\n`;
    logger.debug('[automation-batch-orchestration] non-critical error deriving test count:', testCmdCheck.reason);
  } else {
    try {
      const testResult = safeExecChain(testCountCmd, {
        cwd: workingDir,
        timeout: TASK_TIMEOUTS.VERIFY_COMMAND,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      });
      // Try vitest pattern first, then jest, then generic
      const match = testResult.exitCode === 0 ? testResult.output.match(/(\d+)\s+(?:passed|passing)/) : null;
      if (match) testCount = match[1];
    } catch (err) {
      logger.debug('[automation-batch-orchestration] non-critical error deriving test count:', err.message || err);
    }
  }

  // Step 5: Commit
  output += '### Step 3: Commit\n\n';
  let commitMessage = args.commit_message || `feat: ${batchName} (${testCount} tests)`;
  if (commitMessage.length > 4096) {
    commitMessage = commitMessage.slice(0, 4096);
    output += 'Warning: commit_message exceeded 4096 characters and was truncated.\n';
  }
  const fullCommitMsg = `${commitMessage}\n\nCo-Authored-By: ${coAuthor}`;

  try {
    await executeValidatedCommand('git', ['commit', '-m', fullCommitMsg, '--', ...filesToCommit], {
      profile: 'advanced_shell',
      dangerous: true,
      source: 'auto_commit_batch',
      caller: 'handleAutoCommitBatch',
      cwd: workingDir,
      timeout: TASK_TIMEOUTS.HTTP_REQUEST,
      encoding: 'utf8'
    });
    output += `Committed: "${commitMessage}"\n\n`;
  } catch (err) {
    output += `Commit failed: ${err.message}\n`;
    return makeError(ErrorCodes.OPERATION_FAILED, output);
  }

  // Step 6: Push
  if (push) {
    output += '### Step 4: Push\n\n';
    try {
      await executeValidatedCommand('git', ['push'], {
        profile: 'advanced_shell',
        dangerous: true,
        source: 'auto_commit_batch',
        caller: 'handleAutoCommitBatch',
        cwd: workingDir,
        timeout: TASK_TIMEOUTS.GIT_PUSH,
        encoding: 'utf8'
      });
      output += `Pushed to remote.\n`;
    } catch (err) {
      output += `Push failed: ${(err.stderr || err.message).trim()}\n`;
    }
  }

  // Summary
  output += `\n### Summary\n\n`;
  output += `- **Tests:** ${testCount} passing\n`;
  output += `- **Files:** ${stagedOutput.split(/\r?\n/).filter(Boolean).length} committed\n`;
  output += `- **Commit:** ${commitMessage}\n`;
  output += `- **Pushed:** ${push ? 'Yes' : 'No'}\n`;

  return { content: [{ type: 'text', text: output }] };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }}

// ─── Feature 12: Extract Feature Spec from Deluge Plan ───────────────────────

function handleExtractFeatureSpec(args) {
  const planPath = args.plan_path;
  if (!planPath) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'plan_path is required (e.g., "/path/to/deluge/docs/plans/plan-14-giving-circles.md")');
  }
  if (!isPathTraversalSafe(planPath)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'plan_path contains path traversal');
  }

  if (!fs.existsSync(planPath)) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Plan file not found: ${planPath}`);
  }

  const planContent = fs.readFileSync(planPath, 'utf8');
  const planFileName = path.basename(planPath, '.md');

  // Extract feature name from filename (plan-14-giving-circles -> GivingCircles)
  const nameFromFile = planFileName
    .replace(/^plan-\d+-/, '')
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');

  const featureName = args.feature_name || nameFromFile;

  // Extract key sections from the plan
  const sections = {};

  // Get overview/description
  const overviewMatch = planContent.match(/## Overview\s*\n+([\s\S]*?)(?=\n##\s|\n---)/);
  sections.overview = overviewMatch ? overviewMatch[1].trim() : '';

  // Extract Prisma schema models (entities)
  const prismaBlocks = [...planContent.matchAll(/```prisma\n([\s\S]*?)```/g)];
  const entities = [];
  for (const block of prismaBlocks) {
    const modelMatches = [...block[1].matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\}/g)];
    for (const m of modelMatches) {
      const modelName = m[1];
      const fields = [];
      const fieldMatches = [...m[2].matchAll(/^\s+(\w+)\s+(String|Int|Float|Boolean|DateTime|Json)(\?)?/gm)];
      for (const f of fieldMatches) {
        fields.push({ name: f[1], type: f[2], optional: !!f[3] });
      }
      entities.push({ name: modelName, fields });
    }
  }

  // Extract enums / status values from prisma models
  const statusValues = [];
  for (const entity of entities) {
    for (const field of entity.fields) {
      if (field.name === 'status' || field.name === 'type' || field.name === 'role') {
        // Look for inline comments describing values
        const commentMatch = planContent.match(new RegExp(`${field.name}\\s+String.*?//\\s*(.+)`));
        if (commentMatch) {
          statusValues.push({ entity: entity.name, field: field.name, values: commentMatch[1].trim() });
        }
      }
    }
  }

  // Extract file references
  const fileRefs = [...planContent.matchAll(/`(src\/[^`]+)`/g)].map(m => m[1]);

  // Build the structured spec
  const spec = {
    feature_name: featureName,
    description: sections.overview,
    entities: entities.map(e => ({
      name: e.name,
      fields: e.fields.map(f => `${f.name}: ${f.type}${f.optional ? '?' : ''}`),
    })),
    status_enums: statusValues,
    file_references: [...new Set(fileRefs)],
  };

  // Generate game-specific adaptation suggestions
  const gameEntities = [];
  const gameEnums = [];
  const gameEvents = [];

  for (const entity of entities) {
    const isMain = entity.fields.length > 5;
    if (isMain) {
      gameEntities.push(entity.name);
      // Convert PascalCase entity name to snake_case for event naming
      const snakeName = entity.name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
      // Generate status-transition events from status/type fields instead of mechanical _created/_completed
      const entityStatuses = statusValues.filter(sv => sv.entity === entity.name && sv.field === 'status');
      if (entityStatuses.length > 0) {
        // Use actual status values for meaningful events
        const vals = entityStatuses[0].values.split(/[,|/]/).map(v => v.trim().toLowerCase()).filter(Boolean);
        for (const val of vals) {
          gameEvents.push(`${snakeName}_${val}`);
        }
      } else {
        // Fallback: generate action-based events from entity purpose
        const hasAmount = entity.fields.some(f => f.name === 'amount' || f.name === 'total');
        const hasDate = entity.fields.some(f => f.name === 'date' || f.name === 'startDate' || f.name === 'endDate');
        gameEvents.push(`${snakeName}_started`);
        if (hasAmount) gameEvents.push(`${snakeName}_funded`);
        if (hasDate) gameEvents.push(`${snakeName}_scheduled`);
        gameEvents.push(`${snakeName}_completed`);
      }
    }
  }

  for (const sv of statusValues) {
    gameEnums.push(`${sv.entity}${sv.field.charAt(0).toUpperCase() + sv.field.slice(1)}: ${sv.values}`);
  }

  // Build types spec
  const typesSpec = entities.map(e => {
    const relevantFields = e.fields.filter(f =>
      !['createdAt', 'updatedAt', 'id'].includes(f.name) &&
      !f.name.endsWith('Id') // skip foreign keys
    );
    return `interface ${e.name} { ${relevantFields.map(f => `${f.name}: ${f.type === 'Float' ? 'number' : f.type === 'Int' ? 'number' : f.type === 'Boolean' ? 'boolean' : f.type === 'DateTime' ? 'number' : f.type === 'Json' ? 'unknown' : 'string'}${f.optional ? ' | null' : ''}`).join('; ')} }`;
  }).join('\n');

  // Build events spec
  const eventsSpec = gameEvents.map(e => `${e}: { id: string; /* key fields */ }`).join('\n');

  let output = `## Feature Spec: ${featureName}\n\n`;
  output += `**Source:** ${planPath}\n`;
  output += `**Description:** ${sections.overview.substring(0, 200)}${sections.overview.length > 200 ? '...' : ''}\n\n`;

  output += `### Entities (${entities.length})\n\n`;
  for (const entity of entities) {
    output += `- **${entity.name}** (${entity.fields.length} fields): ${entity.fields.slice(0, 5).map(f => f.name).join(', ')}${entity.fields.length > 5 ? '...' : ''}\n`;
  }

  output += `\n### Status Enums\n\n`;
  for (const sv of statusValues) {
    output += `- **${sv.entity}.${sv.field}:** ${sv.values}\n`;
  }

  output += `\n### Suggested Game Events\n\n`;
  for (const event of gameEvents) {
    output += `- ${event}\n`;
  }

  output += `\n### Ready-to-Use Parameters\n\n`;
  output += 'Pass these directly to `generate_feature_tasks` or `run_batch`:\n\n';
  output += '```json\n';
  output += JSON.stringify({
    feature_name: featureName,
    feature_description: sections.overview.substring(0, 500),
    types_spec: typesSpec,
    events_spec: eventsSpec,
  }, null, 2);
  output += '\n```\n';

  return {
    content: [{ type: 'text', text: output }],
    _spec: spec,
    _params: {
      feature_name: featureName,
      feature_description: sections.overview.substring(0, 500),
      types_spec: typesSpec,
      events_spec: eventsSpec,
    },
  };
}

// ─── Feature 13: Plan Next Batch ─────────────────────────────────────────────

function handlePlanNextBatch(args) {
  const headwatersPath = args.headwaters_path || args.working_directory || process.cwd();
  const delugePath = args.deluge_path;
  const count = Math.min(Math.max(args.count || 3, 1), 10);

  if (!delugePath) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'deluge_path is required');
  }

  // Step 1: Get or refresh gap analysis
  handleCacheFeatureGaps({
    headwaters_path: headwatersPath,
    deluge_path: delugePath,
  });

  // Parse the cached data
  const cacheFile = path.join(CACHE_DIR, 'feature-gaps.json');
  let cacheData;
  try {
    cacheData = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } catch {
    return makeError(ErrorCodes.OPERATION_FAILED, 'Could not read feature gap cache. Run cache_feature_gaps first.');
  }

  // Step 2: Score and rank gaps
  const recommendations = [];

  for (const gap of cacheData.gaps) {
    if (gap.source !== 'plan') continue; // Only recommend features with plan docs

    const planFile = path.join(delugePath, gap.path);
    if (!fs.existsSync(planFile)) continue;

    let planContent = '';
    try {
      planContent = fs.readFileSync(planFile, 'utf8');
    } catch { continue; }

    // Score based on:
    // 1. Has Prisma schema (well-defined data model) = +3
    // 2. Has clear phases = +2
    // 3. Document size (longer = more thorough) = +1 per 1000 chars, max 3
    // 4. References existing Headwaters concepts (loans, drops, etc.) = +2
    let score = 0;

    const hasPrisma = planContent.includes('```prisma');
    if (hasPrisma) score += 3;

    const phaseCount = (planContent.match(/## Phase \d/g) || []).length;
    if (phaseCount >= 2) score += 2;

    score += Math.min(3, Math.floor(planContent.length / 1000));

    const gameTerms = ['drops', 'ripples', 'cascade', 'watershed', 'community', 'loan', 'project'];
    const termMatches = gameTerms.filter(t => planContent.toLowerCase().includes(t)).length;
    if (termMatches >= 2) score += 2;

    // Extract a brief description
    const overviewMatch = planContent.match(/## Overview\s*\n+([\s\S]*?)(?=\n##\s|\n---)/);
    const overview = overviewMatch ? overviewMatch[1].trim().substring(0, 200) : '';

    // Extract feature name from filename
    const planFileName = path.basename(planFile, '.md');
    const featureName = planFileName
      .replace(/^plan-\d+-/, '')
      .split('-')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join('');

    // Count Prisma models (complexity estimate)
    const modelCount = (planContent.match(/^model\s+/gm) || []).length;

    recommendations.push({
      featureName,
      planFile: gap.path,
      fullPlanPath: planFile,
      score,
      overview,
      hasPrisma,
      phaseCount,
      modelCount,
      termMatches,
    });
  }

  // Sort by score descending
  recommendations.sort((a, b) => b.score - a.score);
  const topPicks = recommendations.slice(0, count);

  let output = `## Next Batch Recommendations\n\n`;
  output += `**Existing systems:** ${cacheData.existingSystems.length}\n`;
  output += `**Unimplemented features:** ${cacheData.gaps.length}\n`;
  output += `**Scored candidates:** ${recommendations.length}\n\n`;

  if (topPicks.length === 0) {
    output += 'No suitable features found with plan documentation.\n';
    return { content: [{ type: 'text', text: output }] };
  }

  output += `### Top ${topPicks.length} Recommendations\n\n`;

  for (let i = 0; i < topPicks.length; i++) {
    const rec = topPicks[i];
    output += `#### ${i + 1}. ${rec.featureName} (score: ${rec.score})\n`;
    output += `- **Plan:** ${rec.planFile}\n`;
    output += `- **Prisma models:** ${rec.modelCount || 'none'} | **Phases:** ${rec.phaseCount} | **Game terms:** ${rec.termMatches}\n`;
    output += `- **Overview:** ${rec.overview}${rec.overview.length >= 200 ? '...' : ''}\n\n`;
  }

  // Generate ready-to-use commands
  output += '### Quick Start\n\n';
  output += 'Extract spec and run batch for the top pick:\n\n';
  output += '```\n';
  output += `1. extract_feature_spec({ plan_path: "${topPicks[0].fullPlanPath.replace(/\\/g, '/')}" })\n`;
  output += `2. run_batch({ working_directory: "${headwatersPath.replace(/\\/g, '/')}", feature_name: "${topPicks[0].featureName}", ... })\n`;
  output += '```\n';

  return {
    content: [{ type: 'text', text: output }],
    _recommendations: topPicks,
  };
}

// ─── Phase 5: Final Automation Tools ────────────────────────────────────────

/**
 * End-to-end batch orchestration: plan -> spec -> batch -> wire -> commit -> stats.
 * Single tool call replaces an entire conversation of sequential tool invocations.
 */
async function handleRunFullBatch(args) {
  try {
  
  const workDir = args.working_directory;
  const delugePath = args.deluge_path;
  if (!workDir) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory is required');
  }
  
  if (!isPathTraversalSafe(workDir)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'working_directory contains path traversal');
  }

  const featureName = args.feature_name;       // Optional: skip planning, use this feature directly
  const planPath = args.plan_path;             // Optional: skip planning, use this plan doc
  if (planPath && !isPathTraversalSafe(planPath)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'plan_path contains path traversal');
  }
  const spec = args.spec;                       // Optional: skip extraction, use this spec
  const batchLabel = args.batch_label;          // Optional: custom batch label
  const skipPlan = !!featureName || !!planPath;
  const skipSpec = !!spec;
  const autoCommit = args.auto_commit !== false;
  const _push = args.push !== false;
  const provider = args.provider || 'codex';

  // Merge saved step_providers with per-call overrides (per-call wins)
  const project = projectConfigCore().getProjectFromPath(workDir);
  const savedStepProviders = (() => {
    try { return JSON.parse(projectConfigCore().getProjectMetadata(project, 'step_providers') || '{}'); }
    catch { return {}; }
  })();
  const stepProviders = { ...savedStepProviders, ...(args.step_providers || {}) };

  try {
    let output = '## Run Full Batch\n\n';
    let resolvedFeatureName = featureName;
    let resolvedSpec = spec;

    // Step 1: Plan (unless feature_name or plan_path provided)
    if (!skipPlan && delugePath) {
      output += '### Step 1: Planning next batch...\n\n';
      const planResult = handlePlanNextBatch({
        headwaters_path: workDir,
        deluge_path: delugePath,
        count: 1,
      });
      if (planResult?.isError) {
        return makeError(
          ErrorCodes.INTERNAL_ERROR,
          `Planning step failed: ${planResult.content?.[0]?.text || 'unknown error'}`
        );
      }
      const planText = planResult.content?.[0]?.text || '';
      output += planText + '\n\n';

      // Extract top recommendation
      const featureMatch = planText.match(/\*\*Feature:\*\*\s*`?(\w+)`?/);
      const planPathMatch = planText.match(/\*\*Plan:\*\*\s*`?([^`\n]+)`?/);
      if (featureMatch) resolvedFeatureName = featureMatch[1];
      if (planPathMatch && !planPath) {
        // Use extracted plan path for spec extraction
        const extractedPlanPath = planPathMatch[1].trim();
        if (!skipSpec && fs.existsSync(extractedPlanPath)) {
          output += '### Step 2: Extracting spec...\n\n';
          const specResult = handleExtractFeatureSpec({
            plan_path: extractedPlanPath,
            feature_name: resolvedFeatureName,
          });
          if (specResult?.isError) {
            return makeError(
              ErrorCodes.INTERNAL_ERROR,
              `Spec extraction failed: ${specResult.content?.[0]?.text || 'unknown error'}`
            );
          }
          const specText = specResult.content?.[0]?.text || '';
          output += specText + '\n\n';
          if (specResult._spec) resolvedSpec = specResult._spec;
        }
      }
    } else if (planPath && !skipSpec) {
      output += '### Step 1: Extracting spec from plan...\n\n';
      const specResult = handleExtractFeatureSpec({
        plan_path: planPath,
        feature_name: resolvedFeatureName,
      });
      if (specResult?.isError) {
        return makeError(
          ErrorCodes.INTERNAL_ERROR,
          `Spec extraction failed: ${specResult.content?.[0]?.text || 'unknown error'}`
        );
      }
      const specText = specResult.content?.[0]?.text || '';
      output += specText + '\n\n';
      if (specResult._spec) resolvedSpec = specResult._spec;
      if (specResult._params?.feature_name && !resolvedFeatureName) {
        resolvedFeatureName = specResult._params.feature_name;
      }
    }

    if (!resolvedFeatureName) {
      output += '\n**Error:** Could not determine feature name. Provide `feature_name`, `plan_path`, or `deluge_path` for auto-planning.\n';
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, output);
    }

    // Step 3: Run batch (generate tasks + create workflow + execute)
    output += `### Step 3: Running batch for ${resolvedFeatureName}...\n\n`;
    const batchResult = await handleRunBatch({
      working_directory: workDir,
      feature_name: resolvedFeatureName,
      spec: resolvedSpec || `Implement ${resolvedFeatureName} system`,
      provider,
      step_providers: stepProviders,
      batch_name: batchLabel || `Full Batch — ${resolvedFeatureName}System`,
    });
    if (batchResult?.isError) {
      return makeError(
        ErrorCodes.INTERNAL_ERROR,
        `Batch run failed: ${batchResult.content?.[0]?.text || 'unknown error'}`
      );
    }
    const batchText = batchResult.content?.[0]?.text || '';
    output += batchText + '\n\n';

    // Extract workflow ID for monitoring
    const wfMatch = batchText.match(/Workflow ID:\s*`?([a-f0-9-]+)`?/i) || batchText.match(/workflow_id.*?([a-f0-9-]{36})/i);
    const workflowId = wfMatch ? wfMatch[1] : null;

    output += '### Next Steps\n\n';
    output += `1. Monitor workflow: \`workflow_status({ workflow_id: "${workflowId || '...'}" })\`\n`;
    output += `2. Or use: \`await_workflow({ workflow_id: "${workflowId || '...'}" })\`\n`;
    output += `3. After completion, wire the system:\n`;
    output += `   - \`wire_system_to_gamescene({ working_directory: "${workDir}", system_name: "${resolvedFeatureName}" })\`\n`;
    output += `   - \`wire_events_to_eventsystem({ ... })\`\n`;
    output += `   - \`wire_notifications_to_bridge({ ... })\`\n`;
    if (autoCommit) {
      output += `4. Commit: \`auto_commit_batch({ working_directory: "${workDir}", batch_name: "${batchLabel || resolvedFeatureName}" })\`\n`;
    }

    return {
      content: [{ type: 'text', text: output }],
      _workflow_id: workflowId,
      _feature_name: resolvedFeatureName,
    };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, `Run full batch failed: ${err?.message}`);
  }
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }}

async function handleContinuousBatchSubmission(completedWorkflowId, workflowData, deps = {}) {
  const database = deps.db || db();
  const log = deps.logger || logger;
  const planNextBatch = deps.handlePlanNextBatch || handlePlanNextBatch;
  const runBatch = deps.handleRunBatch || handleRunBatch;

  try {
    if (database.getConfig('continuous_batch_enabled') !== '1') {
      return null;
    }

    const workingDir = workflowData?.working_directory || database.getConfig('continuous_batch_working_directory');
    const delugePath = database.getConfig('continuous_batch_deluge_path');

    if (!workingDir || !delugePath) {
      log.warn('[Continuous Batch] Missing working_directory or deluge_path; skipping submission');
      return null;
    }

    const planResult = await planNextBatch({
      working_directory: workingDir,
      deluge_path: delugePath,
      count: 1,
    });
    const recommendation = planResult?._recommendations?.[0];

    if (!recommendation) {
      log.info('No features available for continuous batch');
      return null;
    }

    const rawStepProviders = database.getConfig('continuous_batch_step_providers');
    let stepProviders;
    if (rawStepProviders) {
      try { stepProviders = JSON.parse(rawStepProviders); } catch { stepProviders = undefined; }
    }

    const runResult = await runBatch({
      working_directory: workingDir,
      feature_name: recommendation.featureName,
      step_providers: stepProviders,
      batch_name: `auto-batch-${recommendation.featureName}`,
    });
    const workflowId = runResult?._workflow_id;

    database.recordEvent('continuous_batch_submitted', completedWorkflowId, {
      next_workflow_id: workflowId,
      feature_name: recommendation.featureName,
      score: recommendation.score,
    });
    log.info(`[Continuous Batch] Submitted ${recommendation.featureName} as workflow ${workflowId}`);

    return {
      workflow_id: workflowId,
      feature_name: recommendation.featureName,
    };
  } catch (err) {
    log.warn('[Continuous Batch] Failed to submit next batch:', err?.message || err);
    return null;
  }
}

function createAutomationBatchOrchestration() {
  return {
    handleGenerateFeatureTasks,
    handleCacheFeatureGaps,
    handleRunBatch,
    handleDetectFileConflicts,
    handleAutoCommitBatch,
    handleExtractFeatureSpec,
    handlePlanNextBatch,
    handleRunFullBatch,
    handleContinuousBatchSubmission,
  };
}

module.exports = {
  handleGenerateFeatureTasks,
  handleCacheFeatureGaps,
  handleRunBatch,
  handleDetectFileConflicts,
  handleAutoCommitBatch,
  handleExtractFeatureSpec,
  handlePlanNextBatch,
  handleRunFullBatch,
  handleContinuousBatchSubmission,
  createAutomationBatchOrchestration,
};
