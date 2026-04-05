'use strict';

/**
 * Task Decomposition
 *
 * Determines whether a task should be decomposed into smaller sub-tasks
 * based on the execution provider class and task characteristics.
 *
 * Provider classes:
 *   agentic      — full tool-use agents (codex, codex-spark, claude-cli)
 *   guided       — tool-use agents with explicit workflow guidance (ollama)
 *   prompt-only  — stateless completion APIs (all cloud inference providers)
 */

// Providers that open visible windows — never submit without user consent.
// Listed here for documentation; not used in routing logic.

const PROVIDER_CLASSES = {
  // Agentic: full autonomous tool-use, handle decomposition internally
  'codex':       'agentic',
  'codex-spark': 'agentic',
  'claude-cli':  'agentic',

  // Guided: local Ollama — capable of tool use but needs explicit workflow guidance
  'ollama':      'guided',

  // Prompt-only: stateless completion APIs — no tool use
  'ollama-cloud':  'prompt-only',
  'cerebras':      'prompt-only',
  'groq':          'prompt-only',
  'deepinfra':     'prompt-only',
  'google-ai':     'prompt-only',
  'openrouter':    'prompt-only',
  'hyperbolic':    'prompt-only',
  'anthropic':     'prompt-only',
};

/** Minimum file size (lines) that triggers decomposition consideration for guided providers. */
const GUIDED_FILE_THRESHOLD = 1500;

/** Minimum distinct function/class changes that triggers decomposition for guided providers. */
const GUIDED_MIN_FUNCTIONS = 3;

// Regex patterns used by shouldDecompose

/**
 * C# / .NET ecosystem detection.
 * Matches file extensions, ecosystem names, and common project file types.
 */
const CSHARP_PATTERN = /\.cs\b|c#|\.net|csproj|xaml|wpf|winui|maui|blazor|asp\.net|nuget/i;

/**
 * JS/TS decompose-verb patterns.
 * Tasks that ask for cross-cutting concerns are candidates for splitting.
 */
const JS_DECOMPOSE_VERBS =
  /\b(jsdoc|add docs|add documentation|add logging|add error handling|refactor|cleanup|clean up|add types|add comments|lint fix|add tests for)\b/i;

/**
 * Return the provider class for a given provider name.
 * Defaults to 'prompt-only' for unknown or null providers.
 *
 * @param {string|null|undefined} provider
 * @returns {'agentic'|'guided'|'prompt-only'}
 */
function getProviderClass(provider) {
  if (!provider) return 'prompt-only';
  return PROVIDER_CLASSES[provider] || 'prompt-only';
}

/**
 * Decide whether a task should be decomposed into sub-tasks.
 *
 * Rules:
 *   - agentic providers: never decompose (they handle it internally)
 *   - prompt-only providers: never decompose (no tool use)
 *   - guided providers: decompose if the task description matches C# patterns
 *     combined with complexity signals, OR matches JS/TS decompose-verb patterns
 *
 * @param {object} taskInfo     — task record (description, complexity, metadata, etc.)
 * @param {object} routingResult — routing decision ({ provider, model, ... })
 * @returns {{ decompose: boolean, reason: string, type?: 'csharp'|'js' }}
 */
function shouldDecompose(taskInfo, routingResult) {
  const provider = routingResult && routingResult.provider;
  const providerClass = getProviderClass(provider);

  if (providerClass === 'agentic') {
    return { decompose: false, reason: 'agentic provider handles decomposition internally' };
  }

  if (providerClass === 'prompt-only') {
    return { decompose: false, reason: 'prompt-only provider does not support tool use' };
  }

  // guided provider — evaluate task characteristics
  const description = (taskInfo && (taskInfo.task_description || taskInfo.task)) || '';
  const complexity = (taskInfo && taskInfo.complexity) || 'normal';
  const isComplex = complexity === 'complex';

  // C# / .NET: decompose if complex AND task touches C# ecosystem
  if (isComplex && CSHARP_PATTERN.test(description)) {
    return {
      decompose: true,
      reason: 'complex C# task — split to avoid context overflow in guided provider',
      type: 'csharp',
    };
  }

  // JS/TS decompose-verb patterns — decompose regardless of complexity flag
  if (JS_DECOMPOSE_VERBS.test(description)) {
    return {
      decompose: true,
      reason: 'JS/TS cross-cutting change detected — split to keep each task focused',
      type: 'js',
    };
  }

  return { decompose: false, reason: 'task is within guided provider scope' };
}

/**
 * Create sub-task definitions with inherited routing context.
 * Sub-tasks are locked to the parent's provider — no re-routing.
 *
 * @param {object} taskInfo - { task, working_directory, files }
 * @param {object} routingResult - { provider, model, ... }
 * @param {object} options - { subtasks: string[], version_intent, parent_task_id, ui_review }
 * @returns {{ tasks: object[] }}
 */
function decomposeTask(taskInfo, routingResult, options) {
  const { subtasks = [], version_intent, parent_task_id, ui_review } = options;
  const { working_directory } = taskInfo;
  const { provider, model } = routingResult;

  const tasks = subtasks.map((description, index) => ({
    task: description,
    provider,
    model: model || null,
    working_directory,
    version_intent: version_intent || null,
    priority: 0,
    metadata: {
      decomposed: true,
      parent_task_id: parent_task_id || null,
      batch_index: index,
      ui_review: ui_review || false,
    },
  }));

  return { tasks };
}

module.exports = {
  PROVIDER_CLASSES,
  GUIDED_FILE_THRESHOLD,
  GUIDED_MIN_FUNCTIONS,
  getProviderClass,
  shouldDecompose,
  decomposeTask,
};
