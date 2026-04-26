'use strict';

/**
 * tool-registry.js — thin metadata module.
 *
 * Exports TOOLS (tool-def array), schemaMap, routeMap (populated by tools.js),
 * and decorateToolDefinition — WITHOUT loading any handler modules.
 *
 * Cold-import target: <30ms (no handler loading, no logger, no event-bus).
 *
 * tools.js re-exports everything from here and additionally builds routeMap
 * by iterating over HANDLER_MODULES. It calls populateRouteMap() below to
 * store the result so tests that import tool-registry.js after tools.js has
 * run will see the complete map.
 */

const { applyBehavioralTags } = require('./tools/behavioral-tags');
const { getAnnotations } = require('./tool-annotations');
const { getOutputSchema } = require('./tool-output-schemas');

const workflowSpecToolDefs = require('./tool-defs/workflow-spec-defs');
const WORKFLOW_SPEC_TOOLS = Array.isArray(workflowSpecToolDefs)
  ? workflowSpecToolDefs
  : workflowSpecToolDefs.WORKFLOW_SPEC_TOOLS;

const workflowResumeToolDefs = require('./tool-defs/workflow-resume-defs');
const WORKFLOW_RESUME_TOOLS = Array.isArray(workflowResumeToolDefs)
  ? workflowResumeToolDefs
  : workflowResumeToolDefs.WORKFLOW_RESUME_TOOLS;

const eventToolDefs = require('./tool-defs/event-defs');
const EVENT_TOOLS = Array.isArray(eventToolDefs)
  ? eventToolDefs
  : eventToolDefs.EVENT_TOOLS;

const runArtifactToolDefs = require('./tool-defs/run-artifact-defs');
const RUN_ARTIFACT_TOOLS = Array.isArray(runArtifactToolDefs)
  ? runArtifactToolDefs
  : runArtifactToolDefs.RUN_ARTIFACT_TOOLS;

const competitiveFeatureDefs = require('./tool-defs/competitive-feature-defs');

const TOOLS = [
  ...require('./tool-defs/core-defs'),
  ...require('./tool-defs/task-submission-defs'),
  ...require('./tool-defs/task-management-defs'),
  ...require('./tool-defs/task-defs'),
  ...require('./tool-defs/workflow-defs'),
  ...WORKFLOW_RESUME_TOOLS,
  ...WORKFLOW_SPEC_TOOLS,
  ...EVENT_TOOLS,
  ...RUN_ARTIFACT_TOOLS,
  ...require('./tool-defs/baseline-defs'),
  ...require('./tool-defs/checkpoint-defs'),
  ...require('./tool-defs/approval-defs'),
  ...require('./tool-defs/validation-defs'),
  ...require('./tool-defs/provider-defs'),
  ...require('./tool-defs/provider-crud-defs'),
  ...require('./tool-defs/ci-defs'),
  ...require('./tool-defs/webhook-defs'),
  ...require('./tool-defs/intelligence-defs'),
  ...require('./tool-defs/advanced-defs'),
  ...require('./tool-defs/integration-defs'),
  ...require('./tool-defs/automation-defs'),
  ...require('./tool-defs/comparison-defs'),
  ...require('./tool-defs/hashline-defs'),
  ...require('./tool-defs/tsserver-defs'),
  ...require('./tool-defs/policy-defs'),
  ...require('./tool-defs/governance-defs'),
  ...require('./tool-defs/evidence-risk-defs'),
  ...require('./tool-defs/conflict-resolution-defs'),
  ...require('./tool-defs/orchestrator-defs'),
  ...require('./tool-defs/experiment-defs'),
  ...require('./tool-defs/audit-defs'),
  ...require('./tool-defs/workstation-defs'),
  ...require('./tool-defs/concurrency-defs'),
  ...require('./tool-defs/model-defs'),
  ...require('./tool-defs/discovery-defs'),
  ...require('./tool-defs/agent-discovery-defs'),
  ...require('./tool-defs/circuit-breaker-defs'),
  ...require('./tool-defs/budget-watcher-defs'),
  ...require('./tool-defs/provider-scoring-defs'),
  ...require('./tool-defs/routing-template-defs'),
  ...require('./tool-defs/strategic-config-defs'),
  ...require('./tool-defs/context-defs'),
  ...require('./tool-defs/codebase-study-defs'),
  ...require('./tool-defs/mcp-defs'),
  ...require('./tool-defs/managed-oauth-defs'),
  ...require('./tool-defs/pattern-defs'),
  ...competitiveFeatureDefs,
  ...require('./tool-defs/review-defs'),
  ...require('./tool-defs/symbol-indexer-defs'),
  ...require('./tool-defs/template-defs'),
  ...require('./tool-defs/diffusion-defs'),
  ...require('./tool-defs/factory-defs'),
];

function toBehavioralAnnotationSnapshot(tool) {
  return {
    readOnlyHint: Boolean(tool.readOnlyHint),
    destructiveHint: Boolean(tool.destructiveHint),
    idempotentHint: Boolean(tool.idempotentHint),
    openWorldHint: Boolean(tool.openWorldHint),
  };
}

function decorateToolDefinition(tool, hintSource) {
  if (!tool || !tool.name) {
    return tool;
  }
  const hints = hintSource || tool.annotations || getAnnotations(tool.name);
  const taggedTool = applyBehavioralTags(tool, hints);
  taggedTool.annotations = toBehavioralAnnotationSnapshot(taggedTool);
  return taggedTool;
}

// Apply behavioral decorations to all tools at module-load time.
for (const tool of TOOLS) {
  if (tool && tool.name) {
    Object.assign(tool, decorateToolDefinition(tool));
  }
}

// Apply output schemas to all tools.
for (const tool of TOOLS) {
  if (tool && tool.name) {
    const schema = getOutputSchema(tool.name);
    if (schema) tool.outputSchema = schema;
  }
}

// Schema lookup map (tool name → inputSchema).
// Built once at module load; tools.js re-exports this Map.
const schemaMap = new Map();
for (const def of TOOLS) {
  if (def && def.name && def.inputSchema) {
    schemaMap.set(def.name, def.inputSchema);
  }
}

// Route map — populated by tools.js after it builds the handler dispatch table.
// Tests that import tool-registry.js directly (without tools.js having run)
// will see an empty Map. That is intentional: this thin module does not load handlers.
const routeMap = new Map();

/**
 * Called by tools.js after it builds routeMap from HANDLER_MODULES.
 * Transfers all entries into this shared Map so callers that imported
 * tool-registry.js before tools.js also see the complete route table.
 */
function populateRouteMap(sourceMap) {
  for (const [key, value] of sourceMap) {
    routeMap.set(key, value);
  }
}

module.exports = {
  TOOLS,
  schemaMap,
  routeMap,
  decorateToolDefinition,
  populateRouteMap,
};
