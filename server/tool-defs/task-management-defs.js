/**
 * Tool definitions for task lifecycle management operations.
 */

module.exports = [
  {
    "name": "queue_task",
    "description": "Add a task to the queue. It will start automatically when a slot becomes available. For local LLM tasks: Include specific file paths and concrete, actionable instructions for best results.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "task": {
          "type": "string",
          "description": "The task description/instructions. For local LLMs: Include exact file paths, specific changes needed, and clear success criteria. Avoid vague tasks like \"review X\" - prefer \"implement Y in file Z\""
        },
        "working_directory": {
          "type": "string",
          "description": "Working directory for the task"
        },
        "timeout_minutes": {
          "type": "number",
          "description": "Safety-ceiling timeout in minutes (default: 480)",
          "default": 480,
          "minimum": 1,
          "maximum": 480
        },
        "auto_approve": {
          "type": "boolean",
          "description": "Auto-approve provider actions",
          "default": false
        },
        "priority": {
          "type": "number",
          "description": "Task priority (higher = processed first)",
          "default": 0
        }
      },
      "required": [
        "task"
      ]
    }
  },
  {
    "name": "check_status",
    "description": "Check the status of a specific task or all tasks",
    "inputSchema": {
      "type": "object",
      "properties": {
        "task_id": {
          "type": "string",
          "description": "Task ID to check (omit for all tasks summary)"
        }
      },
      "required": []
    }
  },
  {
    "name": "get_result",
    "description": "Get the full output and result of a completed task",
    "inputSchema": {
      "type": "object",
      "properties": {
        "task_id": {
          "type": "string",
          "description": "Task ID to get results for"
        }
      },
      "required": [
        "task_id"
      ]
    }
  },
  {
    "name": "wait_for_task",
    "description": "Wait for a task to complete (blocks until done or timeout). Use this instead of polling check_status + ping in a loop. Returns the full task result when complete.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "task_id": {
          "type": "string",
          "description": "Task ID to wait for"
        },
        "timeout_seconds": {
          "type": "number",
          "description": "Maximum time to wait in seconds (default: 300, max: 600)",
          "default": 300
        }
      },
      "required": [
        "task_id"
      ]
    }
  },
  {
    "name": "list_tasks",
    "description": "List tasks with optional status, tag, and project filtering. By default shows only tasks from the current project.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "status": {
          "type": "string",
          "enum": [
            "pending",
            "queued",
            "running",
            "completed",
            "failed",
            "cancelled"
          ],
          "description": "Filter by status"
        },
        "tags": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Filter by tags (returns tasks matching ANY of the specified tags)"
        },
        "project": {
          "type": "string",
          "description": "Filter by project name (defaults to current project based on working directory)"
        },
        "all_projects": {
          "type": "boolean",
          "description": "Show tasks from all projects instead of just the current one",
          "default": false
        },
        "project_id": {
          "type": "string",
          "description": "Filter tasks by plan project ID"
        },
        "limit": {
          "type": "number",
          "description": "Maximum number of tasks to return",
          "default": 20
        }
      },
      "required": []
    }
  },
  {
    "name": "cancel_task",
    "description": "Cancel a running or queued task. SAFETY: For running/queued tasks, first call returns task details for review. Call again with confirm=true to actually cancel. Cancellation is irreversible.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "task_id": {
          "type": "string",
          "description": "Task ID to cancel"
        },
        "reason": {
          "type": "string",
          "description": "Reason for cancellation"
        },
        "confirm": {
          "type": "boolean",
          "default": false,
          "description": "Set to true to confirm cancellation after reviewing task details. First call without confirm returns task info for review."
        }
      },
      "required": [
        "task_id"
      ]
    }
  },
  {
    "name": "delete_task",
    "description": "Delete a task from the database. Only tasks in terminal states (failed, completed, cancelled) can be deleted. Use status filter to bulk-delete.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "task_id": {
          "type": "string",
          "description": "Task ID to delete (for single task deletion)"
        },
        "status": {
          "type": "string",
          "enum": [
            "failed",
            "completed",
            "cancelled"
          ],
          "description": "Delete ALL tasks with this status (bulk delete). Use with caution."
        }
      },
      "required": []
    }
  },
  {
    "name": "get_progress",
    "description": "Get real-time progress and latest output from a running task",
    "inputSchema": {
      "type": "object",
      "properties": {
        "task_id": {
          "type": "string",
          "description": "Task ID to get progress for"
        },
        "tail_lines": {
          "type": "number",
          "description": "Number of output lines to return (default: 50)",
          "default": 50
        }
      },
      "required": [
        "task_id"
      ]
    }
  },
  {
    "name": "retry_task",
    "description": "Retry a failed task",
    "inputSchema": {
      "type": "object",
      "properties": {
        "task_id": {
          "type": "string",
          "description": "ID of the failed task to retry"
        },
        "modified_task": {
          "type": "string",
          "description": "Optional: modified task description for the retry"
        }
      },
      "required": [
        "task_id"
      ]
    }
  },
  {
    "name": "commit_task",
    "description": "Commit the changes made by a completed task to git",
    "inputSchema": {
      "type": "object",
      "properties": {
        "task_id": {
          "type": "string",
          "description": "Task ID whose changes to commit"
        },
        "message": {
          "type": "string",
          "description": "Commit message (defaults to task description)"
        },
        "working_directory": {
          "type": "string",
          "description": "Working directory (defaults to task working directory)"
        }
      },
      "required": [
        "task_id"
      ]
    }
  },
  {
    "name": "analyze_task",
    "description": "Analyze a task to determine if it should be delegated to a provider or kept for Claude",
    "inputSchema": {
      "type": "object",
      "properties": {
        "task_description": {
          "type": "string",
          "description": "The task to analyze"
        },
        "context": {
          "type": "string",
          "description": "Additional context about the codebase or requirements"
        }
      },
      "required": [
        "task_description"
      ]
    }
  },
  {
    "name": "tag_task",
    "description": "Add tags to a task for organization and filtering",
    "inputSchema": {
      "type": "object",
      "properties": {
        "task_id": {
          "type": "string",
          "description": "Task ID to tag"
        },
        "tags": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Tags to add (e.g., [\"frontend\", \"urgent\", \"auth\"])"
        }
      },
      "required": [
        "task_id",
        "tags"
      ]
    }
  },
  {
    "name": "untag_task",
    "description": "Remove tags from a task",
    "inputSchema": {
      "type": "object",
      "properties": {
        "task_id": {
          "type": "string",
          "description": "Task ID to remove tags from"
        },
        "tags": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Tags to remove"
        }
      },
      "required": [
        "task_id",
        "tags"
      ]
    }
  },
  {
    "name": "check_task_progress",
    "description": "Check if running tasks are actively producing output (detects stalled tasks)",
    "inputSchema": {
      "type": "object",
      "properties": {
        "wait_seconds": {
          "type": "number",
          "description": "Seconds to wait between output checks (default: 5)",
          "default": 5
        }
      },
      "required": []
    }
  },
  {
    "name": "check_stalled_tasks",
    "description": "Check for stalled tasks (no output activity). Returns tasks that have not produced output for longer than the stall threshold (default 2 minutes).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "auto_cancel": {
          "type": "boolean",
          "description": "Automatically cancel stalled tasks",
          "default": false
        }
      },
      "required": []
    }
  },
  {
    "name": "schedule_task",
    "description": "Schedule a task to run at a specific time or on a recurring interval",
    "inputSchema": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "description": "Name for this scheduled task"
        },
        "task": {
          "type": "string",
          "description": "The task description to run"
        },
        "schedule_type": {
          "type": "string",
          "enum": [
            "once",
            "interval"
          ],
          "description": "Type of schedule: \"once\" for one-time, \"interval\" for recurring"
        },
        "run_at": {
          "type": "string",
          "description": "ISO timestamp for when to run (for \"once\" type)"
        },
        "interval_minutes": {
          "type": "number",
          "description": "Interval in minutes between runs (for \"interval\" type)"
        },
        "max_runs": {
          "type": "number",
          "description": "Maximum number of times to run (for interval type)"
        },
        "working_directory": {
          "type": "string",
          "description": "Working directory for the task"
        },
        "timeout_minutes": {
          "type": "number",
          "description": "Safety-ceiling timeout for each run in minutes (default: 480)",
          "default": 480,
          "minimum": 1,
          "maximum": 480
        },
        "priority": {
          "type": "number",
          "description": "Task priority",
          "default": 0
        },
        "tags": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Tags for the scheduled task"
        }
      },
      "required": [
        "name",
        "task",
        "schedule_type"
      ]
    }
  },
  {
    "name": "batch_cancel",
    "description": "Cancel multiple tasks at once based on filters",
    "inputSchema": {
      "type": "object",
      "properties": {
        "status": {
          "type": "string",
          "enum": [
            "pending",
            "queued",
            "running"
          ],
          "description": "Cancel tasks with this status (default: all cancellable)"
        },
        "tags": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Cancel tasks with any of these tags"
        },
        "older_than_hours": {
          "type": "number",
          "description": "Cancel tasks created more than N hours ago"
        },
        "provider": {
          "type": "string",
          "description": "Cancel tasks using this provider (e.g., \"codex\", \"ollama\", \"claude-cli\")"
        }
      },
      "required": []
    }
  },
  {
    "name": "archive_task",
    "description": "Archive a completed task to reduce database size while preserving history",
    "inputSchema": {
      "type": "object",
      "properties": {
        "task_id": {
          "type": "string",
          "description": "Task ID to archive"
        },
        "reason": {
          "type": "string",
          "description": "Optional reason for archiving"
        }
      },
      "required": [
        "task_id"
      ]
    }
  },
  {
    "name": "archive_tasks",
    "description": "Bulk archive tasks matching filters",
    "inputSchema": {
      "type": "object",
      "properties": {
        "status": {
          "type": "string",
          "enum": [
            "completed",
            "failed",
            "cancelled"
          ],
          "description": "Archive tasks with this status (default: completed)"
        },
        "older_than_days": {
          "type": "number",
          "description": "Archive tasks older than N days"
        },
        "tags": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Archive tasks with any of these tags"
        },
        "limit": {
          "type": "number",
          "description": "Maximum number of tasks to archive",
          "default": 50
        },
        "reason": {
          "type": "string",
          "description": "Reason for archiving"
        }
      },
      "required": []
    }
  },
  {
    "name": "restore_task",
    "description": "Restore an archived task back to the main task list",
    "inputSchema": {
      "type": "object",
      "properties": {
        "task_id": {
          "type": "string",
          "description": "Archived task ID to restore"
        }
      },
      "required": [
        "task_id"
      ]
    }
  },
  {
    "name": "get_task_usage",
    "description": "Get token usage history for a specific task",
    "inputSchema": {
      "type": "object",
      "properties": {
        "task_id": {
          "type": "string",
          "description": "Task ID to get usage for"
        }
      },
      "required": [
        "task_id"
      ]
    }
  },
  {
    "name": "clone_task",
    "description": "Clone an existing task with optional modifications",
    "inputSchema": {
      "type": "object",
      "properties": {
        "task_id": {
          "type": "string",
          "description": "Task ID to clone"
        },
        "task": {
          "type": "string",
          "description": "New task description (defaults to original)"
        },
        "working_directory": {
          "type": "string",
          "description": "New working directory (defaults to original)"
        },
        "priority": {
          "type": "number",
          "description": "New priority (defaults to original)"
        },
        "tags": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "New tags (defaults to original)"
        },
        "start_immediately": {
          "type": "boolean",
          "description": "Start the cloned task immediately",
          "default": false
        }
      },
      "required": [
        "task_id"
      ]
    }
  },
  {
    "name": "bulk_import_tasks",
    "description": "Import multiple tasks from a JSON or YAML file",
    "inputSchema": {
      "type": "object",
      "properties": {
        "file_path": {
          "type": "string",
          "description": "Path to the import file (JSON or YAML)"
        },
        "content": {
          "type": "string",
          "description": "Inline JSON/YAML content (alternative to file_path)"
        },
        "start_immediately": {
          "type": "boolean",
          "description": "Start tasks after import",
          "default": false
        },
        "working_directory": {
          "type": "string",
          "description": "Default working directory for imported tasks"
        }
      },
      "required": []
    }
  },
  {
    "name": "stream_task_output",
    "description": "Get live output chunks from a running or completed task. Supports streaming by returning chunks since a given sequence number.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "task_id": {
          "type": "string",
          "description": "Task ID to stream output from"
        },
        "since_sequence": {
          "type": "number",
          "description": "Return chunks after this sequence number (for polling). Omit for all chunks.",
          "default": 0
        },
        "limit": {
          "type": "number",
          "description": "Maximum number of chunks to return",
          "default": 50
        }
      },
      "required": [
        "task_id"
      ]
    }
  },
  {
    "name": "get_task_logs",
    "description": "Get complete stdout/stderr logs from a task with filtering options",
    "inputSchema": {
      "type": "object",
      "properties": {
        "task_id": {
          "type": "string",
          "description": "Task ID to get logs from"
        },
        "level": {
          "type": "string",
          "enum": [
            "info",
            "warn",
            "error"
          ],
          "description": "Filter by log level (error = stderr + error lines, warn = stderr + warn lines, info = all)"
        },
        "search": {
          "type": "string",
          "description": "Search pattern (regex) to filter logs"
        },
        "limit": {
          "type": "number",
          "description": "Maximum number of log entries to return",
          "default": 500
        }
      },
      "required": [
        "task_id"
      ]
    }
  },
  {
    "name": "poll_task_events",
    "description": "Poll for events using a subscription ID. Returns events since last poll.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "subscription_id": {
          "type": "string",
          "description": "Subscription ID from subscribe_task_events"
        }
      },
      "required": [
        "subscription_id"
      ]
    }
  },
  {
    "name": "pause_task",
    "description": "Pause a running task. Saves checkpoint state for later resumption.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "task_id": {
          "type": "string",
          "description": "Task ID to pause"
        },
        "reason": {
          "type": "string",
          "description": "Reason for pausing"
        }
      },
      "required": [
        "task_id"
      ]
    }
  },
  {
    "name": "resume_task",
    "description": "Resume a paused task from its last checkpoint.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "task_id": {
          "type": "string",
          "description": "Task ID to resume"
        }
      },
      "required": [
        "task_id"
      ]
    }
  },
  {
    "name": "list_paused_tasks",
    "description": "List all currently paused tasks with their pause duration.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "project": {
          "type": "string",
          "description": "Filter by project"
        },
        "limit": {
          "type": "number",
          "description": "Maximum number of tasks to return",
          "default": 50
        }
      },
      "required": []
    }
  },
  {
    "name": "find_similar_tasks",
    "description": "Find tasks with similar descriptions to a given task. Useful for finding patterns or successful approaches.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "task_id": {
          "type": "string",
          "description": "Task ID to find similar tasks for"
        },
        "limit": {
          "type": "number",
          "description": "Maximum number of similar tasks to return",
          "default": 10
        },
        "min_similarity": {
          "type": "number",
          "description": "Minimum similarity score (0-1)",
          "default": 0.3
        },
        "status_filter": {
          "type": "string",
          "enum": [
            "completed",
            "failed",
            "cancelled"
          ],
          "description": "Only return tasks with this status"
        }
      },
      "required": [
        "task_id"
      ]
    }
  },
  {
    "name": "task_timeline",
    "description": "Get full chronological history of a task including status changes, comments, retries, and approvals.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "task_id": {
          "type": "string",
          "description": "Task ID"
        }
      },
      "required": [
        "task_id"
      ]
    }
  },
  {
    "name": "start_pending_task",
    "description": "Start a pending task by changing its status to queued. Used for aggregation tasks that wait for chunks to complete.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "task_id": {
          "type": "string",
          "description": "Task ID to start"
        }
      },
      "required": [
        "task_id"
      ]
    }
  },
  {
    "name": "set_task_complexity",
    "description": "Set the complexity level of a task. This determines routing: simple→Laptop, normal→Desktop, complex→Codex.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "task_id": {
          "type": "string",
          "description": "Task ID"
        },
        "complexity": {
          "type": "string",
          "enum": [
            "simple",
            "normal",
            "complex"
          ],
          "description": "Complexity level"
        }
      },
      "required": [
        "task_id",
        "complexity"
      ]
    }
  },
  // ── Unified task info tool (Phase 3.2 consolidation) ──
  {
    "name": "task_info",
    "description": "Unified task information tool. Replaces check_status + get_result + get_progress. Use mode to select detail level: 'status' (quick poll), 'result' (full output), 'progress' (real-time stream). Without task_id, returns queue summary.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "task_id": {
          "type": "string",
          "description": "Task ID to query (omit for queue summary)"
        },
        "mode": {
          "type": "string",
          "enum": ["status", "result", "progress"],
          "description": "Detail level: status=quick poll (default), result=full output, progress=real-time stream with tail"
        },
        "tail_lines": {
          "type": "number",
          "description": "Number of output lines for progress mode (default: 50)",
          "default": 50
        }
      }
    }
  }
];
