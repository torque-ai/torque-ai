'use strict';

const GOVERNANCE_MODES = ['block', 'warn', 'shadow', 'off'];

module.exports = [
  {
    name: 'get_governance_rules',
    description: 'List operational governance rules with enforcement mode, enabled state, and violation counts.',
    inputSchema: {
      type: 'object',
      properties: {
        stage: {
          type: 'string',
          description: 'Optional stage filter for governance rules.',
        },
        enabled_only: {
          type: 'boolean',
          description: 'When true, only include enabled governance rules.',
        },
      },
      required: [],
    },
  },
  {
    name: 'set_governance_rule_mode',
    description: 'Change enforcement mode for a governance rule.',
    inputSchema: {
      type: 'object',
      properties: {
        rule_id: {
          type: 'string',
          description: 'Governance rule ID to update.',
        },
        mode: {
          type: 'string',
          enum: GOVERNANCE_MODES,
          description: 'New governance enforcement mode.',
        },
      },
      required: ['rule_id', 'mode'],
    },
  },
  {
    name: 'toggle_governance_rule',
    description: 'Enable or disable a governance rule.',
    inputSchema: {
      type: 'object',
      properties: {
        rule_id: {
          type: 'string',
          description: 'Governance rule ID to toggle.',
        },
        enabled: {
          type: 'boolean',
          description: 'Whether the governance rule should be enabled.',
        },
      },
      required: ['rule_id', 'enabled'],
    },
  },
];
