'use strict';

const matchers = require('../matchers');

const CATEGORY_ORDER = ['code', 'test', 'schema', 'docs', 'config'];
const CATEGORY_PATTERNS = {
  code: [
    '**/*.{js,jsx,ts,tsx,cjs,mjs,cts,mts,py,rb,go,rs,java,cs,php,swift,kt,kts,scala,sh,ps1,bat,cmd}',
  ],
  test: [
    '**/__tests__/**',
    '**/tests/**',
    '**/test/**',
    '**/*.{test,spec}.{js,jsx,ts,tsx,cjs,mjs,cts,mts}',
  ],
  schema: [
    '**/schema/**',
    '**/schemas/**',
    '**/migration/**',
    '**/migrations/**',
    '**/*schema*.{js,jsx,ts,tsx,cjs,mjs,cts,mts,json,sql}',
    '**/*migration*.{js,jsx,ts,tsx,cjs,mjs,cts,mts,sql}',
    '**/*.{sql,prisma,graphql,gql}',
  ],
  docs: [
    'docs/**',
    '**/docs/**',
    '**/README*',
    '**/CHANGELOG*',
    '**/LICENSE*',
    '**/*.{md,mdx,rst,txt,adoc}',
  ],
  config: [
    '**/.env',
    '**/.env.*',
    '**/package.json',
    '**/package-lock.json',
    '**/pnpm-lock.yaml',
    '**/yarn.lock',
    '**/Dockerfile',
    '**/Dockerfile.*',
    '**/docker-compose*.{yml,yaml}',
    '**/tsconfig*.json',
    '**/vitest.config.*',
    '**/vite.config.*',
    '**/eslint*.{js,cjs,mjs,json}',
    '**/prettier*.{js,cjs,mjs,json}',
    '**/*.{json,yml,yaml,toml,ini,conf,config}',
  ],
};

function asBoolean(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return null;
    if (['true', '1', 'yes', 'on', 'enabled', 'passed', 'pass'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off', 'disabled', 'failed', 'fail'].includes(normalized)) return false;
  }
  return null;
}

function createEmptyCategories() {
  return {
    code: [],
    test: [],
    schema: [],
    docs: [],
    config: [],
  };
}

function toNormalizedPaths(files) {
  if (!Array.isArray(files)) return null;
  return files
    .map((file) => matchers.normalizePath(file))
    .filter(Boolean);
}

function resolveChangedFiles(context = {}) {
  const extracted = matchers.extractChangedFiles(context);
  if (Array.isArray(extracted)) {
    return extracted;
  }

  const taskFiles = context.task?.changed_files
    ?? context.task?.changedFiles
    ?? context.task?.files_modified;
  return toNormalizedPaths(taskFiles);
}

function classifyChangedFiles(files) {
  const categories = createEmptyCategories();
  const by_file = [];
  const unclassified = [];

  for (const file of files) {
    const matchedCategories = CATEGORY_ORDER
      .filter((category) => matchers.matchesAnyGlob(file, CATEGORY_PATTERNS[category]));

    if (matchedCategories.length === 0) {
      unclassified.push(file);
    } else {
      for (const category of matchedCategories) {
        categories[category].push(file);
      }
    }

    by_file.push({
      path: file,
      categories: matchedCategories,
    });
  }

  return {
    categories,
    by_file,
    unclassified,
  };
}

function collectBooleanEvidence(type, value) {
  const normalized = asBoolean(value);
  if (normalized === null) {
    return {
      type,
      available: false,
      satisfied: false,
    };
  }

  return {
    type,
    available: true,
    satisfied: normalized,
  };
}

function collectVerificationEvidence(context = {}) {
  const task = context.task && typeof context.task === 'object' ? context.task : {};
  const changedFiles = resolveChangedFiles(context);
  const classification = Array.isArray(changedFiles)
    ? classifyChangedFiles(changedFiles)
    : null;

  return [
    collectBooleanEvidence('verify_command_passed', task.verification_passed),
    collectBooleanEvidence('test_command_passed', task.test_passed),
    collectBooleanEvidence('build_command_passed', task.build_passed),
    classification
      ? {
          type: 'changed_files_classified',
          available: true,
          satisfied: classification.unclassified.length === 0,
          value: changedFiles,
          categories: classification.categories,
          by_file: classification.by_file,
          unclassified: classification.unclassified,
        }
      : {
          type: 'changed_files_classified',
          available: false,
          satisfied: false,
          value: [],
          categories: createEmptyCategories(),
          by_file: [],
          unclassified: [],
        },
  ];
}

module.exports = {
  collectVerificationEvidence,
};
