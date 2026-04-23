'use strict';

const fs = require('fs');
const path = require('path');

function hasDescriptionPatterns(value) {
  return Array.isArray(value) && value.length > 0;
}

function collectTaskDescription(context = {}) {
  const task = context.task || {};
  const rawDescription = context.task_description
    || task.task_description
    || context.description
    || task.description
    || '';
  return typeof rawDescription === 'string'
    ? rawDescription
    : String(rawDescription);
}

function hasProjectFile(projectPath, filePattern) {
  if (!projectPath) return false;

  const normalizedFile = String(filePattern || '').trim();
  if (!normalizedFile) return false;

  const candidate = path.isAbsolute(normalizedFile)
    ? normalizedFile
    : path.join(projectPath, normalizedFile);
  return fs.existsSync(candidate);
}

function normalizeArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value.filter((entry) => entry !== undefined && entry !== null) : [value];
}

function normalizeStringArray(value) {
  return normalizeArray(value)
    .map((entry) => String(entry).trim())
    .filter(Boolean);
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '').trim();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegExp(glob) {
  const normalized = normalizePath(glob);
  let pattern = '^';

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    const afterNext = normalized[index + 2];

    if (char === '*') {
      if (next === '*') {
        if (afterNext === '/') {
          pattern += '(?:.*/)?';
          index += 2;
        } else {
          pattern += '.*';
          index += 1;
        }
      } else {
        pattern += '[^/]*';
      }
      continue;
    }

    if (char === '?') {
      pattern += '[^/]';
      continue;
    }

    if (char === '{') {
      const end = normalized.indexOf('}', index + 1);
      if (end > index + 1) {
        const parts = normalized.slice(index + 1, end)
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean)
          .map((part) => escapeRegex(part));
        if (parts.length > 0) {
          pattern += `(?:${parts.join('|')})`;
          index = end;
          continue;
        }
      }
    }

    if (char === '/') {
      pattern += '/';
      continue;
    }

    pattern += escapeRegex(char);
  }

  pattern += '$';
  return new RegExp(pattern, 'i');
}

function matchesGlob(candidate, glob) {
  const normalizedCandidate = normalizePath(candidate);
  if (!normalizedCandidate) return false;
  return globToRegExp(glob).test(normalizedCandidate);
}

function matchesAnyGlob(candidate, globs) {
  return normalizeStringArray(globs).some((glob) => matchesGlob(candidate, glob));
}

function extractChangedFiles(context = {}) {
  const direct = context.changed_files ?? context.changedFiles ?? context.files;
  if (Array.isArray(direct)) {
    return direct.map(normalizePath).filter(Boolean);
  }

  if (Array.isArray(context.task?.files_modified)) {
    return context.task.files_modified.map(normalizePath).filter(Boolean);
  }

  if (Array.isArray(context.evidence?.changed_files)) {
    return context.evidence.changed_files.map(normalizePath).filter(Boolean);
  }

  return null;
}

function extractProjectPath(context = {}) {
  const candidate = context.project_path
    || context.projectPath
    || context.working_directory
    || context.workingDirectory
    || context.task?.working_directory
    || context.task?.workingDirectory
    || null;
  return candidate ? normalizePath(candidate) : null;
}

function extractProvider(context = {}) {
  const candidate = context.provider
    || context.provider_id
    || context.providerId
    || context.task?.provider
    || null;
  return candidate ? String(candidate).trim().toLowerCase() : null;
}

function extractTargetType(context = {}) {
  const candidate = context.target_type
    || context.targetType
    || context.target?.type
    || null;
  return candidate ? String(candidate).trim().toLowerCase() : null;
}

function filterExcludedFiles(files, matcher) {
  const excludeGlobs = normalizeStringArray(matcher.exclude_globs_any || matcher.excludeGlobsAny);
  if (!excludeGlobs.length) {
    return {
      files,
      excluded_files: [],
    };
  }

  const includedFiles = [];
  const excludedFiles = [];
  for (const file of files) {
    if (matchesAnyGlob(file, excludeGlobs)) {
      excludedFiles.push(file);
    } else {
      includedFiles.push(file);
    }
  }

  return {
    files: includedFiles,
    excluded_files: excludedFiles,
  };
}

function normalizeMatcherDefinition(matcher = {}) {
  const normalizedMatcher = matcher && typeof matcher === 'object'
    ? { ...matcher }
    : {};
  const matcherType = String(normalizedMatcher.type || '').trim().toLowerCase();

  if (matcherType === 'path_glob') {
    const patterns = normalizeStringArray(
      normalizedMatcher.patterns
        || normalizedMatcher.pattern
        || normalizedMatcher.path_globs
        || normalizedMatcher.pathGlobs
        || normalizedMatcher.globs,
    );
    if (
      patterns.length > 0
      && !normalizedMatcher.changed_file_globs_any
      && !normalizedMatcher.changedFileGlobsAny
    ) {
      normalizedMatcher.changed_file_globs_any = patterns;
    }
  }

  return normalizedMatcher;
}

function evaluateMatcher(matcher = {}, context = {}) {
  const normalizedMatcher = normalizeMatcherDefinition(matcher);
  const changedFiles = extractChangedFiles(context);
  const projectPath = extractProjectPath(context);
  const provider = extractProvider(context);
  const targetType = extractTargetType(context);

  const changedFileGlobsAny = normalizeStringArray(
    normalizedMatcher.changed_file_globs_any || normalizedMatcher.changedFileGlobsAny,
  );
  const changedFileGlobsAll = normalizeStringArray(
    normalizedMatcher.changed_file_globs_all || normalizedMatcher.changedFileGlobsAll,
  );
  const changedFileGlobsNone = normalizeStringArray(
    normalizedMatcher.changed_file_globs_none || normalizedMatcher.changedFileGlobsNone,
  );
  const rootGlobsAny = normalizeStringArray(
    normalizedMatcher.root_globs_any || normalizedMatcher.rootGlobsAny,
  );
  const providersAny = normalizeStringArray(
    normalizedMatcher.providers_any
      || normalizedMatcher.provider_any
      || normalizedMatcher.allowed_providers_any
      || normalizedMatcher.allowedProvidersAny
      || normalizedMatcher.providers_in
      || normalizedMatcher.provider_in,
  ).map((entry) => entry.toLowerCase());
  const providersNotAny = normalizeStringArray(
    normalizedMatcher.providers_not_any
      || normalizedMatcher.disallowed_providers_any
      || normalizedMatcher.disallowedProvidersAny,
  ).map((entry) => entry.toLowerCase());
  const targetTypesAny = normalizeStringArray(
    normalizedMatcher.target_types_any || normalizedMatcher.targetTypesAny,
  ).map((entry) => entry.toLowerCase());
  const projectHasFileAny = normalizeStringArray(
    normalizedMatcher.project_has_file || normalizedMatcher.projectHasFile,
  );
  const descriptionMatches = normalizeStringArray(
    normalizedMatcher.description_matches || normalizedMatcher.descriptionMatches,
  );

  if (rootGlobsAny.length > 0) {
    if (!projectPath) {
      return {
        state: 'degraded',
        reason: 'project path is unavailable for matcher evaluation',
        matched_files: [],
        excluded_files: [],
      };
    }

    if (!matchesAnyGlob(projectPath, rootGlobsAny)) {
      return {
        state: 'no_match',
        reason: 'project path did not match the configured profile scope',
        matched_files: [],
        excluded_files: [],
      };
    }
  }

  if (projectHasFileAny.length > 0) {
    const hasMatchingFile = projectHasFileAny.some((pattern) => hasProjectFile(projectPath, pattern));
    if (!hasMatchingFile) {
      return {
        state: 'no_match',
        reason: 'required project files were not found',
        matched_files: [],
        excluded_files: [],
      };
    }
  }

  if (providersAny.length > 0) {
    if (!provider) {
      return {
        state: 'degraded',
        reason: 'provider is unavailable for matcher evaluation',
        matched_files: [],
        excluded_files: [],
      };
    }

    if (!providersAny.includes(provider)) {
      return {
        state: 'no_match',
        reason: `provider "${provider}" is outside the allowed matcher scope`,
        matched_files: [],
        excluded_files: [],
      };
    }
  }

  if (hasDescriptionPatterns(descriptionMatches)) {
    const taskDescription = collectTaskDescription(context).trim();
    if (!taskDescription) {
      return {
        state: 'degraded',
        reason: 'task description is unavailable for matcher evaluation',
        matched_files: [],
        excluded_files: [],
      };
    }

    const matchedPattern = descriptionMatches.some((pattern) => {
      try {
        return new RegExp(pattern, 'i').test(taskDescription);
      } catch (_err) {
        return false;
      }
    });

    if (!matchedPattern) {
      return {
        state: 'no_match',
        reason: 'task description did not match the configured pattern',
        matched_files: [],
        excluded_files: [],
      };
    }
  }

  if (providersNotAny.length > 0) {
    if (!provider) {
      return {
        state: 'degraded',
        reason: 'provider is unavailable for matcher evaluation',
        matched_files: [],
        excluded_files: [],
      };
    }

    if (providersNotAny.includes(provider)) {
      return {
        state: 'no_match',
        reason: `provider "${provider}" is excluded by matcher scope`,
        matched_files: [],
        excluded_files: [],
      };
    }
  }

  if (targetTypesAny.length > 0) {
    if (!targetType) {
      return {
        state: 'degraded',
        reason: 'target type is unavailable for matcher evaluation',
        matched_files: [],
        excluded_files: [],
      };
    }

    if (!targetTypesAny.includes(targetType)) {
      return {
        state: 'no_match',
        reason: `target type "${targetType}" is outside the matcher scope`,
        matched_files: [],
        excluded_files: [],
      };
    }
  }

  if (changedFileGlobsAny.length > 0 || changedFileGlobsAll.length > 0 || changedFileGlobsNone.length > 0) {
    if (!Array.isArray(changedFiles)) {
      return {
        state: 'degraded',
        reason: 'changed files are unavailable for matcher evaluation',
        matched_files: [],
        excluded_files: [],
      };
    }

    const { files: includedFiles, excluded_files: excludedFiles } = filterExcludedFiles(changedFiles, normalizedMatcher);

    if (changedFileGlobsAny.length > 0) {
      const matchedFiles = includedFiles.filter((file) => matchesAnyGlob(file, changedFileGlobsAny));
      if (matchedFiles.length === 0) {
        return {
          state: 'no_match',
          reason: 'no changed files matched the configured rule scope',
          matched_files: [],
          excluded_files: excludedFiles,
        };
      }

      if (changedFileGlobsAll.length === 0 && changedFileGlobsNone.length === 0) {
        return {
          state: 'match',
          reason: null,
          matched_files: matchedFiles,
          excluded_files: excludedFiles,
        };
      }
    }

    if (changedFileGlobsAll.length > 0) {
      const allMatchedFiles = [];
      for (const glob of changedFileGlobsAll) {
        const matches = includedFiles.filter((file) => matchesGlob(file, glob));
        if (matches.length === 0) {
          return {
            state: 'no_match',
            reason: `required matcher glob "${glob}" did not match any changed files`,
            matched_files: [],
            excluded_files: excludedFiles,
          };
        }
        allMatchedFiles.push(...matches);
      }

      for (const glob of changedFileGlobsNone) {
        if (includedFiles.some((file) => matchesGlob(file, glob))) {
          return {
            state: 'no_match',
            reason: `excluded matcher glob "${glob}" matched a changed file`,
            matched_files: [],
            excluded_files: excludedFiles,
          };
        }
      }

      return {
        state: 'match',
        reason: null,
        matched_files: [...new Set(allMatchedFiles)],
        excluded_files: excludedFiles,
      };
    }

    for (const glob of changedFileGlobsNone) {
      if (includedFiles.some((file) => matchesGlob(file, glob))) {
        return {
          state: 'no_match',
          reason: `excluded matcher glob "${glob}" matched a changed file`,
          matched_files: [],
          excluded_files: excludedFiles,
        };
      }
    }

    return {
      state: 'match',
      reason: null,
      matched_files: includedFiles.filter((file) => changedFileGlobsAny.length === 0 || matchesAnyGlob(file, changedFileGlobsAny)),
      excluded_files: excludedFiles,
    };
  }

  return {
    state: 'match',
    reason: null,
    matched_files: Array.isArray(changedFiles) ? changedFiles : [],
    excluded_files: [],
  };
}

module.exports = {
  normalizePath,
  normalizeStringArray,
  globToRegExp,
  matchesGlob,
  matchesAnyGlob,
  extractChangedFiles,
  extractProjectPath,
  extractProvider,
  evaluateMatcher,
};
