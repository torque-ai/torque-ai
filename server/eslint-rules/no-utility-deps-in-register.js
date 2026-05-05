'use strict';

/**
 * torque/no-utility-deps-in-register
 *
 * Flags `container.register('name', [deps], factory)` declarations whose
 * dep array contains names that look like utility functions or
 * closures-over-task-manager-state — things that don't belong as DI
 * dependencies. The DI container should hold *services* (stateful,
 * shared, lifecycle-bound). Utility functions get `require`'d directly;
 * task-manager closures resolve through capability services.
 *
 * Why this rule exists: 9 deferred execution/ modules accumulated 107
 * distinct dep names in their register() declarations during the
 * universal-DI migration. Most weren't services — they were utility
 * function names like `parseCommand`, `sanitizeOutput`, `computeLineHash`,
 * or task-manager closures like `processQueue`, `attemptTaskStart`. The
 * cleanup arc replaced these with `require()` inside the factory and
 * `resolveMethod()` from execution/capability-resolver.js. This rule
 * prevents the pattern from regressing.
 *
 * Detection (heuristic, intentionally loud):
 *   - Look for `<container>.register('name', [literal, ...], factory)`.
 *   - For each string literal in the dep array, check it against:
 *     * KNOWN_SERVICES — names registered as services or values in
 *       container.js / aggregators / construction sites
 *     * UTILITY_PATTERN — heuristic for utility-function naming
 *       (verb-shaped camelCase: parse*, build*, compute*, sanitize*,
 *       extract*, resolve*, handle*, runX, getX, isX, hasX, ...)
 *   - Names that match UTILITY_PATTERN and aren't in KNOWN_SERVICES
 *     trigger the rule.
 *
 * Inline suppression: // eslint-disable-next-line torque/no-utility-deps-in-register
 *
 * The KNOWN_SERVICES list is exported so tests and metrics can reuse it.
 */

const path = require('path');

const KNOWN_SERVICES = new Set([
  // Top-level container values + factories registered in container.js
  'db', 'eventBus', 'logger', 'serverConfig', 'dashboard',
  'familyTemplates', 'actionRegistry', 'testRunnerRegistry',
  'constructionCache', 'executor', 'sharedFactoryStore',
  'registeredSpecialists', 'runDirManager',
  'providerScoring', 'providerCircuitBreakerStore',
  'checkpointStore', 'workflowState', 'forker',
  'specialistStorage', 'turnClassifier', 'routedOrchestrator',
  'autoRecoveryServices', 'starvationRecovery',
  // State decomposition values
  'processTracker', 'finalizationTracker', 'closeHandlerState',
  // taskManager + capability decomposition
  'taskManager', 'taskCanceller', 'taskExecutor', 'queueDispatcher',
  'taskStatusUpdater', 'taskFinalizer',
  // Subsystem services (validation/, execution/, factory/, etc.)
  'safeguardGates', 'hashlineVerify', 'buildVerification', 'closePhases',
  'autoVerifyRetry', 'outputSafeguards', 'postTask',
  'planProjectResolver', 'workflowResume', 'workflowRuntime',
  'fallbackRetry', 'retryFramework', 'commandBuilders',
  'fileContextBuilder', 'processStreams', 'debugLifecycle',
  'completionPipeline', 'slotPullScheduler', 'processLifecycle',
  'queueScheduler', 'providerRouter', 'taskStartup',
  'costMetrics', 'factoryFeedback',
  'mcpProtocol', 'agenticCapability',
  // Other registered values from index.js / plugins
  'codebaseStudyHandlers', 'dashboardAdminRoutes',
  'factoryCostMetrics', 'factoryFeedbackAnalysis',
  'graphIndexer', 'mentionResolver', 'repoRegistry',
  'studyTelemetry', 'symbolIndexer', 'toolRouter',
  'v2GovernanceHandlers',
  // Plugin-injected services
  'sandboxManager', 'providerRegistry', 'gpuMetrics',
]);

// Utility-function naming patterns. This is intentionally loud — we'd
// rather flag a real service that just happens to be named like a
// function (and add it to KNOWN_SERVICES) than miss real utility-
// function deps slipping in.
const UTILITY_PATTERN = /^(?:parse|build|compute|sanitize|extract|resolve|handle|run|get|is|has|set|find|detect|format|cleanup|kill|spawn|notify|emit|safe|try|attempt|check|wrap|estimate|pause|step|inject|apply|evaluate|fire|record|register|create|select|categorize|classify|dispatch|track)[A-Z]/;

// Names that look more like constants (UPPER_SNAKE_CASE or all-caps prefix).
const CONSTANT_PATTERN = /^[A-Z][A-Z0-9_]+$/;

function getBasename(filePath) {
  return path.basename(typeof filePath === 'string' ? filePath : '');
}

module.exports = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Discourage utility-function or constant names in container.register() dep arrays. Utility functions should be require()d inside the factory; capability methods should resolve via resolveMethod(). See server/ARCHITECTURE.md.',
    },
    messages: {
      utilityDep:
        "Dep '{{name}}' looks like a utility function or closure, not a container service. Either: (a) require() it inside the factory, (b) resolve via resolveMethod() if it's a capability method, or (c) add it to the KNOWN_SERVICES allowlist in eslint-rules/no-utility-deps-in-register.js if it's actually registered.",
      constantDep:
        "Dep '{{name}}' looks like a constant. Constants should be require()d directly, not threaded through DI.",
    },
    schema: [
      {
        type: 'object',
        properties: {
          allowlist: {
            type: 'array',
            items: { type: 'string' },
            default: [],
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const options = context.options[0] || {};
    const fileAllowlist = new Set(options.allowlist || []);
    const filename = context.filename || (context.getFilename ? context.getFilename() : '');
    const basename = getBasename(filename);
    if (fileAllowlist.has(basename)) return {};

    return {
      CallExpression(node) {
        const callee = node.callee;
        // Match <something>.register(...)
        if (
          !callee ||
          callee.type !== 'MemberExpression' ||
          callee.property.type !== 'Identifier' ||
          callee.property.name !== 'register'
        ) return;

        // First arg must be a string literal (the service name).
        if (node.arguments.length < 2) return;
        const nameArg = node.arguments[0];
        if (nameArg.type !== 'Literal' || typeof nameArg.value !== 'string') return;

        // Second arg must be an array literal (the deps).
        const depsArg = node.arguments[1];
        if (!depsArg || depsArg.type !== 'ArrayExpression') return;

        // Walk each dep literal.
        for (const elem of depsArg.elements) {
          if (!elem || elem.type !== 'Literal' || typeof elem.value !== 'string') continue;
          const depName = elem.value;
          if (KNOWN_SERVICES.has(depName)) continue;

          if (CONSTANT_PATTERN.test(depName)) {
            context.report({
              node: elem,
              messageId: 'constantDep',
              data: { name: depName },
            });
            continue;
          }
          if (UTILITY_PATTERN.test(depName)) {
            context.report({
              node: elem,
              messageId: 'utilityDep',
              data: { name: depName },
            });
          }
        }
      },
    };
  },
};

module.exports.KNOWN_SERVICES = KNOWN_SERVICES;
