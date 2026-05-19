'use strict';

/**
 * server/handlers/retrospective-handlers.js — MCP tool handlers for retrospectives.
 *
 * Three handlers:
 *   handleGetRetrospective      → get_retrospective
 *   handleListRetrospectives    → list_retrospectives
 *   handleGenerateRetrospective → generate_retrospective
 *
 * Retrospectives CRUD is resolved from the DI container; the generator is
 * constructed lazily (same pattern as loop-controller.js) to avoid
 * module-load cycles.
 */

const logger = require('../logger').child({ component: 'retrospective-handlers' });

// ---------------------------------------------------------------------------
// Lazy service resolution
// ---------------------------------------------------------------------------

function getRetrospectivesCrud() {
  const { defaultContainer } = require('../container');
  return defaultContainer.get('retrospectives');
}

let _generator = null;
function getRetrospectiveGenerator() {
  if (!_generator) {
    try {
      const { createRetrospectiveGenerator } = require('../factory/retrospective-generator');
      const { defaultContainer } = require('../container');
      const retrospectives = defaultContainer.get('retrospectives');
      const workflowEngine = require('../db/workflow-engine');
      const costTracking = require('../db/cost-tracking');
      _generator = createRetrospectiveGenerator({
        retrospectives,
        getWorkflowTasks: workflowEngine.getWorkflowTasks,
        getWorkflow: workflowEngine.getWorkflow,
        getTaskTokenUsage: costTracking.getTaskTokenUsage,
      });
    } catch (err) {
      logger.warn('Failed to initialise retrospective generator', { err: err.message });
      _generator = null;
      throw err;
    }
  }
  return _generator;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleGetRetrospective(args) {
  const { workflow_id } = args;
  if (!workflow_id) {
    return { content: [{ type: 'text', text: 'Error: workflow_id is required' }], isError: true };
  }

  const crud = getRetrospectivesCrud();
  const row = crud.getByWorkflowId(workflow_id);
  if (!row) {
    return {
      content: [{ type: 'text', text: `No retrospective found for workflow_id="${workflow_id}"` }],
    };
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(row, null, 2) }],
  };
}

function handleListRetrospectives(args) {
  const { project_id, limit, offset } = args;
  if (!project_id) {
    return { content: [{ type: 'text', text: 'Error: project_id is required' }], isError: true };
  }

  const crud = getRetrospectivesCrud();
  const rows = crud.listByProject(project_id, {
    limit: limit ?? 20,
    offset: offset ?? 0,
  });

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ count: rows.length, retrospectives: rows }, null, 2),
    }],
  };
}

async function handleGenerateRetrospective(args = {}) {
  try {
    const { workflow_id, project_id } = args;
    if (!workflow_id) {
      return { content: [{ type: 'text', text: 'Error: workflow_id is required' }], isError: true };
    }

    const generator = getRetrospectiveGenerator();
    const result = await generator.generateRetrospective(workflow_id, project_id || null);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    logger.error('generate_retrospective failed', {
      workflow_id: args.workflow_id || null,
      project_id: args.project_id || null,
      err: err.message,
    });
    return {
      content: [{ type: 'text', text: `Error generating retrospective: ${err.message}` }],
      isError: true,
    };
  }
}

module.exports = {
  handleGetRetrospective,
  handleListRetrospectives,
  handleGenerateRetrospective,
};
