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
          description: 'Use HTTPS when contacting the remote agent (default: false)',
          default: false
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
  }
];

module.exports = tools;
