---
name: torque-validate
description: Run code quality validation — syntax checks, build checks, quality scores, regression detection
argument-hint: "[task-id | 'project' | 'files <path>' | 'rules']"
allowed-tools:
  - mcp__torque__validate_task_output
  - mcp__torque__run_syntax_check
  - mcp__torque__run_build_check
  - mcp__torque__get_quality_score
  - mcp__torque__get_validation_results
  - mcp__torque__detect_regressions
  - mcp__torque__auto_verify_and_fix
  - mcp__torque__scan_project
  - Read
  - Glob
  - AskUserQuestion
---

# TORQUE Validate

Run standalone code quality validation without going through the full review workflow.

## Instructions

### If argument is a task ID:

1. Call in parallel:
   - `validate_task_output` with the task ID
   - `get_quality_score` with the task ID
   - `get_validation_results` with the task ID

2. Present findings:

```
## Validation: [Task ID]

**Quality Score:** [score]/100
**Status:** [pass/warn/fail]

### Checks
| Check | Result | Details |
|-------|--------|---------|
| Stub detection | pass | No stubs found |
| Truncation | pass | No truncated files |
| Empty methods | warn | 2 empty methods in FooSystem.ts |
| Build check | pass | Compiles cleanly |

### Issues (if any)
- [severity] [description] in [file]:[line]
```

### If argument is "project" or no argument:

1. Call `scan_project` with the current working directory
   - This reveals: missing tests, TODOs, coverage gaps, file sizes, dependencies
2. Call `run_build_check` with the working directory

3. Present as:

```
## Project Health: [project name]

### Build Status
[Pass/Fail with error details]

### Coverage Gaps
| File | Tests? | Size | TODOs |
|------|--------|------|-------|
| src/systems/FooSystem.ts | No | 450 lines | 3 |

### Recommendations
- [Actionable suggestions based on scan results]
```

### If argument starts with "files":

1. Parse file path(s) from argument
2. For each file, call `run_syntax_check` with `{ file_path, working_directory }`
3. Present syntax check results per file

### If argument is "rules":

1. Show available validation checks:
   - **Stub detection** — finds TODO/placeholder implementations
   - **Truncation** — detects files that shrunk >50%
   - **Empty methods** — finds method bodies with no logic
   - **Build check** — runs the project's verify command
   - **Syntax check** — validates individual file syntax
   - **Regression detection** — compares against baselines

### If argument is "auto-fix":

1. Call `auto_verify_and_fix` with the working directory
   - This runs the verify command, parses errors, and auto-submits fix tasks
2. Report: what was checked, what errors were found, what fix tasks were submitted

### If argument is "regressions":

1. Call `detect_regressions` with the working directory
2. Present any detected regressions with file paths and descriptions
