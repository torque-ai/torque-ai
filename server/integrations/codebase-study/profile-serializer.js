'use strict';

const fsPromises = require('node:fs/promises');
const path = require('path');

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

function createProfileSerializer(deps = {}) {
  const uniqueStrings = typeof deps.uniqueStrings === 'function' ? deps.uniqueStrings : defaultUniqueStrings;
  const buildDetectionSummary = typeof deps.buildDetectionSummary === 'function' ? deps.buildDetectionSummary : (() => null);
  const resolveWorkingDirectory = typeof deps.resolveWorkingDirectory === 'function'
    ? deps.resolveWorkingDirectory
    : (workingDirectory) => workingDirectory;
  const loadRepoMetadata = typeof deps.loadRepoMetadata === 'function' ? deps.loadRepoMetadata : (() => ({}));
  const resolveStudyProfile = typeof deps.resolveStudyProfile === 'function' ? deps.resolveStudyProfile : (() => ({}));
  const detectStudyProfileSignals = typeof deps.detectStudyProfileSignals === 'function'
    ? deps.detectStudyProfileSignals
    : (() => null);
  const getStudyProfileOverridePath = typeof deps.getStudyProfileOverridePath === 'function'
    ? deps.getStudyProfileOverridePath
    : (() => null);
  const readStudyProfileOverride = typeof deps.readStudyProfileOverride === 'function'
    ? deps.readStudyProfileOverride
    : (() => null);
  const createStudyProfileOverrideTemplate = typeof deps.createStudyProfileOverrideTemplate === 'function'
    ? deps.createStudyProfileOverrideTemplate
    : (() => ({}));
  const STUDY_PROFILE_OVERRIDE_FILE = typeof deps.STUDY_PROFILE_OVERRIDE_FILE === 'string'
    ? deps.STUDY_PROFILE_OVERRIDE_FILE
    : 'docs/architecture/study-profile-override.json';

  function serializeStudyProfile(profile) {
    if (!profile || typeof profile !== 'object') {
      return null;
    }
    return {
      id: profile.id,
      label: profile.label,
      description: profile.description,
      reusable_strategy: profile.reusable_strategy,
      framework_detection: buildDetectionSummary(profile.detection || null),
      base_profile_id: profile.base_profile_id || null,
      override_applied: profile.override_applied === true,
      override_repo_path: profile.override_repo_path || null,
      override_notes: uniqueStrings(profile.override_notes || []),
    };
  }

  async function maybeWriteStudyProfileOverrideScaffold(workingDirectory, profile) {
    const overridePath = getStudyProfileOverridePath(workingDirectory);
    const existingOverride = readStudyProfileOverride(workingDirectory);
    const template = createStudyProfileOverrideTemplate({
      repoMetadata: await loadRepoMetadata(workingDirectory),
      profile,
    });
    if (!overridePath) {
      return {
        path: null,
        repo_path: null,
        exists: existingOverride !== null,
        scaffold_written: false,
        template,
      };
    }
    if (existingOverride) {
      return {
        path: overridePath,
        repo_path: existingOverride.repo_path || STUDY_PROFILE_OVERRIDE_FILE.replace(/\\/g, '/'),
        exists: true,
        scaffold_written: false,
        template,
      };
    }
    await fsPromises.mkdir(path.dirname(overridePath), { recursive: true });
    await fsPromises.writeFile(overridePath, `${JSON.stringify(template, null, 2)}\n`, 'utf8');
    return {
      path: overridePath,
      repo_path: STUDY_PROFILE_OVERRIDE_FILE.replace(/\\/g, '/'),
      exists: true,
      scaffold_written: true,
      template,
    };
  }

  async function describeStudyProfile(workingDirectory, repoMetadata, trackedFiles) {
    const resolvedWorkingDirectory = resolveWorkingDirectory(workingDirectory);
    const profile = resolveStudyProfile({
      repoMetadata,
      trackedFiles,
      workingDirectory: resolvedWorkingDirectory,
    });
    const repoSignals = detectStudyProfileSignals({
      repoMetadata,
      trackedFiles,
      profile,
    });
    const override = readStudyProfileOverride(resolvedWorkingDirectory);
    return {
      profile,
      serializedProfile: serializeStudyProfile({ ...profile, detection: repoSignals }),
      profileOverride: {
        path: getStudyProfileOverridePath(resolvedWorkingDirectory),
        repo_path: override?.repo_path || STUDY_PROFILE_OVERRIDE_FILE.replace(/\\/g, '/'),
        exists: Boolean(override),
        override_applied: Boolean(profile?.override_applied),
        override,
        template: createStudyProfileOverrideTemplate({ repoMetadata, profile }),
      },
    };
  }

  return {
    serializeStudyProfile,
    maybeWriteStudyProfileOverrideScaffold,
    describeStudyProfile,
  };
}

module.exports = { createProfileSerializer };
