---
name: torque-workflow
description: Create and manage TORQUE DAG workflows with dependent tasks
argument-hint: "[workflow-name | workflow-id | 'list']"
allowed-tools:
  - mcp__torque__create_workflow
  - mcp__torque__add_workflow_task
  - mcp__torque__run_workflow
  - mcp__torque__workflow_status
  - mcp__torque__list_workflows
  - mcp__torque__smart_submit_task
  - mcp__torque__capture_file_baselines
  - AskUserQuestion
  - Read
  - Glob
---

# TORQUE Workflow

Create, manage, and monitor DAG-based task workflows.

## Instructions

### If "list" or no argument:

1. Call `list_workflows` to show all workflows
2. For each active workflow, call `workflow_status` to show progress
3. Present as table: ID, name, status, tasks completed/total, current step

### If argument is a workflow ID (UUID-like):

1. Call `workflow_status` for that workflow
2. Show detailed view: name, description, each task with status, dependencies, provider, output summary

### If argument is a name (creating new workflow):

1. Call `capture_file_baselines` for the working directory
2. Call `create_workflow` with the provided name
3. Guide the user through adding tasks interactively:

   Ask via AskUserQuestion: "How do you want to define tasks?"
   - **Interactive** — add tasks one at a time with dependency selection
   - **Batch description** — describe the full pipeline and let TORQUE decompose it

4. For **Interactive** mode:
   - Ask for task description
   - Show existing tasks in the workflow, ask which ones this task depends on (if any)
   - Call `add_workflow_task` with the description and dependency list
   - Repeat until user says done

5. For **Batch** mode:
   - Ask user to describe the full pipeline
   - Decompose into individual tasks with inferred dependencies
   - Call `add_workflow_task` for each, wiring up dependencies
   - Show the DAG to user for confirmation before starting

6. Call `run_workflow` to begin execution
7. Show initial status and remind: use `/torque-status` to monitor

After writing, verify the file exists.
