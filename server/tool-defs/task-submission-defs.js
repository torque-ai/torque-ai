/**
 * Tool definitions for task submission and creation operations.
 */

module.exports = [
  {
    "name": "submit_task",
    "description": "Submit a task for execution (non-blocking). By default uses smart routing to select the optimal provider. Set auto_route=false and specify provider to bypass smart routing. For local LLMs: include specific file paths and concrete instructions.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "task": {
          "type": "string",
          "description": "The task description/instructions. Be specific: include exact file paths, concrete changes, and clear success criteria."
        },
        "working_directory": {
          "type": "string",
          "description": "Working directory for the task (defaults to current directory)"
        },
        "timeout_minutes": {
          "type": "number",
          "description": "Safety-ceiling timeout in minutes (default: 480). Stall detection and heartbeat-driven decisions are the primary timeout mechanisms — this is a last-resort kill timer.",
          "default": 480,
          "minimum": 1,
          "maximum": 480
        },
        "auto_approve": {
          "type": "boolean",
          "description": "Auto-approve actions (WARNING: bypasses sandbox)",
          "default": false
        },
        "priority": {
          "type": "number",
          "description": "Task priority (higher = processed first when queued)",
          "default": 0
        },
        "auto_route": {
          "type": "boolean",
          "description": "Enable smart provider routing based on task complexity (default: true). Set false to use explicit provider.",
          "default": true
        },
        "provider": {
          "type": "string",
          "description": "Execution provider. Only used when auto_route=false. (codex, claude-cli, ollama, ollama-cloud, anthropic, cerebras, deepinfra, google-ai, groq, hyperbolic, openrouter)",
          "enum": [
            "codex",
            "claude-cli",
            "ollama",
            "ollama-cloud",
            "anthropic",
            "cerebras",
            "deepinfra",
            "google-ai",
            "groq",
            "hyperbolic",
            "openrouter"
          ]
        },
        "model": {
          "type": "string",
          "description": "Model override. For ollama: e.g., my-model:14b. For codex: e.g., gpt-5.3-codex-spark."
        },
        "files": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Files involved in the task (helps smart routing detect language/complexity)"
        },
        "context_stuff": {
          "type": "boolean",
          "description": "Inject relevant project files into the prompt (default: false)"
        },
        "context_depth": {
          "type": "number",
          "description": "Import graph traversal depth for context stuffing (default: 1)",
          "enum": [1, 2]
        },
        "tuning": {
          "type": "object",
          "description": "Per-task tuning overrides (temperature, num_ctx, top_p, etc.)",
          "properties": {
            "preset": {
              "type": "string",
              "enum": ["code", "precise", "creative", "balanced", "fast"],
              "description": "Apply a tuned profile"
            },
            "temperature": { "type": "number" },
            "num_ctx": { "type": "number" },
            "top_p": { "type": "number" },
            "top_k": { "type": "number" },
            "repeat_penalty": { "type": "number" },
            "num_predict": { "type": "number" }
          }
        },
        "routing_template": {
          "type": "string",
          "description": "Name or ID of a routing template (e.g. 'Cost Saver', 'Quality First', 'Free Agentic'). Controls the provider+model fallback chain. Available: System Default, Quality First, Cost Saver, Cloud Sprint, Free Agentic, Free Speed, All Local."
        },
        "version_intent": {
          "type": "string",
          "enum": ["feature", "fix", "breaking", "internal"],
          "description": "Version intent for this task. Required for versioned projects. Determines semver bump: feature=minor, fix=patch, breaking=major, internal=no bump."
        }
      },
      "required": [
        "task"
      ]
    }
  }
];
