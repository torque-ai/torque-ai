/**
 * Tool definitions for tsserver MCP tools
 */

const tools = [
  {
    name: 'tsserver_status',
    description: 'Show status of all persistent tsserver sessions (alive, idle time, open files, cached diagnostics). Useful for debugging tsserver integration.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'tsserver_diagnostics',
    description: 'Get TypeScript diagnostics (errors/warnings) for one or more files using the persistent tsserver daemon. Much faster than cold-start tsc --noEmit.',
    inputSchema: {
      type: 'object',
      properties: {
        working_directory: {
          type: 'string',
          description: 'Project root directory'
        },
        file_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Absolute file paths to check'
        },
        timeout_ms: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 8000)'
        }
      },
      required: ['working_directory', 'file_paths']
    }
  },
  {
    name: 'tsserver_quickinfo',
    description: 'Get type information at a specific position in a TypeScript file. Returns the type signature and documentation.',
    inputSchema: {
      type: 'object',
      properties: {
        working_directory: {
          type: 'string',
          description: 'Project root directory'
        },
        file_path: {
          type: 'string',
          description: 'Absolute file path'
        },
        line: {
          type: 'number',
          description: 'Line number (1-based)'
        },
        offset: {
          type: 'number',
          description: 'Column offset (1-based)'
        }
      },
      required: ['working_directory', 'file_path', 'line', 'offset']
    }
  },
  {
    name: 'tsserver_definition',
    description: 'Go-to-definition for a symbol at a position. Returns the file and location of the definition.',
    inputSchema: {
      type: 'object',
      properties: {
        working_directory: {
          type: 'string',
          description: 'Project root directory'
        },
        file_path: {
          type: 'string',
          description: 'Absolute file path'
        },
        line: {
          type: 'number',
          description: 'Line number (1-based)'
        },
        offset: {
          type: 'number',
          description: 'Column offset (1-based)'
        }
      },
      required: ['working_directory', 'file_path', 'line', 'offset']
    }
  },
];

module.exports = tools;
