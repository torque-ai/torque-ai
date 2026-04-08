'use strict';

const tools = [
  {
    name: 'list_proposals',
    description: 'List OpenClaw follow-up task proposals, filterable by project and status.',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Optional project filter.',
        },
        status: {
          type: 'string',
          description: 'Optional status filter (pending, pending_approval, approved, rejected).',
        },
        limit: {
          type: 'number',
          description: 'Maximum proposals to return (default: 50).',
        },
      },
    },
  },
  {
    name: 'approve_proposal',
    description: 'Approve an OpenClaw proposal and submit it through smart_submit_task.',
    inputSchema: {
      type: 'object',
      properties: {
        proposal_id: {
          type: 'string',
          description: 'Proposal ID to approve.',
        },
      },
      required: ['proposal_id'],
    },
  },
  {
    name: 'reject_proposal',
    description: 'Reject an OpenClaw proposal without submitting it.',
    inputSchema: {
      type: 'object',
      properties: {
        proposal_id: {
          type: 'string',
          description: 'Proposal ID to reject.',
        },
      },
      required: ['proposal_id'],
    },
  },
  {
    name: 'configure_openclaw_advisor',
    description: 'Enable or disable the OpenClaw advisor and configure provider, project filters, and max proposals.',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: {
          type: 'boolean',
          description: 'Enable or disable the advisor.',
        },
        provider: {
          type: 'string',
          description: 'Provider used to generate proposals (for example: codex or ollama).',
        },
        max_proposals: {
          type: 'number',
          description: 'Maximum proposals generated per completed task (clamped to 3).',
        },
        projects: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional allowlist of projects. Empty means all projects when enabled.',
        },
      },
    },
  },
];

module.exports = tools;
