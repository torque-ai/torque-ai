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
          "description": "Timeout in minutes before auto-cancellation (default: 30)",
          "default": 30
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
          "description": "Execution provider. Only used when auto_route=false. (codex, claude-cli, ollama, ollama-cloud, aider-ollama, hashline-ollama, anthropic, cerebras, deepinfra, google-ai, groq, hyperbolic, openrouter)",
          "enum": [
            "codex",
            "claude-cli",
            "ollama",
            "ollama-cloud",
            "aider-ollama",
            "hashline-ollama",
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
          "description": "Model override. For ollama: e.g., qwen2.5-coder:32b. For codex: e.g., gpt-5.3-codex-spark."
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
          "description": "Import graph traversal depth for context stuffing (default: 1)"
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
        }
      },
      "required": [
        "task"
      ]
    }
  }
];
