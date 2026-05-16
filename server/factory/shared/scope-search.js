// Scope-search helpers: given a work item and an optional project path,
// determine which files belong "in scope" for plan generation and EXECUTE
// routing. Pure module — no DB, no shared state. fs is used only for
// read-only project-tree walks.
//
// Extracted from server/factory/loop-controller.js as part of Phase 1a-prep
// of the god-object refactor. Behavior preserved; no signature changes.
//
// Depends on:
//   shared/plan-path        — normalize/filter path utilities + ext sets
//   shared/planner-tokens   — affinity tokenizers
//   shared/workitem-accessors — origin/constraints unpackers

const fs = require('fs');
const path = require('path');

const {
  PLAN_RELATED_FILE_EXT_RE,
  PLAN_RELATED_SKIP_DIRS,
  PLAN_RELATED_GENERATED_ARTIFACT_RE,
  isInternalTempWorktreePlanPath,
  getRequestedPlanLanguageFamilies,
  isLanguageCompatibleRelatedFile,
  normalizePlanProjectRelativePath,
  projectFileExists,
  addNormalizedPlanPath,
  extractPlanDescriptionFilePaths,
} = require('./plan-path');

const {
  buildPlannerTitleAffinityTokens,
  tokenizePlannerPathForAffinity,
  buildPlannerFileSearchTokens,
  normalizePlannerAffinityToken,
  PLAN_RELATED_GENERIC_PATH_TOKENS,
} = require('./planner-tokens');

const {
  getWorkItemOriginObject,
  getWorkItemConstraintsObject,
} = require('./workitem-accessors');

function escapeRegExpLiteral(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isPlanTestPath(filePath) {
  return /(?:^|\/)(?:tests?|__tests__)\//i.test(filePath)
    || /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(filePath);
}

function collectArchitectHardScopeFiles(workItem) {
  const out = new Set();
  const push = (value) => {
    if (typeof value === 'string' && value.trim()) {
      out.add(value.trim());
    }
  };
  const pushAll = (arr) => {
    if (Array.isArray(arr)) arr.forEach(push);
  };

  const origin = getWorkItemOriginObject(workItem);
  pushAll(origin.allowed_files);
  pushAll(getWorkItemConstraintsObject(workItem).allowed_files);

  return Array.from(out);
}

function collectWorkItemDescriptionFiles(workItem) {
  return extractPlanDescriptionFilePaths(`${workItem?.title || ''}\n${workItem?.description || ''}`);
}

function hasTitleAnchorPathAffinity(filePath, workItem, seedFiles = []) {
  const candidates = (seedFiles || [])
    .map((file) => String(file || '').replace(/\\/g, '/'))
    .filter(Boolean);
  if (candidates.length > 0) return true;

  const titleTokens = new Set(buildPlannerTitleAffinityTokens(workItem));
  if (titleTokens.size === 0) return true;

  const fileTokens = new Set(tokenizePlannerPathForAffinity(filePath));
  if (fileTokens.size === 0) return false;

  for (const token of fileTokens) {
    if (titleTokens.has(token)) return true;
  }
  return false;
}

function hasCandidatePathAffinity(filePath, seedFiles = []) {
  const candidates = (seedFiles || [])
    .map((file) => String(file || '').replace(/\\/g, '/'))
    .filter(Boolean);
  if (candidates.length === 0) return true;

  const fileTokens = new Set(tokenizePlannerPathForAffinity(filePath));
  if (fileTokens.size === 0) return false;

  const candidateTokens = new Set();
  for (const candidate of candidates) {
    for (const token of tokenizePlannerPathForAffinity(candidate)) {
      candidateTokens.add(token);
    }
  }
  if (candidateTokens.size === 0) return true;

  let overlap = 0;
  for (const token of fileTokens) {
    if (candidateTokens.has(token)) overlap += 1;
  }
  return overlap >= 2;
}

function shouldIncludeRelatedPlannerFile(filePath, workItem, seedFiles = []) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  if (!normalized) return false;
  if (PLAN_RELATED_GENERATED_ARTIFACT_RE.test(normalized)) return false;
  if (isInternalTempWorktreePlanPath(normalized)) return false;
  const requestedFamilies = getRequestedPlanLanguageFamilies(workItem, seedFiles);
  if (!isLanguageCompatibleRelatedFile(normalized, requestedFamilies)) return false;
  if (!hasTitleAnchorPathAffinity(normalized, workItem, seedFiles)) return false;
  return hasCandidatePathAffinity(normalized, seedFiles);
}

function findUniqueProjectFileByBasename(projectPath, filePath) {
  const raw = String(filePath || '').trim().replace(/^`|`$/g, '').replace(/\\/g, '/');
  if (!projectPath || !raw || /[\\/]/.test(raw)) return null;
  const basename = path.posix.basename(raw).toLowerCase();
  if (!basename || !/\.[A-Za-z0-9]+$/.test(basename)) return null;

  const root = path.resolve(projectPath);
  const matches = [];
  let visited = 0;
  const walk = (dir) => {
    if (visited > 12000 || matches.length > 1) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_err) {
      return;
    }

    for (const entry of entries) {
      if (PLAN_RELATED_SKIP_DIRS.has(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      visited += 1;
      if (entry.name.toLowerCase() === basename) {
        matches.push(path.relative(root, absolute).replace(/\\/g, '/'));
        if (matches.length > 1) return;
      }
    }
  };

  walk(root);
  return matches.length === 1 ? matches[0] : null;
}

function collectPriorMissingTargetFiles(workItem) {
  const origin = getWorkItemOriginObject(workItem);
  const sources = [
    origin.last_gate_feedback,
    origin.last_rejection_details?.feedback_prompt,
    origin.last_rejection_details?.message,
  ].filter((value) => typeof value === 'string' && value.trim());
  const out = new Set();
  const missingTargetRe = /missing target file\(s\):\s*([^\n]+)/gi;
  for (const source of sources) {
    missingTargetRe.lastIndex = 0;
    for (const match of source.matchAll(missingTargetRe)) {
      const targetList = String(match[1] || '')
        .replace(/\s+Existing nearby candidate\(s\):.*$/i, '')
        .replace(/\s+Pick existing repository files.*$/i, '')
        .replace(/\s+Choose existing repository files.*$/i, '')
        .replace(/\s+Use existing repository files.*$/i, '');
      for (const raw of targetList.split(',')) {
        const cleaned = raw.trim().replace(/^[`'"]+|[`'",.;:)]+$/g, '');
        const normalized = normalizePlanProjectRelativePath(cleaned, null);
        if (normalized) out.add(normalized);
      }
    }
  }
  return Array.from(out);
}

function tokenizeReplacementPath(filePath) {
  return String(filePath || '')
    .replace(/\\/g, '/')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/g)
    .map(normalizePlannerAffinityToken)
    .filter((token) => token.length >= 3 && !PLAN_RELATED_GENERIC_PATH_TOKENS.has(token));
}

function discoverExistingFileAlternates(projectPath, missingPath, limit = 4) {
  if (!projectPath || !missingPath) return [];
  const root = path.resolve(projectPath);
  if (!fs.existsSync(root)) return [];

  const normalizedMissing = normalizePlanProjectRelativePath(missingPath, null);
  if (!normalizedMissing) return [];
  const missingAbsolute = path.resolve(root, normalizedMissing);
  if (missingAbsolute.startsWith(root + path.sep) && fs.existsSync(missingAbsolute)) {
    return [];
  }

  const missingDir = path.posix.dirname(normalizedMissing).toLowerCase();
  const missingExt = path.extname(normalizedMissing).toLowerCase();
  const missingStem = path.posix.basename(normalizedMissing, missingExt).toLowerCase();
  const missingSegments = normalizedMissing.toLowerCase().split('/').filter(Boolean);
  const missingTokens = new Set(tokenizeReplacementPath(normalizedMissing));
  const scored = [];
  const seen = new Set();
  const addCandidate = (rel, baseScore = 0) => {
    const normalized = normalizePlanProjectRelativePath(rel, null);
    if (!normalized || seen.has(normalized)) return;
    const absolute = path.resolve(root, normalized);
    if (!absolute.startsWith(root + path.sep) && absolute !== root) return;
    if (!fs.existsSync(absolute)) return;
    seen.add(normalized);
    const relLower = normalized.toLowerCase();
    const candidateExt = path.extname(relLower);
    const candidateStem = path.posix.basename(relLower, candidateExt);
    const candidateDir = path.posix.dirname(relLower);
    const candidateSegments = relLower.split('/').filter(Boolean);
    const candidateTokens = new Set(tokenizeReplacementPath(relLower));
    let score = baseScore;
    if (candidateStem === missingStem) score += 60;
    if (candidateDir === missingDir) score += 24;
    if (candidateExt === missingExt) score += 8;
    if (candidateSegments[0] && candidateSegments[0] === missingSegments[0]) score += 6;
    if (candidateSegments[1] && candidateSegments[1] === missingSegments[1]) score += 10;
    for (const token of candidateTokens) {
      if (missingTokens.has(token)) score += 8;
    }
    scored.push({ file: normalized, score });
  };

  const alternateExts = ['.js', '.json', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'];
  if (missingExt) {
    for (const ext of alternateExts) {
      if (ext === missingExt) continue;
      addCandidate(`${normalizedMissing.slice(0, -missingExt.length)}${ext}`, 240);
    }
  }

  let visited = 0;
  const walk = (dir) => {
    if (visited > 12000) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_err) {
      return;
    }
    for (const entry of entries) {
      if (PLAN_RELATED_SKIP_DIRS.has(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      visited += 1;
      if (!PLAN_RELATED_FILE_EXT_RE.test(entry.name)) continue;
      const rel = path.relative(root, absolute).replace(/\\/g, '/');
      const candidateTokens = new Set(tokenizeReplacementPath(rel));
      let overlap = 0;
      for (const token of candidateTokens) {
        if (missingTokens.has(token)) overlap += 1;
      }
      const relLower = rel.toLowerCase();
      const sameTop = missingSegments[0] && relLower.startsWith(`${missingSegments[0]}/`);
      if (overlap > 0 || sameTop) {
        addCandidate(rel, overlap * 40);
      }
    }
  };

  walk(root);
  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .map((entry) => entry.file)
    .filter((file, index, arr) => arr.indexOf(file) === index)
    .slice(0, limit);
}

function collectPriorMissingTargetResolutionHints(workItem, projectPath = null, limit = 6) {
  if (!projectPath) return [];
  return collectPriorMissingTargetFiles(workItem)
    .map((missing) => ({
      missing,
      candidates: discoverExistingFileAlternates(projectPath, missing),
    }))
    .filter((hint) => hint.candidates.length > 0)
    .slice(0, limit);
}

function collectOriginScopeFiles(workItem) {
  const out = new Set();
  const push = (value) => {
    if (typeof value === 'string' && value.trim()) {
      out.add(value.trim());
    }
  };
  const pushAll = (arr) => {
    if (Array.isArray(arr)) arr.forEach(push);
  };

  const origin = getWorkItemOriginObject(workItem);
  pushAll(origin.exemplar_files);
  pushAll(collectArchitectHardScopeFiles(workItem));
  if (Array.isArray(origin.shared_dependencies)) {
    for (const dep of origin.shared_dependencies) {
      if (typeof dep === 'string') {
        push(dep);
      } else if (dep && typeof dep === 'object') {
        push(dep.file);
      }
    }
  }

  return Array.from(out);
}

function collectArchitectScopeDetails(workItem, projectPath = null) {
  const originFiles = collectOriginScopeFiles(workItem);
  const descriptionFiles = collectWorkItemDescriptionFiles(workItem);
  const hardScopeFiles = collectArchitectHardScopeFiles(workItem);
  const priorMissingTargetHints = collectPriorMissingTargetResolutionHints(workItem, projectPath);
  const verified = new Set();
  const candidates = new Set();
  const hardScope = new Set();

  for (const file of hardScopeFiles) {
    addNormalizedPlanPath(hardScope, file, projectPath);
  }

  const addScopeFile = (file, trustExisting = false) => {
    const normalized = normalizePlanProjectRelativePath(file, projectPath);
    if (!normalized) return;
    if (!projectPath || trustExisting || projectFileExists(projectPath, normalized)) {
      verified.add(normalized);
    } else {
      candidates.add(normalized);
    }
  };

  for (const file of originFiles) addScopeFile(file, true);
  for (const file of descriptionFiles) addScopeFile(file, false);

  const hintedFiles = priorMissingTargetHints.flatMap((hint) => hint.candidates);
  const relatedFiles = [
    ...hintedFiles,
    ...discoverRelatedProjectFiles(projectPath, workItem, [
      ...verified,
      ...candidates,
      ...hintedFiles,
    ]),
  ].filter((file, index, arr) => !verified.has(file) && arr.indexOf(file) === index);

  return {
    scopeFiles: Array.from(verified),
    candidateFiles: Array.from(candidates),
    hardScopeFiles: Array.from(hardScope),
    relatedFiles,
    priorMissingTargetHints,
  };
}

function collectArchitectScopeFiles(workItem, projectPath = null) {
  return collectArchitectScopeDetails(workItem, projectPath).scopeFiles;
}

function discoverRelatedProjectFiles(projectPath, workItem, seedFiles = [], limit = 8) {
  if (!projectPath) return [];
  const root = path.resolve(projectPath);
  if (!fs.existsSync(root)) return [];

  const tokens = buildPlannerFileSearchTokens(workItem, seedFiles);
  if (tokens.length === 0) return [];

  const workText = `${workItem?.title || ''}\n${workItem?.description || ''}`.toLowerCase();
  const scored = [];
  let visited = 0;

  const walk = (dir) => {
    if (visited > 12000) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_err) {
      return;
    }

    for (const entry of entries) {
      if (PLAN_RELATED_SKIP_DIRS.has(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      visited += 1;
      if (!PLAN_RELATED_FILE_EXT_RE.test(entry.name)) continue;

      const rel = path.relative(root, absolute).replace(/\\/g, '/');
      if (!shouldIncludeRelatedPlannerFile(rel, workItem, seedFiles)) continue;
      const relLower = rel.toLowerCase();
      const baseLower = path.basename(relLower);
      let score = 0;
      for (const token of tokens) {
        if (relLower.includes(token)) score += baseLower.includes(token) ? 6 : 3;
      }
      if (workText.includes('workflow') && workText.includes('runtime')
        && relLower.includes('workflow') && relLower.includes('runtime')) {
        score += 20;
      }
      if (workText.includes('debugger') && relLower.includes('debugger')) score += 10;
      if (workText.includes('protocol') && relLower.includes('protocol')) score += 8;
      if (/(?:test|coverage|vitest|jest)/.test(workText) && /(?:^|\/)(?:tests?|__tests__)\//.test(relLower)) {
        score += 8;
      }
      if (/(?:runtime|runner|execution)/.test(workText) && /(?:^|\/)execution\//.test(relLower)) {
        score += 10;
      }
      if (score > 0) {
        scored.push({ file: rel, score });
      }
    }
  };

  walk(root);
  return scored
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .map((entry) => entry.file)
    .filter((file, index, arr) => arr.indexOf(file) === index)
    .slice(0, limit);
}

function chooseRelatedReplacementFile(originalFile, relatedFiles = [], workItem = null) {
  const original = String(originalFile || '').replace(/\\/g, '/');
  const originalLower = original.toLowerCase();
  const workText = `${workItem?.title || ''}\n${workItem?.description || ''}`.toLowerCase();
  const originalIsTest = isPlanTestPath(originalLower);
  const originalExt = path.extname(originalLower);
  const candidates = relatedFiles
    .map((file) => String(file || '').replace(/\\/g, '/'))
    .filter((file) => file && file.toLowerCase() !== originalLower);

  const sameKind = candidates.filter((file) => isPlanTestPath(file) === originalIsTest);
  const sameExtension = sameKind.filter((file) => !originalExt || path.extname(file).toLowerCase() === originalExt);
  let pool = sameExtension.length > 0 ? sameExtension : sameKind;
  if (pool.length === 0) {
    pool = originalIsTest
      ? candidates.filter((file) => isPlanTestPath(file))
      : candidates.filter((file) => !isPlanTestPath(file));
  }
  if (pool.length === 0) pool = candidates;
  if (pool.length === 0) return null;

  return pool
    .map((file) => {
      const lower = file.toLowerCase();
      let score = 0;
      if (workText.includes('workflow') && lower.includes('workflow')) score += 5;
      if (workText.includes('runtime') && lower.includes('runtime')) score += 12;
      if (/(?:runtime|runner|execution)/.test(workText) && /(?:^|\/)execution\//.test(lower)) score += 8;
      if (workText.includes('debugger') && lower.includes('debugger')) score += 6;
      if (workText.includes('protocol') && lower.includes('protocol')) score += 6;
      if (originalIsTest && isPlanTestPath(lower)) score += 8;
      if (!originalIsTest && !isPlanTestPath(lower)) score += 4;
      return { file, score };
    })
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))[0]?.file || null;
}

module.exports = {
  escapeRegExpLiteral,
  isPlanTestPath,
  collectArchitectHardScopeFiles,
  collectWorkItemDescriptionFiles,
  hasTitleAnchorPathAffinity,
  hasCandidatePathAffinity,
  shouldIncludeRelatedPlannerFile,
  findUniqueProjectFileByBasename,
  collectPriorMissingTargetFiles,
  discoverExistingFileAlternates,
  collectPriorMissingTargetResolutionHints,
  collectOriginScopeFiles,
  collectArchitectScopeDetails,
  collectArchitectScopeFiles,
  discoverRelatedProjectFiles,
  chooseRelatedReplacementFile,
};
