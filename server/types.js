/**
 * TORQUE Core Type Definitions (JSDoc)
 *
 * Provides IDE autocomplete and documentation for core data structures.
 * Import with: const Types = require('./types');
 * Or reference inline: @type {import('./types').Task}
 */

/**
 * @typedef {Object} Task
 * @property {string} id - UUID task identifier
 * @property {string} task - Task description/prompt
 * @property {string} status - 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'paused'
 * @property {string} [provider] - Provider that executed the task (ollama, anthropic, groq, claude-cli, codex-cli)
 * @property {string} [model] - Model used for execution
 * @property {string} [output] - Task output/result
 * @property {number} [priority] - Task priority (higher = more urgent)
 * @property {string} [error] - Error message if failed
 * @property {number} [progress] - Progress percentage (0-100)
 * @property {string} [project_root] - Project directory path
 * @property {string} created_at - ISO timestamp
 * @property {string} [started_at] - ISO timestamp when execution began
 * @property {string} [completed_at] - ISO timestamp when execution finished
 * @property {number} [retry_count] - Number of retry attempts
 * @property {string} [tags] - Comma-separated tag list
 * @property {string} [group_id] - Task group UUID
 */

/**
 * @typedef {Object} Workflow
 * @property {string} id - UUID workflow identifier
 * @property {string} name - Workflow name
 * @property {string} [description] - Workflow description
 * @property {string} status - 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'paused'
 * @property {number} total_tasks - Total tasks in workflow
 * @property {number} completed_tasks - Completed task count
 * @property {number} failed_tasks - Failed task count
 * @property {string} created_at - ISO timestamp
 * @property {string} [completed_at] - ISO timestamp
 */

/**
 * @typedef {Object} Pipeline
 * @property {string} id - UUID pipeline identifier
 * @property {string} name - Pipeline name
 * @property {string} [description] - Pipeline description
 * @property {string} status - 'pending' | 'running' | 'completed' | 'failed'
 * @property {string} created_at - ISO timestamp
 */

/**
 * @typedef {Object} PipelineStep
 * @property {string} id - UUID step identifier
 * @property {string} pipeline_id - Parent pipeline UUID
 * @property {number} step_order - Execution order
 * @property {string} name - Step name
 * @property {string} task_template - Task prompt template
 * @property {string} [condition] - 'on_success' | 'on_failure' | 'always'
 * @property {string} status - 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
 * @property {string} [task_id] - Linked task UUID when running
 */

/**
 * @typedef {Object} Provider
 * @property {string} name - Provider identifier (ollama, anthropic, groq, claude-cli, codex-cli)
 * @property {boolean} enabled - Whether provider is active
 * @property {number} priority - Routing priority (lower = preferred)
 * @property {number} [max_concurrent] - Max concurrent tasks
 * @property {string} [endpoint] - API endpoint URL
 */

/**
 * @typedef {Object} OllamaHost
 * @property {string} id - UUID host identifier
 * @property {string} url - Host URL (e.g. http://localhost:11434)
 * @property {string} name - Display name
 * @property {boolean} enabled - Whether host is active
 * @property {string} status - 'healthy' | 'unhealthy' | 'unknown'
 * @property {string} [last_health_check] - ISO timestamp of last health check
 * @property {number} [memory_limit_gb] - Memory limit in GB
 * @property {number} [max_concurrent] - Max concurrent tasks on this host
 */

/**
 * @typedef {Object} ValidationRule
 * @property {string} id - UUID rule identifier
 * @property {string} name - Rule name
 * @property {string} description - Rule description
 * @property {string} rule_type - Rule type (output_contains, file_check, etc.)
 * @property {string} [pattern] - Match pattern
 * @property {string} severity - 'error' | 'warning' | 'info'
 * @property {boolean} enabled - Whether rule is active
 */

/**
 * @typedef {Object} ToolResult
 * @property {Array<{type: string, text: string}>} content - Response content
 * @property {boolean} [isError] - Whether the result is an error
 */

/**
 * @typedef {Object} ToolDefinition
 * @property {string} name - Tool name
 * @property {string} description - Tool description
 * @property {Object} inputSchema - JSON Schema for tool inputs
 */

/**
 * @typedef {Object} BudgetAlert
 * @property {string} id - UUID alert identifier
 * @property {string} name - Alert name
 * @property {number} threshold - Cost threshold
 * @property {string} period - 'daily' | 'weekly' | 'monthly'
 * @property {boolean} enabled - Whether alert is active
 */

/**
 * @typedef {Object} ScheduledTask
 * @property {string} id - UUID identifier
 * @property {string} name - Schedule name
 * @property {string} task_template - Task prompt
 * @property {string} [cron_expression] - Cron schedule
 * @property {string} [interval] - Interval string
 * @property {boolean} enabled - Whether schedule is active
 * @property {string} [last_run] - ISO timestamp of last execution
 * @property {string} [next_run] - ISO timestamp of next execution
 */

module.exports = {};
