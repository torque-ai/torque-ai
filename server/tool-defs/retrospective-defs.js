'use strict';

/**
 * Tool definitions for retrospective handlers.
 *
 * Three tools: get_retrospective, list_retrospectives, generate_retrospective.
 * Handler functions live in server/handlers/retrospective-handlers.js and are
 * discovered by the pascalToSnake naming convention in tools.js.
 */

const tools = [
  {
    name: 'get_retrospective',
    description: 'Retrieve a stored retrospective for a completed factory workflow by its workflow ID. Returns the full retrospective including stats, narrative, learnings, friction points, and open items.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow_id: {
          type: 'string',
          description: 'The workflow ID to look up the retrospective for',
        },
      },
      required: ['workflow_id'],
    },
  },
  {
    name: 'list_retrospectives',
    description: 'List retrospectives for a factory project, paginated and ordered newest-first. Returns an array of retrospective summaries.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: 'Project ID to list retrospectives for',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return',
          default: 20,
        },
        offset: {
          type: 'number',
          description: 'Offset for pagination',
          default: 0,
        },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'generate_retrospective',
    description: 'Generate a retrospective for a completed factory workflow. Collects stats from all workflow tasks, optionally calls an LLM for narrative generation, and stores the result. Returns the stored retrospective row.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow_id: {
          type: 'string',
          description: 'The workflow ID to generate a retrospective for',
        },
        project_id: {
          type: 'string',
          description: 'Project ID the workflow belongs to',
        },
      },
      required: ['workflow_id'],
    },
  },
];

module.exports = tools;
