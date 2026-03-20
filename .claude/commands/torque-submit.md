---
name: torque-submit
description: Submit work to TORQUE with automatic provider routing, baselines, and retry
argument-hint: "[task description]"
allowed-tools:
  - mcp__torque__smart_submit_task
  - mcp__torque__capture_file_baselines
  - mcp__torque__check_ollama_health
  - mcp__torque__list_ollama_models
  - Read
  - Glob
  - AskUserQuestion
---

# TORQUE Submit

Submit a task to TORQUE. Fast by default — submit first, safeguards are applied by the server.

## Instructions

### If task description provided ($ARGUMENTS):

1. Analyze the description to determine:
   - **Files involved** — if file paths or component names are mentioned, resolve them. Don't scan the whole project.
   - **Complexity** — simple (docs, tests, boilerplate) → local LLM; complex (multi-file, architecture, security, XAML/WPF) → cloud
   - **Model hint** — `codellama` for code, `llama3` for general, `mistral` for writing

2. Call `smart_submit_task` with:
   - `task`: The full task description, formatted as a structured prompt:
     ```
     TASK: [Brief title]
     OBJECTIVE: [What to accomplish]
     FILES: [Resolved file paths, if known]
     REQUIREMENTS: [Extracted from description]
     SUCCESS CRITERIA: [How to verify the output]
     ```
   - `working_directory`: Current project directory
   - `files`: Resolved file paths array (if known)
   - `model`: Selected model (if local routing)
   - `timeout_minutes`: Estimate from complexity (5 for simple, 15 for medium, 30 for complex)
   - `priority`: 0 unless user specifies urgency

3. Report to user:
   - Task ID
   - Provider selected (local vs cloud)
   - Model selected
   - Estimated timeout
   - The session is **auto-subscribed** to this task's completion/failure notifications — no need to poll
   - To wait for results: use `await_workflow` (for workflows) or `check_notifications` (for single tasks)
   - For manual checks: `/torque-status` to monitor, `/torque-review` when complete

### If no argument provided:

1. Ask user what task to submit using AskUserQuestion
2. Follow the same flow above with their response

### Optional flags (parsed from $ARGUMENTS):

- `--baselines` — capture file baselines before submitting (use only for specific directories, not whole project)
- `model=X` — override model selection
- `priority=N` — set priority (0=normal, 1=high, 2=urgent)
- `provider=X` — force provider (ollama, claude-cli, codex)
- `template=X` — use a specific routing template for this task (e.g., `template=Quality First`)

Do NOT run health checks or baseline captures by default. The server handles routing and fallback automatically.

Tasks are auto-classified into categories (security, architectural, large_code_gen, etc.) and routed via the active routing template. Use `/torque-templates` to view or change the active template.
