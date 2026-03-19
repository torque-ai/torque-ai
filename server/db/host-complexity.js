'use strict';

/**
 * Task complexity detection and routing decomposition helpers.
 */

let db;

const DOC_PATTERNS = [
  'write.*adr', 'write.*runbook', 'write.*guide', 'document the',
  'write.*spec', 'troubleshooting guide', 'data model.*document',
  'migration strategy.*document', 'document.*catalog',
  'write.*readme', 'create.*readme', 'update.*readme',
  'write.*documentation', 'write.*usage', 'write.*changelog',
  'explain.*how.*works', 'describe.*usage'
];

const TEST_PATTERNS = [
  'write.*test', 'write.*xunit', 'add.*test'
];

const STUB_FILL_PATTERNS = [
  'fill in.*method', 'fill in.*stub', 'fill in.*bodies', 'fill .+ in .+\\.\\w+',
  'replace.*not implemented', 'replace.*throw.*not implemented',
  'fill.*skeleton', 'implement.*stub'
];

const MULTI_STEP_PATTERNS = [
  'and wire', 'and connect', 'and register',
  'wire the', 'wire it', 'wire to',
  'implement.*system', 'implement.*pipeline',
  'build.*with.*integration', 'implement.*with.*dependency'
];

const SIMPLE_CODE_GEN_PATTERNS = [
  'create a class', 'create a service', 'create a component',
  'create a method', 'create a function', 'create a test',
  'create a \\w+ function',
  'create a \\w+ class',
  'create a \\w+service', 'create a \\w+class',
  'create \\w+ class', 'create \\w+ service',
  'add a method', 'add a property', 'add an endpoint',
  'add a field', 'add a constructor',
  'implement.*interface', 'implement.*method',
  'implement the.*method', 'implement the.*interface',
  'create a helper', 'create a utility', 'create a dto',
  'add.*handler', 'add.*validator'
];

const COMPLEX_CODE_GEN_PATTERNS = [
  'implement ', 'build a ', 'build an ', 'build the ',
  'add real-time', 'add transaction', 'add role-based', 'add.*workflow',
  'create.*viewmodel', 'create.*view',
  'create.*entity',
  'implement.*service',
  'build.*api', 'build.*endpoint'
];

function compileRegexPatterns(patterns) {
  return patterns.map((pattern) => new RegExp(pattern));
}

const DOC_REGEXES = compileRegexPatterns(DOC_PATTERNS);
const TEST_REGEXES = compileRegexPatterns(TEST_PATTERNS);
const STUB_FILL_REGEXES = compileRegexPatterns(STUB_FILL_PATTERNS);
const MULTI_STEP_REGEXES = compileRegexPatterns(MULTI_STEP_PATTERNS);
const SIMPLE_CODE_GEN_REGEXES = compileRegexPatterns(SIMPLE_CODE_GEN_PATTERNS);
const COMPLEX_CODE_GEN_REGEXES = compileRegexPatterns(COMPLEX_CODE_GEN_PATTERNS);

function setDb(instance) {
  db = instance;
}

function getConfig(key) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : null;
}

/**
 * Determine task complexity based on task description and context
 * Returns: 'simple', 'normal', or 'complex'
 */
function determineTaskComplexity(taskDescription, files = []) {
  const desc = (taskDescription || '').toLowerCase();
  const fileCount = (files || []).length;

  // F7: Non-English descriptions — keyword patterns won't match, use structural analysis
  const ASCII_RANGE = /[\x00-\x7F]/g;
  if (desc.length > 0) {
    const nonAsciiRatio = (desc.replace(ASCII_RANGE, '').length) / desc.length;
    if (nonAsciiRatio > 0.3) {
      // Non-English description — classify by structural signals instead of keywords
      if (fileCount > 5) return 'complex';
      if (desc.length > 200) return 'complex';
      if (desc.length > 50) return 'normal';
      return 'simple';
    }
  }

  for (const regex of DOC_REGEXES) {
    if (regex.test(desc)) {
      return 'simple';
    }
  }

  for (const regex of TEST_REGEXES) {
    if (regex.test(desc)) {
      return 'normal';
    }
  }

  for (const regex of STUB_FILL_REGEXES) {
    if (regex.test(desc)) {
      return 'normal';
    }
  }

  for (const regex of MULTI_STEP_REGEXES) {
    if (regex.test(desc)) {
      return 'complex';
    }
  }

  const bulletCount = (desc.match(/^[\s]*[-*•]\s/gm) || []).length +
    (desc.match(/^\s*\d+[.)]\s/gm) || []).length;
  if (bulletCount >= 5) {
    return 'complex';
  }

  for (const regex of SIMPLE_CODE_GEN_REGEXES) {
    if (regex.test(desc)) {
      return 'normal';
    }
  }

  for (const regex of COMPLEX_CODE_GEN_REGEXES) {
    if (regex.test(desc)) {
      return 'complex';
    }
  }

  const complexPatterns = [
    'refactor', 'redesign', 'architect', 'security', 'vulnerability',
    'performance', 'optimize', 'migrate', 'upgrade major', 'breaking change',
    'multi-file', 'cross-cutting', 'system-wide', 'infrastructure',
    'authentication', 'authorization', 'encryption', 'api design',
    'database schema', 'concurrent.*access', 'concurrent.*processing',
    'async.*architecture', 'async.*coordination', 'async.*workflow',
    'parallel.*processing', 'parallel.*execution', 'threading',
    'critical bug', 'production issue', 'debug complex'
  ];

  const simplePatterns = [
    'add comment', 'add documentation', 'add docstring', 'xml doc',
    'rename', 'typo', 'spelling', 'format code', 'formatting', 'lint', 'style',
    'add test', 'unit test', 'simple test', 'fix typo',
    'update version', 'update readme', 'add logging', 'log statement',
    'add using', 'add import', 'remove unused', 'cleanup'
  ];

  for (const pattern of complexPatterns) {
    if (desc.includes(pattern)) {
      return 'complex';
    }
  }

  for (const pattern of simplePatterns) {
    if (desc.includes(pattern)) {
      return 'simple';
    }
  }

  if (fileCount > 5) {
    return 'complex';
  }
  if (fileCount === 1 && desc.length < 100) {
    return 'simple';
  }

  if (desc.length < 50) {
    return 'simple';
  }
  if (desc.length > 500) {
    return 'complex';
  }

  return 'normal';
}

/**
 * Get the appropriate model tier for a task complexity level.
 * Supports three-tier model selection: fast (8B), balanced (14B), quality (32B).
 *
 * @param {string} complexity - 'simple', 'normal', or 'complex'
 * @returns {{ tier: string, modelConfig: string, description: string }}
 */
function getModelTierForComplexity(complexity) {
  const fastModel = getConfig('ollama_fast_model') || 'qwen2.5-coder:32b';
  const balancedModel = getConfig('ollama_balanced_model') || 'qwen2.5-coder:32b';
  const qualityModel = getConfig('ollama_quality_model') || 'qwen2.5-coder:32b';

  switch (complexity) {
    case 'simple':
      return {
        tier: 'fast',
        modelConfig: fastModel,
        description: 'Fast 8B model for docs, comments, simple renames'
      };
    case 'normal':
      return {
        tier: 'balanced',
        modelConfig: balancedModel,
        description: 'Balanced 22B model for single-file code, tests, explanations'
      };
    case 'complex':
    default:
      return {
        tier: 'quality',
        modelConfig: qualityModel,
        description: 'Quality 32B model for multi-file changes, complex logic'
      };
  }
}

/**
 * Decompose complex code-gen tasks into smaller subtasks for local LLM processing.
 * Returns null if task doesn't need decomposition (simple/normal complexity or no pattern match).
 * Returns array of subtask descriptions if decomposition is appropriate.
 *
 * @param {string} taskDescription - The original task description
 * @param {string} workingDirectory - The working directory for the task
 * @returns {string[]|null} Array of subtask descriptions, or null if no decomposition needed
 */
function decomposeTask(taskDescription, workingDirectory) {
  if (!taskDescription || typeof taskDescription !== 'string') {
    return null;
  }

  const workDir = workingDirectory || '.';

  const toPascalCase = (str) => {
    return str.split(/[\s_-]+/)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join('');
  };

  const patterns = [
    {
      match: /implement (?:a |an |the )?(\w+)(?:\s*service|\s*system|\s*pipeline)/i,
      decompose: (match) => {
        const name = toPascalCase(match[1]);
        return [
          `Create file ${workDir}/I${name}Service.cs with interface I${name}Service containing method signatures: Process(), Initialize(), and Dispose()`,
          `Create file ${workDir}/${name}Service.cs implementing I${name}Service with the core logic`,
          `Add ${name}Service registration to dependency injection in ${workDir} (find existing DI setup or create ServiceExtensions.cs)`
        ];
      }
    },
    {
      match: /build (?:a |an |the )?(.+?)\s+(?:with|using|that)\s+(.+)/i,
      decompose: (match) => {
        const name = toPascalCase(match[1].replace(/\s+service$/i, ''));
        const features = match[2];
        return [
          `Create file ${workDir}/${name}.cs with a public class ${name} containing private fields and a constructor`,
          `Add public methods to ${workDir}/${name}.cs for the core functionality`,
          `Add ${features} to the ${name} class in ${workDir}/${name}.cs`
        ];
      }
    },
    {
      match: /create (?:a |an |the )?(.+?)\s+and\swire/i,
      decompose: (match) => {
        const name = toPascalCase(match[1].replace(/\s+service$/i, ''));
        return [
          `Create file ${workDir}/I${name}.cs with interface I${name} defining the contract`,
          `Create file ${workDir}/${name}.cs implementing I${name} with core methods`,
          `Register ${name} in dependency injection container (find startup/DI config in ${workDir})`
        ];
      }
    },
    {
      match: /implement (?:the )?(?:full |complete )?(.+?)\s+(?:flow|workflow|pipeline)/i,
      decompose: (match) => {
        const name = toPascalCase(match[1]);
        return [
          `Create file ${workDir}/${name}Handler.cs with class ${name}Handler containing a Handle() method as entry point`,
          `Add validation and core logic methods to ${workDir}/${name}Handler.cs`,
          `Add error handling with try-catch and result types to ${workDir}/${name}Handler.cs`
        ];
      }
    },
    {
      match: /build an API endpoint for (.+)/i,
      decompose: (match) => {
        const name = toPascalCase(match[1]);
        return [
          `Create file ${workDir}/${name}Controller.cs with route handlers for GET, POST, PUT, DELETE`,
          `Create file ${workDir}/${name}Request.cs and ${name}Response.cs with DTOs and validation attributes`,
          `Add business logic service methods that the controller will call`
        ];
      }
    },
    {
      match: /implement (?:a |an |the )?(.+?)\s+with\s+(.+?)\s+and\s+(.+)/i,
      decompose: (match) => {
        const baseName = toPascalCase(match[1]);
        const feature1 = toPascalCase(match[2]);
        const feature2 = toPascalCase(match[3]);
        return [
          `Create file ${workDir}/I${baseName}Provider.cs with interface defining Send() method`,
          `Create file ${workDir}/${feature1}${baseName}Provider.cs implementing I${baseName}Provider for ${match[2]}`,
          `Create file ${workDir}/${feature2}${baseName}Provider.cs implementing I${baseName}Provider for ${match[3]}`
        ];
      }
    }
  ];

  for (const p of patterns) {
    const m = p.match.exec(taskDescription);
    if (m) {
      const subtasks = p.decompose(m);
      if (subtasks && subtasks.length > 1) {
        return subtasks;
      }
    }
  }

  return null;
}

/**
 * Advisory flag: should this task be decomposed into subtasks?
 * Returns true when complexity is 'complex' AND 3+ files are involved.
 * @param {string} complexity - 'simple', 'normal', or 'complex'
 * @param {string[]} files - Files referenced by the task
 * @returns {boolean}
 */
function getSplitAdvisory(complexity, files = []) {
  return complexity === 'complex' && Array.isArray(files) && files.length >= 3;
}

module.exports = {
  setDb,
  determineTaskComplexity,
  getModelTierForComplexity,
  decomposeTask,
  getSplitAdvisory,
};
