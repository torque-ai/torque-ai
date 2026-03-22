'use strict';

/**
 * Prompts & Instruction Templates Module
 *
 * Extracted from task-manager.js (Phase 7A) — task type detection,
 * instruction templates, and prompt wrapping for all providers.
 *
 * Uses init() dependency injection for database config access.
 */

const logger = require('../logger').child({ component: 'prompts' });
const serverConfig = require('../config');
const { BASE_LLM_RULES } = require('../constants');
const { getModelSizeCategory, isSmallModel, isThinkingModel } = require('../utils/model');

const TIER_CONTEXT_CAPS = {
  small: 2048, // ~500 tokens — single file only
  medium: 6144, // ~1500 tokens — 2-3 files
  large: 16384, // ~4000 tokens — multi-file context
  unknown: 4096, // conservative default
};

// Dependency injection
let _db = null;

/**
 * Initialize dependencies for this module.
 * @param {Object} deps
 * @param {Object} deps.db - Database module (getConfig)
 */
function init(deps) {
  if (deps.db) _db = deps.db;
  serverConfig.init({ db: deps.db });
}

/**
 * Task-type specific instruction enhancements.
 * These are appended based on detected task patterns.
 */
const TASK_TYPE_INSTRUCTIONS = {
  // XML Documentation tasks - critical rules for C#
  'xml-documentation': `

### XML DOCUMENTATION RULES (C#) - CRITICAL:
1. ONLY add XML doc comments (/// <summary>) to classes, methods, properties, and fields
2. NEVER add XML comments above 'namespace' declarations - this is INVALID C# syntax
3. NEVER add XML comments above 'using' statements
4. NEVER rewrite or modify the actual code - ONLY add documentation comments
5. Keep the SEARCH block minimal - just the line you're adding comments above
6. The REPLACE block should be: your XML comment + the original line unchanged
7. If a class/method ALREADY has an XML comment, do NOT add another one - skip it
8. Check for existing /// <summary> before adding - never duplicate existing documentation

Example of CORRECT edit:
\`\`\`csharp
<<<<<<< SEARCH
public class MyService
=======
/// <summary>
/// Description here.
/// </summary>
public class MyService
>>>>>>> REPLACE
\`\`\`

Example of WRONG edit (DO NOT DO THIS):
\`\`\`csharp
<<<<<<< SEARCH
namespace MyNamespace;
=======
/// <summary>WRONG - never document namespaces</summary>
namespace MyNamespace;
>>>>>>> REPLACE
\`\`\``,

  // Markdown file generation — P67 fix
  // Aider's whole-format parser treats ``` blocks as file markers,
  // so markdown content with fenced code blocks creates junk files
  'markdown': `

### MARKDOWN FILE RULES (P67) - CRITICAL:
- When writing .md files, use INDENTED CODE BLOCKS (4 spaces) instead of fenced \`\`\` blocks
- Example of CORRECT markdown code block (4-space indent):

    npm install pulse

- Example of WRONG markdown code block (DO NOT USE):
  \`\`\`bash
  npm install pulse
  \`\`\`
- This applies to ALL code examples inside markdown files
- Inline code with single backticks (\`like this\`) is fine`,

  'small-model': `

### SMALL MODEL CONSTRAINTS (<8B parameters):
- Focus on ONE file at a time. Do not attempt multi-file edits.
- Keep each edit under 50 lines of change.
- Use explicit, literal variable names — avoid abbreviations.
- Do NOT attempt complex refactoring or architectural changes.
- If the task requires more than 3 files, request task splitting.
- Prefer simple if/else over complex ternary or chained expressions.
- Always include the full function when editing — do not use ellipsis or "// rest unchanged".
`,

  'medium-model': `

### MEDIUM MODEL GUIDANCE (8-20B parameters):
- You can handle multi-file edits but limit to 3 files per task.
- Keep total edit scope under 200 lines of change.
- Complex logic is fine but avoid deeply nested callbacks (>3 levels).
- When creating new files, include all imports and exports explicitly.
- For test files, write complete test cases — do not use placeholder assertions.
`,

  'large-model': `

### LARGE MODEL CAPABILITIES (20B+ parameters):
- Multi-file edits are supported — up to 5 files per task.
- Complex refactoring and architectural changes are appropriate.
- Use full error handling patterns including edge cases.
- Generate comprehensive test coverage including edge cases and error paths.
- When creating modules, include JSDoc for all exported functions.
`,

  'cloud-model': `

### CLOUD MODEL CAPABILITIES:
- Full multi-file support with no practical file count limit.
- Complex architectural tasks, large-scale refactoring, and system design are appropriate.
- Generate complete implementations — avoid stubs or TODOs.
- Include error handling, input validation, and edge case coverage.
- For test files, generate exhaustive test suites covering happy paths, error paths, and boundary conditions.
- You have access to large context windows — use provided file context fully.
`,

  'test-verification-lite': `

### TEST VERIFICATION — IMPORTANT:
- Do NOT run the full project test suite (e.g., "npx vitest run" with no arguments).
- Only run the SPECIFIC test file(s) you created or modified — e.g., "npx vitest run tests/my-new-test.test.js".
- Running the full suite wastes resources and may time out. Targeted tests are sufficient to verify your work.
- If you need to type-check, use "npx tsc --noEmit" (fast, no execution).
- The orchestrator will run full verification separately after your task completes.
`
};

/**
 * Default instruction templates for different providers.
 * These wrap the task description with standardized safeguard instructions.
 */
const DEFAULT_INSTRUCTION_TEMPLATES = {
  // Template for Claude CLI
  'claude-cli': `You are an autonomous coding agent. You MUST use your tools (Read, Write, Edit, Glob, Grep, Bash) to complete this task — do NOT respond conversationally.

## Workflow
1. Use Glob/Grep to find relevant files in the working directory
2. Use Read to understand the source code and existing patterns
3. Use Write to create new files or Edit to modify existing files
4. Do NOT explain what should be done — directly create or modify the files

${BASE_LLM_RULES}
{TASK_TYPE_INSTRUCTIONS}
### Files to modify:
{FILES}
{FILE_CONTEXT}
### Task:
{TASK_DESCRIPTION}`,

  // Template for Codex
  'codex': `Task: {TASK_DESCRIPTION}
{TASK_TYPE_INSTRUCTIONS}
{FILE_CONTEXT}
${BASE_LLM_RULES}`
};

/**
 * Detect task type from description for specialized instructions.
 * @param {string} taskDescription - The task description
 * @returns {string[]} Array of detected task types
 */
function detectTaskTypes(taskDescription) {
  const types = [];
  const lower = taskDescription.toLowerCase();
  const existingTestFileEdit =
    lower.includes('existing test file') ||
    (lower.includes('extend') && /\b[\w\-/\\]+\.test\.(ts|js|tsx|jsx)\b/.test(lower)) ||
    (lower.includes('add cases to') && /\b[\w\-/\\]+\.test\.(ts|js|tsx|jsx)\b/.test(lower)) ||
    (lower.includes('update') && lower.includes('test file') && /\b[\w\-/\\]+\.test\.(ts|js|tsx|jsx)\b/.test(lower));

  // XML Documentation detection
  if (lower.includes('xml doc') || lower.includes('xml comment') ||
      lower.includes('/// <summary') || lower.includes('documentation comment') ||
      (lower.includes('add') && lower.includes('summary') && lower.includes('comment'))) {
    types.push('xml-documentation');
  }

  // Markdown file detection (P67) — tasks that produce .md files need special ``` handling
  if (lower.includes('readme') || lower.includes('.md') ||
      lower.includes('usage.md') || lower.includes('changelog') ||
      (lower.includes('write') && (lower.includes('guide') || lower.includes('documentation'))) ||
      lower.includes('markdown')) {
    types.push('markdown');
  }

  // File creation detection — tasks creating new files have no existing content to SEARCH against
  if (!existingTestFileEdit && (lower.includes('create file') || lower.includes('new file') ||
      lower.includes('create a file') || lower.includes('create a new') ||
      /\bcreate\b.*\.(ts|js|py|cs|java|go|rs|cpp|c|h)\b/.test(lower))) {
    types.push('file-creation');
  }

  // Single-file task detection — tasks targeting a single specific file
  const fileRefPattern = /\b[\w\-/\\]+\.(ts|js|py|cs|java|go|rs|cpp|c|h)\b/g;
  const fileRefs = lower.match(fileRefPattern) || [];
  const uniqueFiles = new Set(fileRefs);
  if (uniqueFiles.size === 1) {
    types.push('single-file-task');
  }

  return types;
}

/**
 * Get the instruction template for a provider/model.
 * @param {string} provider - The provider (claude-cli, codex)
 * @param {string} model - Optional model name for model-specific templates
 * @returns {string} The instruction template
 */
function getInstructionTemplate(provider, model) {
  // Check for model-specific template first
  if (model) {
    const modelTemplate = serverConfig.get(`instruction_template_${provider}_${model}`);
    if (modelTemplate) return modelTemplate;
  }

  // Check for provider-specific template
  const providerTemplate = serverConfig.get(`instruction_template_${provider}`);
  if (providerTemplate) return providerTemplate;

  // Fall back to default
  return DEFAULT_INSTRUCTION_TEMPLATES[provider] || DEFAULT_INSTRUCTION_TEMPLATES['codex'];
}

/**
 * Wrap task description with instruction template.
 * @param {string} taskDescription - The original task description
 * @param {string} provider - The provider being used
 * @param {string} model - Optional model name
 * @param {Object} context - Additional context (files, project, etc.)
 * @returns {string} The wrapped task description
 */
function wrapWithInstructions(taskDescription, provider, model, context = {}) {
  // Check if instruction wrapping is disabled
  const wrapEnabled = serverConfig.get('instruction_wrapping_enabled');
  if (wrapEnabled === '0' || wrapEnabled === 'false') {
    return taskDescription;
  }

  const template = getInstructionTemplate(provider, model);
  const modelSizeCategory = getModelSizeCategory(model);
  const isCloudProvider = [
    'codex', 'claude-cli', 'anthropic',
    'deepinfra', 'hyperbolic', 'groq',
    'cerebras', 'google-ai', 'openrouter', 'ollama-cloud',
  ].includes(provider);

  // Detect task types and build specialized instructions
  const taskTypes = detectTaskTypes(taskDescription);
  let taskTypeInstructions = '';
  let fileContextStr = context.fileContext || '';

  // Add task-type specific instructions
  for (const type of taskTypes) {
    if (TASK_TYPE_INSTRUCTIONS[type]) {
      taskTypeInstructions += TASK_TYPE_INSTRUCTIONS[type];
    }
  }

  // Add small model guidance if applicable
  if (isSmallModel(model)) {
    taskTypeInstructions += TASK_TYPE_INSTRUCTIONS['small-model'] || '';
    logger.info(`[Prompt] Adding small-model guidance for ${model}`);
  }

  if (modelSizeCategory === 'medium') {
    taskTypeInstructions += TASK_TYPE_INSTRUCTIONS['medium-model'] || '';
    logger.info(`[Prompt] Adding medium-model guidance for ${model}`);
  }

  if (modelSizeCategory === 'large') {
    taskTypeInstructions += TASK_TYPE_INSTRUCTIONS['large-model'] || '';
    logger.info(`[Prompt] Adding large-model guidance for ${model}`);
  }

  // NOTE: A large cloud model (e.g., deepinfra 70B) will receive both
  // large-model and cloud-model instruction blocks. Ensure these two blocks
  // are complementary, not contradictory. If they conflict, prefer cloud-model
  // since it is the more specific context.
  if (isCloudProvider) {
    taskTypeInstructions += TASK_TYPE_INSTRUCTIONS['cloud-model'] || '';
    logger.info(`[Prompt] Adding cloud-model guidance for provider ${provider}`);
  }

  // Codex/Codex-Spark: inject test-verification-lite when a remote workstation is configured
  // or always (Codex shouldn't run full test suites — the orchestrator handles that post-task)
  if (provider === 'codex' || provider === 'codex-spark') {
    taskTypeInstructions += TASK_TYPE_INSTRUCTIONS['test-verification-lite'] || '';
    logger.info(`[Prompt] Adding test-verification-lite for ${provider}`);
  }

  // Tier-aware file context capping
  if (!isCloudProvider && fileContextStr) {
    const cap = TIER_CONTEXT_CAPS[modelSizeCategory] || TIER_CONTEXT_CAPS.unknown;
    if (fileContextStr.length > cap) {
      fileContextStr = fileContextStr.slice(0, cap) + `\n[... truncated to ${cap} bytes for ${modelSizeCategory} model ...]`;
      logger.info(`[Prompt] Capped file context to ${cap} bytes for ${modelSizeCategory} model ${model}`);
    }
  }

  // Log detected task types for debugging
  if (taskTypes.length > 0) {
    logger.info(`[Prompt] Detected task types: ${taskTypes.join(', ')} - adding specialized instructions`);
  }

  // Replace placeholders (replaceAll ensures multiple occurrences are substituted)
  let wrapped = template
    .replaceAll('{TASK_DESCRIPTION}', taskDescription)
    .replaceAll('{FILES}', context.files ? context.files.join(', ') : 'As specified in the task')
    .replaceAll('{PROJECT}', context.project || 'unknown')
    .replaceAll('{TASK_TYPE_INSTRUCTIONS}', taskTypeInstructions)
    .replaceAll('{FILE_CONTEXT}', fileContextStr);

  // Fallback: if template lacks placeholder but context exists, append
  if (fileContextStr && wrapped.indexOf(fileContextStr) === -1) {
    wrapped += fileContextStr;
  }

  return wrapped;
}

module.exports = {
  init,
  TASK_TYPE_INSTRUCTIONS,
  TIER_CONTEXT_CAPS,
  DEFAULT_INSTRUCTION_TEMPLATES,
  detectTaskTypes,
  getInstructionTemplate,
  wrapWithInstructions,
};
