/**
 * Task Manager Delegation Stubs
 * Extracted from task-manager.js (Phase D3)
 *
 * Pure pass-through functions that delegate to sub-modules.
 * Every function here follows the pattern:
 *   function name(...args) { return module.method(...args); }
 *
 * Grouped by target sub-module for readability.
 */

const hashlineParser = require('./utils/hashline-parser');
const fileResolution = require('./utils/file-resolution');
const hostMonitoring = require('./utils/host-monitoring');
const activityMonitoring = require('./utils/activity-monitoring');
const _executionModule = require('./providers/execution');
const _postTaskModule = require('./validation/post-task');
const _fallbackRetryModule = require('./execution/fallback-retry');
const _workflowRuntimeModule = require('./execution/workflow-runtime');
const _outputSafeguards = require('./validation/output-safeguards');
const _orphanCleanup = require('./maintenance/orphan-cleanup');
const _instanceManager = require('./coordination/instance-manager');
const _promptsModule = require('./providers/prompts');
const _hashlineVerify = require('./validation/hashline-verify');
const _closePhases = require('./validation/close-phases');
const _completionPipeline = require('./execution/completion-pipeline');
const _taskFinalizer = require('./execution/task-finalizer');
const _queueScheduler = require('./execution/queue-scheduler');
const _sandboxRevertDetection = require('./execution/sandbox-revert-detection');

// ─── utils/hashline-parser.js ─────────────────────────────────────────────
function computeLineHash(...args) { return hashlineParser.computeLineHash(...args); }
function lineSimilarity(...args) { return hashlineParser.lineSimilarity(...args); }
function parseHashlineLiteEdits(...args) { return hashlineParser.parseHashlineLiteEdits(...args); }
function findSearchMatch(...args) { return hashlineParser.findSearchMatch(...args); }
function applyHashlineLiteEdits(...args) { return hashlineParser.applyHashlineLiteEdits(...args); }
function parseHashlineEdits(...args) { return hashlineParser.parseHashlineEdits(...args); }
function applyHashlineEdits(...args) { return hashlineParser.applyHashlineEdits(...args); }

// ─── validation/hashline-verify.js ────────────────────────────────────────
function verifyHashlineReferences(...args) { return _hashlineVerify.verifyHashlineReferences(...args); }
function attemptFuzzySearchRepair(...args) { return _hashlineVerify.attemptFuzzySearchRepair(...args); }

// ─── utils/file-resolution.js ─────────────────────────────────────────────
function isShellSafe(...args) { return fileResolution.isShellSafe(...args); }
function extractTargetFilesFromDescription(...args) { return fileResolution.extractTargetFilesFromDescription(...args); }
function buildFileIndex(...args) { return fileResolution.buildFileIndex(...args); }
function extractFileReferencesExpanded(...args) { return fileResolution.extractFileReferencesExpanded(...args); }
function resolveFileReferences(...args) { return fileResolution.resolveFileReferences(...args); }
function isValidFilePath(...args) { return fileResolution.isValidFilePath(...args); }
function extractModifiedFiles(...args) { return fileResolution.extractModifiedFiles(...args); }

// ─── utils/host-monitoring.js ─────────────────────────────────────────────
function isModelLoadedOnHost(...args) { return hostMonitoring.isModelLoadedOnHost(...args); }
function getHostActivity() { return hostMonitoring.getHostActivity(); }
async function pollHostActivity() { return hostMonitoring.pollHostActivity(); }
async function probeLocalGpuMetrics(...args) { return hostMonitoring.probeLocalGpuMetrics(...args); }
async function probeRemoteGpuMetrics(...args) { return hostMonitoring.probeRemoteGpuMetrics(...args); }

// ─── utils/activity-monitoring.js ─────────────────────────────────────────
function getTaskActivity(...args) { return activityMonitoring.getTaskActivity(...args); }
function getAllTaskActivity() { return activityMonitoring.getAllTaskActivity(); }
function canAcceptTask() { return activityMonitoring.canAcceptTask(); }

// ─── coordination/instance-manager.js ─────────────────────────────────────
function registerInstance() { return _instanceManager.registerInstance(); }
function startInstanceHeartbeat() { return _instanceManager.startInstanceHeartbeat(); }
function stopInstanceHeartbeat() { return _instanceManager.stopInstanceHeartbeat(); }
function unregisterInstance() { return _instanceManager.unregisterInstance(); }
function updateInstanceInfo(...args) { return _instanceManager.updateInstanceInfo(...args); }
function isInstanceAlive(...args) { return _instanceManager.isInstanceAlive(...args); }
function getMcpInstanceId() { return _instanceManager.getMcpInstanceId(); }

// ─── validation/post-task.js ──────────────────────────────────────────────
function cleanupJunkFiles(...args) { return _postTaskModule.cleanupJunkFiles(...args); }
function getFileChangesForValidation(...args) { return _postTaskModule.getFileChangesForValidation(...args); }
function findPlaceholderArtifacts(...args) { return _postTaskModule.findPlaceholderArtifacts(...args); }
function checkFileQuality(...args) { return _postTaskModule.checkFileQuality(...args); }
function checkDuplicateFiles(...args) { return _postTaskModule.checkDuplicateFiles(...args); }
function checkSyntax(...args) { return _postTaskModule.checkSyntax(...args); }
function runLLMSafeguards(...args) { return _postTaskModule.runLLMSafeguards(...args); }
function runBuildVerification(...args) { return _postTaskModule.runBuildVerification(...args); }
function runTestVerification(...args) { return _postTaskModule.runTestVerification(...args); }
function runStyleCheck(...args) { return _postTaskModule.runStyleCheck(...args); }
function rollbackTaskChanges(...args) { return _postTaskModule.rollbackTaskChanges(...args); }
function revertScopedFiles(...args) { return _postTaskModule.revertScopedFiles(...args); }
function scopedRollback(...args) { return _postTaskModule.scopedRollback(...args); }

// ─── providers/prompts.js ─────────────────────────────────────────────────
function detectTaskTypes(...args) { return _promptsModule.detectTaskTypes(...args); }
function getInstructionTemplate(...args) { return _promptsModule.getInstructionTemplate(...args); }
function wrapWithInstructions(...args) { return _promptsModule.wrapWithInstructions(...args); }

// ─── providers/execution.js ───────────────────────────────────────────────
async function executeApiProvider(...args) { return _executionModule.executeApiProvider(...args); }
async function executeOllamaTask(...args) { return _executionModule.executeOllamaTask(...args); }
async function executeHashlineOllamaTask(...args) { return _executionModule.executeHashlineOllamaTask(...args); }

// ─── execution/fallback-retry.js ──────────────────────────────────────────
function tryOllamaCloudFallback(...args) { return _fallbackRetryModule.tryOllamaCloudFallback(...args); }
function tryLocalFirstFallback(...args) { return _fallbackRetryModule.tryLocalFirstFallback(...args); }
function classifyError(...args) { return _fallbackRetryModule.classifyError(...args); }
function findNextHashlineModel(...args) { return _fallbackRetryModule.findNextHashlineModel(...args); }
function tryHashlineTieredFallback(...args) { return _fallbackRetryModule.tryHashlineTieredFallback(...args); }
function selectHashlineFormat(...args) { return _fallbackRetryModule.selectHashlineFormat(...args); }

// ─── execution/workflow-runtime.js ────────────────────────────────────────
function handlePipelineStepCompletion(...args) { return _workflowRuntimeModule.handlePipelineStepCompletion(...args); }
function handleWorkflowTermination(...args) { return _workflowRuntimeModule.handleWorkflowTermination(...args); }
function evaluateWorkflowDependencies(...args) { return _workflowRuntimeModule.evaluateWorkflowDependencies(...args); }
function unblockTask(...args) { return _workflowRuntimeModule.unblockTask(...args); }
function applyFailureAction(...args) { return _workflowRuntimeModule.applyFailureAction(...args); }
function cancelDependentTasks(...args) { return _workflowRuntimeModule.cancelDependentTasks(...args); }
function checkWorkflowCompletion(...args) { return _workflowRuntimeModule.checkWorkflowCompletion(...args); }

// ─── validation/output-safeguards.js ──────────────────────────────────────
async function runOutputSafeguards(...args) { return _outputSafeguards.runOutputSafeguards(...args); }

// ─── execution/sandbox-revert-detection.js ────────────────────────────────
function handleSandboxRevertDetection(...args) { return _sandboxRevertDetection.detectSandboxReverts(...args); }

// ─── validation/close-phases.js ───────────────────────────────────────────
function handleAutoValidation(...args) { return _closePhases.handleAutoValidation(...args); }
function handleBuildTestStyleCommit(...args) { return _closePhases.handleBuildTestStyleCommit(...args); }
function handleProviderFailover(...args) { return _closePhases.handleProviderFailover(...args); }

// ─── execution/completion-pipeline.js ─────────────────────────────────────
function recordModelOutcome(...args) { return _completionPipeline.recordModelOutcome(...args); }
function recordProviderHealth(...args) { return _completionPipeline.recordProviderHealth(...args); }
function fireTerminalTaskHook(...args) { return _completionPipeline.fireTerminalTaskHook(...args); }
function handlePostCompletion(...args) { return _completionPipeline.handlePostCompletion(...args); }

// ─── execution/task-finalizer.js ──────────────────────────────────────────
function finalizeTask(...args) { return _taskFinalizer.finalizeTask(...args); }

// ─── execution/queue-scheduler.js ─────────────────────────────────────────
function categorizeQueuedTasks(...args) { return _queueScheduler.categorizeQueuedTasks(...args); }
function processQueueInternal(...args) { return _queueScheduler.processQueueInternal(...args); }

// ─── maintenance/orphan-cleanup.js ────────────────────────────────────────
function cleanupOrphanedHostTasks(...args) { return _orphanCleanup.cleanupOrphanedHostTasks(...args); }
function getStallThreshold(...args) { return _orphanCleanup.getStallThreshold(...args); }

module.exports = {
  // hashline-parser
  computeLineHash, lineSimilarity,
  parseHashlineLiteEdits, findSearchMatch, applyHashlineLiteEdits,
  parseHashlineEdits, applyHashlineEdits,
  // file-resolution
  isShellSafe, extractTargetFilesFromDescription,
  buildFileIndex, extractFileReferencesExpanded, resolveFileReferences,
  isValidFilePath, extractModifiedFiles,
  // host-monitoring
  isModelLoadedOnHost, getHostActivity, pollHostActivity,
  probeLocalGpuMetrics, probeRemoteGpuMetrics,
  // activity-monitoring
  getTaskActivity, getAllTaskActivity, canAcceptTask,
  // instance-manager
  registerInstance, startInstanceHeartbeat, stopInstanceHeartbeat,
  unregisterInstance, updateInstanceInfo, isInstanceAlive, getMcpInstanceId,
  // post-task
  cleanupJunkFiles, getFileChangesForValidation, findPlaceholderArtifacts,
  checkFileQuality, checkDuplicateFiles, checkSyntax, runLLMSafeguards,
  runBuildVerification, runTestVerification, runStyleCheck,
  rollbackTaskChanges, revertScopedFiles, scopedRollback,
  // prompts
  detectTaskTypes, getInstructionTemplate, wrapWithInstructions,
  // execution
  executeApiProvider, executeOllamaTask,
  executeHashlineOllamaTask,
  // fallback-retry
  tryOllamaCloudFallback, tryLocalFirstFallback, classifyError,
  findNextHashlineModel, tryHashlineTieredFallback, selectHashlineFormat,
  // workflow-runtime
  handlePipelineStepCompletion, handleWorkflowTermination,
  evaluateWorkflowDependencies, unblockTask, applyFailureAction,
  cancelDependentTasks, checkWorkflowCompletion,
  // output-safeguards
  runOutputSafeguards,
  // sandbox-revert-detection
  handleSandboxRevertDetection,
  // close-phases
  handleAutoValidation, handleBuildTestStyleCommit, handleProviderFailover,
  // completion-pipeline
  recordModelOutcome, recordProviderHealth,
  fireTerminalTaskHook, handlePostCompletion,
  // task-finalizer
  finalizeTask,
  // queue-scheduler
  categorizeQueuedTasks, processQueueInternal,
  // hashline-verify
  verifyHashlineReferences, attemptFuzzySearchRepair,
  // orphan-cleanup
  cleanupOrphanedHostTasks, getStallThreshold,
};
