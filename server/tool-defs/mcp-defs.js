'use strict';

module.exports = [
  {
    name: 'register_action_schema',
    description: 'Register a JSON schema + handlers for an action surface. Handlers may be explicit tool mappings or omitted when action names match existing TORQUE tools.',
    inputSchema: {
      type: 'object',
      properties: {
        surface: {
          type: 'string',
          description: 'Action surface name, for example "workflow" or "task".',
        },
        description: {
          type: 'string',
          description: 'Optional human-readable description for the action surface.',
        },
        schema: {
          type: 'object',
          description: 'JSON schema union for the surface. Each action variant should include an actionName const discriminator.',
        },
        handlers: {
          type: 'object',
          description: 'Optional actionName -> tool mapping. Values may be a TORQUE tool name string or an object with tool, arg_map, fixed_args, include_action, and include_context.',
          additionalProperties: {
            anyOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  tool: { type: 'string' },
                  arg_map: { type: 'object' },
                  fixed_args: { type: 'object' },
                  include_action: { type: 'boolean' },
                  include_context: { type: 'boolean' },
                },
                required: ['tool'],
              },
            ],
          },
        },
      },
      required: ['surface', 'schema'],
    },
  },
  {
    name: 'list_actions',
    description: 'List known action surfaces and their registered actionName values.',
    inputSchema: {
      type: 'object',
      properties: {
        surface: {
          type: 'string',
          description: 'Optional surface name to inspect.',
        },
      },
      required: [],
    },
  },
  {
    name: 'dispatch_nl',
    description: 'Translate a natural-language utterance into a typed action + execute. Uses construction cache first, LLM translator as fallback.',
    inputSchema: {
      type: 'object',
      properties: {
        surface: {
          type: 'string',
          description: 'Registered action surface to target.',
        },
        utterance: {
          type: 'string',
          description: 'Natural-language operator request to translate and dispatch.',
        },
        learn_on_success: {
          type: 'boolean',
          description: 'Reserved for future construction learning. Defaults to true.',
          default: true,
        },
      },
      required: ['surface', 'utterance'],
    },
  },
  {
    name: 'action_app_run',
    description: 'Create and run an action application. Actions are registered JS (vm2-sandboxed).',
    inputSchema: {
      type: 'object',
      required: ['actions', 'initial_state'],
      properties: {
        actions: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'reads', 'writes', 'run_js'],
            properties: {
              name: { type: 'string' },
              reads: { type: 'array' },
              writes: { type: 'array' },
              run_js: { type: 'string' },
            },
          },
        },
        transitions: { type: 'object' },
        initial_state: { type: 'object' },
        app_id: { type: 'string' },
      },
    },
  },
  {
    name: 'action_app_fork',
    description: 'Fork an existing app at a given sequence_id into a new app.',
    inputSchema: {
      type: 'object',
      required: ['app_id', 'sequence_id'],
      properties: {
        app_id: { type: 'string' },
        sequence_id: { type: 'number' },
        new_app_id: { type: 'string' },
      },
    },
  },
  {
    name: 'action_app_history',
    description: 'Return the ordered history of snapshots for an app.',
    inputSchema: {
      type: 'object',
      required: ['app_id'],
      properties: {
        app_id: { type: 'string' },
        partition_key: { type: 'string' },
      },
    },
  },
  {
    name: 'dispatch_subagent',
    description: 'Dispatch a Claude Code subagent with isolated context + restricted tool list + optional skill. Returns subagent result only.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
        },
        model: {
          type: 'string',
        },
        allowed_tools: {
          type: 'array',
          items: { type: 'string' },
        },
        disallowed_tools: {
          type: 'array',
          items: { type: 'string' },
        },
        mode: {
          type: 'string',
          enum: ['auto', 'acceptEdits', 'plan', 'bypassPermissions'],
        },
        skill: {
          type: 'string',
        },
        timeout_ms: {
          type: 'integer',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'resume_session',
    description: 'Resume a prior Claude Code session by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
        },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'fork_session',
    description: 'Fork a prior session into a new branch.',
    inputSchema: {
      type: 'object',
      properties: {
        source_session_id: {
          type: 'string',
        },
        name: {
          type: 'string',
        },
      },
      required: ['source_session_id'],
    },
  },
  {
    name: 'list_sessions',
    description: 'List Claude Code sessions.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'save_memory',
    description: 'Save a memory of kind semantic|episodic|procedural with namespace support.',
    inputSchema: {
      type: 'object',
      required: ['kind', 'content'],
      properties: {
        kind: { enum: ['semantic', 'episodic', 'procedural'] },
        content: { type: 'string', description: 'Body; for episodic pass JSON {input,output,rationale}.' },
        role: { type: 'string', description: 'Required when kind=procedural (e.g. planner, reviewer).' },
        namespace: { type: 'string', description: 'Template like {user_id}/{project_id}; resolved on save.' },
        vars: { type: 'object' },
        embedding: { type: 'array', items: { type: 'number' } },
      },
    },
  },
  {
    name: 'search_memory',
    description: 'Search memories by kind + namespace + optional similarity query.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string' },
        namespace: { type: 'string' },
        query: { type: 'string' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'optimize_prompt',
    description: 'Run a prompt optimizer over a role\'s current prompt using the given trajectory + feedback.',
    inputSchema: {
      type: 'object',
      required: ['role', 'strategy'],
      properties: {
        role: { type: 'string' },
        strategy: { enum: ['metaprompt', 'gradient', 'prompt_memory'] },
        trajectory: { type: 'array' },
        feedback: { type: 'array', items: { type: 'string' } },
        apply: { type: 'boolean', description: 'If true, overwrite the procedural memory with the optimized prompt.' },
      },
    },
  },
  {
    name: 'reflect_on_run',
    description: 'Schedule a debounced background reflection pass over a run_id; extracts episodic memories + proposed procedural updates.',
    inputSchema: {
      type: 'object',
      required: ['run_id'],
      properties: {
        run_id: { type: 'string' },
      },
    },
  },
  {
    name: 'read_transcript',
    description: 'Read a task transcript from its run directory.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID whose transcript should be read.',
        },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'edit_transcript',
    description: 'Replace a task transcript with a validated message list.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID whose transcript should be replaced.',
        },
        messages: {
          type: 'array',
          description: 'Validated transcript messages to persist.',
          items: {
            type: 'object',
          },
        },
      },
      required: ['task_id', 'messages'],
    },
  },
  {
    name: 'replay_from_transcript',
    description: 'Create a replay task that resumes from an edited transcript.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Original task ID whose transcript should seed the replay.',
        },
      },
      required: ['task_id'],
    },
  },
];
