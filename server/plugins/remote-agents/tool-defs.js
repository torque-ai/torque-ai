/**
 * Tool definitions for remote agent handlers
 */

const tools = [
  {
    name: 'register_remote_agent',
    description: 'Register or update a remote execution agent with TORQUE. The agent must be running the TORQUE agent HTTP server. Returns the assigned agent ID.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Human-readable name for the agent (e.g., "BuildServer-01"). Used to generate the agent ID.'
        },
        host: {
          type: 'string',
          description: 'Hostname or IP address of the remote agent (e.g., "192.0.2.50")'
        },
        port: {
          type: 'integer',
          description: 'Port the agent is listening on (default: 3460)',
          default: 3460
        },
        secret: {
          type: 'string',
          description: 'Shared secret for authenticating requests to this agent'
        },
        max_concurrent: {
          type: 'integer',
          description: 'Maximum concurrent tasks this agent can handle (default: 3)',
          default: 3,
          minimum: 0
        },
        tls: {
          type: 'boolean',
          description: 'Use HTTPS when contacting the remote agent (default: true)',
          default: true
        },
        rejectUnauthorized: {
          type: 'boolean',
          description: 'When tls is enabled, require a trusted certificate (default: true)',
          default: true
        }
      },
      required: ['name', 'host', 'secret']
    }
  },
  {
    name: 'list_remote_agents',
    description: 'List all registered remote execution agents with their status, host, and last health check time.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'get_remote_agent',
    description: 'Get a single remote execution agent, including transport settings and health metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: {
          type: 'string',
          description: 'The agent ID to retrieve (e.g., "buildserver-01")'
        }
      },
      required: ['agent_id']
    }
  },
  {
    name: 'remove_remote_agent',
    description: 'Remove a registered remote agent by its ID. Stops routing tasks to it and deletes its configuration.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: {
          type: 'string',
          description: 'The agent ID to remove (e.g., "buildserver-01")'
        }
      },
      required: ['agent_id']
    }
  },
  {
    name: 'check_remote_agent_health',
    description: 'Check the health of one or all remote agents. Returns status, running task count, and system metrics. If agent_id is omitted, checks all enabled agents.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: {
          type: 'string',
          description: 'Specific agent ID to check (omit to check all enabled agents)'
        }
      }
    }
  },
  {
    name: 'run_remote_command',
    description: 'Execute a shell command on the remote test agent. Falls back to local execution if agent unavailable.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Shell command to run'
        },
        working_directory: {
          type: 'string',
          description: 'Project working directory'
        },
        timeout: {
          type: 'number',
          description: 'Timeout in ms (default 300000)',
          default: 300000
        }
      },
      required: ['command', 'working_directory']
    }
  },
  {
    name: 'run_tests',
    description: 'Run project verify_command on remote test agent. Reads verify_command from project defaults.',
    inputSchema: {
      type: 'object',
      properties: {
        working_directory: {
          type: 'string',
          description: 'Project working directory'
        }
      },
      required: ['working_directory']
    }
  },
  {
    name: 'run_code_agent',
    description: 'Execute a JavaScript code snippet in a sandboxed environment following the smolagents CodeAgent pattern. Code is the action language — snippets can use variables, loops, conditionals, and call tools by name. No filesystem, network, or process access is available inside the sandbox. The agent registry routes tool calls within the sandbox through the same remote/local routing as direct tool invocations.',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'JavaScript code snippet to execute. May use top-level await. Access tools via the `tools` object (e.g., `await tools.run_remote_command({ command: "npm test", working_directory: "/repo" })`). Use `console.log()` for output. Return a value with `return`.'
        },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of tool names to make available inside the sandbox (e.g., ["run_remote_command", "run_tests"]). Only execution tools from the remote-agents plugin are supported; admin tools (register, remove, health check) are excluded.'
        },
        context: {
          type: 'object',
          description: 'Key-value pairs made available as the read-only `context` object inside the sandbox. The working_directory and kind fields are automatically injected when provided as top-level parameters.'
        },
        working_directory: {
          type: 'string',
          description: 'Project working directory. Injected into the sandbox context as `context.working_directory` so code snippets can reference project paths without hardcoding them.'
        },
        kind: {
          type: 'string',
          description: 'Task kind identifier (default: "code_agent"). Used by the agent registry to distinguish code_agent tasks from other task types for routing and tracking.',
          default: 'code_agent'
        },
        timeout: {
          type: 'number',
          description: 'Execution timeout in ms (default 10000)',
          default: 10000
        }
      },
      required: ['code']
    }
  }
];

module.exports = tools;
