'use strict';

const tools = [
  {
    name: 'vc_create_worktree',
    description: 'Create a tracked git worktree for a feature branch in the target repository.',
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: {
          type: 'string',
          description: 'Absolute path to the git repository root.',
        },
        feature_name: {
          type: 'string',
          description: 'Feature or branch name used to create the worktree.',
        },
        base_branch: {
          type: 'string',
          description: 'Base branch to branch from before creating the worktree.',
          default: 'main',
        },
      },
      required: ['repo_path', 'feature_name'],
      additionalProperties: false,
    },
  },
  {
    name: 'vc_list_worktrees',
    description: 'List tracked git worktrees, optionally scoped to a repository and including stale entries.',
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: {
          type: 'string',
          description: 'Optional absolute repository path used to filter worktrees.',
        },
        include_stale: {
          type: 'boolean',
          description: 'Include stale worktrees in the response.',
          default: false,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'vc_switch_worktree',
    description: 'Resolve a tracked worktree by id and return its filesystem path for changing directories.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Tracked worktree id.',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'vc_merge_worktree',
    description: 'Merge a tracked worktree branch back into its target branch using the requested strategy.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Tracked worktree id.',
        },
        strategy: {
          type: 'string',
          enum: ['merge', 'squash', 'rebase'],
          description: 'Merge strategy to use when integrating the worktree branch.',
          default: 'merge',
        },
        target_branch: {
          type: 'string',
          description: 'Override the branch that the worktree branch should merge into.',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'vc_cleanup_stale',
    description: 'Find stale tracked worktrees and optionally clean them up.',
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: {
          type: 'string',
          description: 'Optional absolute repository path used to scope stale cleanup.',
        },
        stale_days: {
          type: 'number',
          description: 'Number of inactive days before a worktree is considered stale.',
        },
        dry_run: {
          type: 'boolean',
          description: 'When true, only report stale worktrees without deleting them.',
          default: false,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'vc_generate_commit',
    description: 'Generate and create a conventional commit from staged changes, then record it in vc_commits.',
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: {
          type: 'string',
          description: 'Absolute path to the git repository root.',
        },
        body: {
          type: 'string',
          description: 'Optional commit body to append after the generated subject line.',
        },
        co_author: {
          type: 'string',
          description: 'Optional co-author trailer, for example "Jane Doe <jane@example.com>".',
        },
      },
      required: ['repo_path'],
      additionalProperties: false,
    },
  },
  {
    name: 'vc_commit_status',
    description: 'Return staged, unstaged, and untracked file counts for the target repository.',
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: {
          type: 'string',
          description: 'Absolute path to the git repository root.',
        },
      },
      required: ['repo_path'],
      additionalProperties: false,
    },
  },
  {
    name: 'vc_get_policy',
    description: 'Return the effective version control policy configuration for the target repository.',
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: {
          type: 'string',
          description: 'Absolute path to the git repository root.',
        },
      },
      required: ['repo_path'],
      additionalProperties: false,
    },
  },
];

module.exports = tools;
