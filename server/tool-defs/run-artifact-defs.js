'use strict';

const RUN_ARTIFACT_TOOLS = [
  {
    name: 'build_run_bundle',
    description: 'Manually build (or rebuild) a run artifact bundle for a workflow. Bundles are normally built automatically when a workflow finalizes.',
    inputSchema: {
      type: 'object',
      required: ['workflow_id'],
      properties: {
        workflow_id: { type: 'string' },
      },
    },
  },
  {
    name: 'replay_workflow',
    description: 'Recreate a workflow from a previously-built run bundle. Same DAG and task descriptions; new workflow_id.',
    inputSchema: {
      type: 'object',
      required: ['bundle_dir'],
      properties: {
        bundle_dir: { type: 'string' },
      },
    },
  },
];

module.exports = RUN_ARTIFACT_TOOLS;
module.exports.RUN_ARTIFACT_TOOLS = RUN_ARTIFACT_TOOLS;
