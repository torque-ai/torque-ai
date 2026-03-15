'use strict';

const POLICY_STAGES = [
  'task_submit',
  'task_pre_execute',
  'task_complete',
  'workflow_submit',
  'workflow_run',
  'manual_review',
];

const POLICY_MODES = ['off', 'shadow', 'advisory', 'warn', 'block'];
const POLICY_OUTCOMES = ['pass', 'fail', 'skipped', 'degraded', 'overridden'];

const tools = [
  {
    name: 'list_policies',
    description: 'List policy rules, optionally scoped to a project or profile and filtered by category, stage, mode, and enabled state.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: 'Project ID used to resolve the bound policy profile before filtering rules.',
        },
        profile_id: {
          type: 'string',
          description: 'Policy profile ID used to scope results to rules bound to that profile.',
        },
        category: {
          type: 'string',
          description: 'Filter by policy category.',
        },
        stage: {
          type: 'string',
          enum: POLICY_STAGES,
          description: 'Filter by policy stage.',
        },
        mode: {
          type: 'string',
          enum: POLICY_MODES,
          description: 'Filter by policy mode. When scoped to a profile or project, this applies to the effective mode.',
        },
        enabled_only: {
          type: 'boolean',
          description: 'Only return enabled policies and bindings.',
        },
      },
    },
  },
  {
    name: 'get_policy',
    description: 'Fetch a single policy rule by policy ID.',
    inputSchema: {
      type: 'object',
      properties: {
        policy_id: {
          type: 'string',
          description: 'Policy rule ID to fetch.',
        },
      },
      required: ['policy_id'],
    },
  },
  {
    name: 'set_policy_mode',
    description: 'Update a policy rule mode and record the human reason for the change in the tool response.',
    inputSchema: {
      type: 'object',
      properties: {
        policy_id: {
          type: 'string',
          description: 'Policy rule ID to update.',
        },
        mode: {
          type: 'string',
          enum: POLICY_MODES,
          description: 'New policy mode.',
        },
        reason: {
          type: 'string',
          description: 'Human-readable reason for changing the policy mode.',
        },
      },
      required: ['policy_id', 'mode', 'reason'],
    },
  },
  {
    name: 'evaluate_policies',
    description: 'Evaluate policies for a given stage and target, optionally including project context, changed files, evidence, and override decisions.',
    inputSchema: {
      type: 'object',
      properties: {
        stage: {
          type: 'string',
          enum: POLICY_STAGES,
          description: 'Policy evaluation stage.',
        },
        target_type: {
          type: 'string',
          description: 'Target type such as task or workflow.',
        },
        target_id: {
          type: 'string',
          description: 'Unique target identifier.',
        },
        project_id: {
          type: 'string',
          description: 'Project ID used to resolve the applicable policy profile.',
        },
        profile_id: {
          type: 'string',
          description: 'Explicit policy profile ID to use for evaluation.',
        },
        project_path: {
          type: 'string',
          description: 'Project path used for matcher evaluation.',
        },
        provider: {
          type: 'string',
          description: 'Execution provider context.',
        },
        changed_files: {
          type: 'array',
          description: 'Changed file paths used by matchers and evidence adapters.',
          items: {
            type: 'string',
          },
        },
        evidence: {
          type: 'object',
          description: 'Optional evidence object merged into the evaluation context.',
        },
        force_rescan: {
          type: 'boolean',
          description: 'Disable replay suppression for this evaluation run.',
        },
        persist: {
          type: 'boolean',
          description: 'Persist evaluation history (default: true).',
        },
        override_decisions: {
          type: 'array',
          description: 'Optional override decisions to apply to individual policy results after evaluation.',
          items: {
            type: 'object',
            properties: {
              policy_id: {
                type: 'string',
                description: 'Policy ID to override.',
              },
              decision: {
                type: 'string',
                description: 'Override decision label.',
              },
              reason_code: {
                type: 'string',
                description: 'Reason code recorded with the override.',
              },
              notes: {
                type: 'string',
                description: 'Free-form override notes.',
              },
              actor: {
                type: 'string',
                description: 'Human or system actor recording the override.',
              },
              expires_at: {
                type: 'string',
                format: 'date-time',
                description: 'Optional override expiration timestamp.',
              },
            },
            required: ['policy_id'],
          },
        },
      },
      required: ['stage', 'target_type', 'target_id'],
    },
  },
  {
    name: 'list_policy_evaluations',
    description: 'List policy evaluation history with filters for project, policy, profile, stage, outcome, target, suppression state, and pagination.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: 'Filter by project ID.',
        },
        policy_id: {
          type: 'string',
          description: 'Filter by policy ID.',
        },
        profile_id: {
          type: 'string',
          description: 'Filter by profile ID.',
        },
        stage: {
          type: 'string',
          enum: POLICY_STAGES,
          description: 'Filter by policy stage.',
        },
        outcome: {
          type: 'string',
          enum: POLICY_OUTCOMES,
          description: 'Filter by evaluation outcome.',
        },
        suppressed: {
          type: 'boolean',
          description: 'Filter by suppression state.',
        },
        target_type: {
          type: 'string',
          description: 'Filter by target type.',
        },
        target_id: {
          type: 'string',
          description: 'Filter by target ID.',
        },
        scope_fingerprint: {
          type: 'string',
          description: 'Filter by scope fingerprint.',
        },
        include_overrides: {
          type: 'boolean',
          description: 'Include override history for each evaluation.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of evaluations to return.',
        },
        offset: {
          type: 'integer',
          description: 'Pagination offset.',
        },
      },
    },
  },
  {
    name: 'override_policy_decision',
    description: 'Record a human override decision for a policy evaluation with a reason code.',
    inputSchema: {
      type: 'object',
      properties: {
        evaluation_id: {
          type: 'string',
          description: 'Policy evaluation ID to override.',
        },
        policy_id: {
          type: 'string',
          description: 'Optional policy ID. Must match the evaluation policy when supplied.',
        },
        decision: {
          type: 'string',
          description: 'Override decision label (default: "override").',
        },
        reason_code: {
          type: 'string',
          description: 'Reason code recorded with the human override.',
        },
        notes: {
          type: 'string',
          description: 'Optional human notes describing the override.',
        },
        actor: {
          type: 'string',
          description: 'Human or system actor recording the override.',
        },
        expires_at: {
          type: 'string',
          format: 'date-time',
          description: 'Optional override expiration timestamp.',
        },
      },
      required: ['evaluation_id', 'reason_code'],
    },
  },
];

module.exports = tools;
