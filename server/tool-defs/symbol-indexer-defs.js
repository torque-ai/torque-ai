module.exports = [
  {
    name: 'search_symbols',
    description: 'Search indexed code symbols (functions, classes, interfaces) by name. Returns symbol locations without reading full files.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Symbol name to search for' },
        working_directory: { type: 'string', description: 'Project directory' },
        kind: { type: 'string', enum: ['function', 'class', 'interface', 'method', 'type', 'enum', 'const'], description: 'Filter by symbol kind' },
        limit: { type: 'number', description: 'Max results (default: 50)', default: 50 },
      },
      required: ['query', 'working_directory'],
    },
  },
  {
    name: 'get_file_outline',
    description: 'Get a structural outline of a file showing all symbols (functions, classes, methods) with line numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'File to outline' },
        working_directory: { type: 'string', description: 'Project directory' },
      },
      required: ['file_path', 'working_directory'],
    },
  },
  {
    name: 'index_project',
    description: 'Trigger symbol indexing for a project. Incrementally indexes only changed files.',
    inputSchema: {
      type: 'object',
      properties: {
        working_directory: { type: 'string', description: 'Project directory to index' },
      },
      required: ['working_directory'],
    },
  },
  {
    name: 'register_repo',
    description: 'Register a repo for cross-repo code graph queries + @-mention resolution.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Human-readable repo name' },
        root_path: { type: 'string', description: 'Absolute or relative path to the repo root' },
        remote_url: { type: 'string', description: 'Optional remote URL for the repo' },
        default_branch: { type: 'string', description: 'Default branch name (defaults to main)' },
        repo_id: { type: 'string', description: 'Optional stable repo ID override' },
      },
      required: ['name', 'root_path'],
    },
  },
  {
    name: 'list_repos',
    description: 'List registered repos.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'reindex_repo',
    description: 'Rebuild symbol index for a repo.',
    inputSchema: {
      type: 'object',
      properties: {
        repo_id: { type: 'string', description: 'Registered repo ID to reindex' },
      },
      required: ['repo_id'],
    },
  },
  {
    name: 'resolve_mentions',
    description: 'Resolve @-mentions in a string without starting a task.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to parse and resolve for @-mentions' },
      },
      required: ['text'],
    },
  },
];
