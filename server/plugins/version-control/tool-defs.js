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
        project: {
          type: 'string',
          description: 'Project name for tracking. If omitted, derived from repo_path.',
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
        project: {
          type: 'string',
          description: 'Project name for tracking. If omitted, derived from repo_path.',
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
        project: {
          type: 'string',
          description: 'Project name for tracking. If omitted, derived from repo_path.',
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
        project: {
          type: 'string',
          description: 'Project name for tracking. If omitted, derived from repo_path.',
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
        project: {
          type: 'string',
          description: 'Project name for tracking. If omitted, derived from repo_path.',
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
        project: {
          type: 'string',
          description: 'Project name for tracking. If omitted, derived from repo_path.',
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
        project: {
          type: 'string',
          description: 'Project name for tracking. If omitted, derived from repo_path.',
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
        project: {
          type: 'string',
          description: 'Project name for tracking. If omitted, derived from repo_path.',
        },
      },
      required: ['repo_path'],
      additionalProperties: false,
    },
  },
  {
    name: 'vc_prepare_pr',
    description: 'Generate a pull request title, body, and labels for the target repository branch.',
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: {
          type: 'string',
          description: 'Absolute path to the git repository root.',
        },
        project: {
          type: 'string',
          description: 'Project name for tracking. If omitted, derived from repo_path.',
        },
        source_branch: {
          type: 'string',
          description: 'Optional source branch to use when building the pull request summary.',
        },
        target_branch: {
          type: 'string',
          description: 'Optional target branch to diff against when building the pull request summary.',
        },
      },
      required: ['repo_path'],
      additionalProperties: false,
    },
  },
  {
    name: 'vc_create_pr',
    description: 'Create a GitHub pull request for the current repository branch using the GitHub CLI.',
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: {
          type: 'string',
          description: 'Absolute path to the git repository root.',
        },
        project: {
          type: 'string',
          description: 'Project name for tracking. If omitted, derived from repo_path.',
        },
        title: {
          type: 'string',
          description: 'Pull request title.',
        },
        body: {
          type: 'string',
          description: 'Pull request body markdown.',
        },
        labels: {
          type: 'array',
          description: 'Optional labels to apply to the pull request.',
          items: {
            type: 'string',
          },
        },
        target_branch: {
          type: 'string',
          description: 'Optional base branch to target when creating the pull request.',
        },
        draft: {
          type: 'boolean',
          description: 'When true, create the pull request as a draft.',
          default: false,
        },
      },
      required: ['repo_path', 'title', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'vc_generate_changelog',
    description: 'Generate changelog markdown for the target repository using commit history and release metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: {
          type: 'string',
          description: 'Absolute path to the git repository root.',
        },
        project: {
          type: 'string',
          description: 'Project name for tracking. If omitted, derived from repo_path.',
        },
        from_tag: {
          type: 'string',
          description: 'Optional starting git tag used to derive the changelog range.',
        },
        to_tag: {
          type: 'string',
          description: 'Optional ending git tag used to derive the changelog range.',
        },
        from_date: {
          type: 'string',
          description: 'Optional starting ISO-8601 timestamp used to filter changelog entries.',
        },
        to_date: {
          type: 'string',
          description: 'Optional ending ISO-8601 timestamp used to filter changelog entries.',
        },
        version: {
          type: 'string',
          description: 'Optional version label to use in the generated changelog heading.',
        },
      },
      required: ['repo_path'],
      additionalProperties: false,
    },
  },
  {
    name: 'vc_update_changelog_file',
    description: 'Update the repository changelog file with a generated or provided changelog entry.',
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: {
          type: 'string',
          description: 'Absolute path to the git repository root.',
        },
        project: {
          type: 'string',
          description: 'Project name for tracking. If omitted, derived from repo_path.',
        },
        version: {
          type: 'string',
          description: 'Version heading for the changelog entry.',
        },
        changelog_text: {
          type: 'string',
          description: 'Optional changelog markdown to prepend to the changelog file.',
        },
      },
      required: ['repo_path', 'version'],
      additionalProperties: false,
    },
  },
  {
    name: 'vc_create_release',
    description: 'Create a version tag and release record for the target repository.',
    inputSchema: {
      type: 'object',
      properties: {
        repo_path: {
          type: 'string',
          description: 'Absolute path to the git repository root.',
        },
        project: {
          type: 'string',
          description: 'Project name for tracking. If omitted, derived from repo_path.',
        },
        version: {
          type: 'string',
          description: 'Optional semantic version to release. When omitted, the next version is inferred.',
        },
        push: {
          type: 'boolean',
          description: 'When true, push the created release tag to origin.',
          default: false,
        },
      },
      required: ['repo_path'],
      additionalProperties: false,
    },
  },
];

module.exports = tools;
