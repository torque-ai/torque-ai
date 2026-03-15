# Safeguards

TORQUE includes a layered quality assurance system that validates task output, detects common LLM mistakes, and automatically rolls back problematic changes.

## Overview

| Layer | Purpose | When It Runs |
|-------|---------|-------------|
| **File Baselines** | Snapshot files before changes | Before task execution |
| **Validation Rules** | Pattern matching for stubs, empty bodies | After task completion |
| **Syntax Checks** | Language-specific syntax validation | On demand or post-task |
| **Build Checks** | Compile/build verification | After code tasks |
| **Quality Scoring** | Composite quality metric (0-100) | After validation |
| **Approval Gates** | Human review for risky changes | When thresholds are breached |
| **Auto-Rollback** | Revert changes on failure | On validation/build failure |

## File Baselines

Baselines capture file snapshots before a task runs, enabling change detection and rollback.

### How It Works

1. `/torque-submit` automatically calls `capture_file_baselines` before execution
2. File path, content hash, size, and line count are stored in SQLite
3. After completion, `compare_file_baseline` detects changes

### What Gets Captured

Default file extensions: `.cs`, `.xaml`, `.ts`, `.js`, `.py`

For each file:
- Full content (stored as blob)
- SHA-256 content hash
- File size in bytes
- Line count
- Capture timestamp

### Change Detection

After task completion, the comparison calculates:

| Metric | Description | Alert Threshold |
|--------|-------------|----------------|
| `sizeDelta` | Bytes added or removed | Informational |
| `sizeChangePercent` | Percentage change | >50% decrease triggers approval |
| `lineDelta` | Lines added or removed | Informational |
| `isTruncated` | File appears incomplete | Warning |
| `isSignificantlyShrunk` | >50% size decrease | Triggers approval gate |

### Tools

| Tool | Description |
|------|-------------|
| `capture_file_baselines` | Snapshot files in a directory |
| `compare_file_baseline` | Compare current file against stored baseline |

## Validation Rules

Pattern-based rules that check task output for common LLM mistakes.

### Rule Types

| Type | Description | Example |
|------|-------------|---------|
| `pattern` | Regex match against file content | Detect `// TODO` stubs |
| `size` | File size threshold check | Reject files < 100 bytes |
| `delta` | Compare baseline vs current state | Detect >50% shrinkage |

### Severity Levels

| Severity | Effect |
|----------|--------|
| `info` | Logged, no action |
| `warning` | Logged, shown in review |
| `error` | Blocks approval |
| `critical` | Auto-fails the task |

### Built-in Rules

TORQUE ships with these default validation rules:

**Stub Detection** (`val-stub-impl`):
```
Pattern: // implementation|// TODO|// FIXME|# TODO|# implementation|
         implementation goes here|throw new NotImplementedException|
         raise NotImplementedError|...\s*(rest of|remaining|same as|unchanged|code remains)
```

**Empty Method Bodies** (`val-empty-body`):
```
Pattern: (?<![:=,])\s*\{\s*\}
```
Matches empty `{}` bodies while excluding dictionary initializers like `= {}`.

### Auto-Fail

Rules with `auto_fail: true` automatically reject the task and trigger approval gates when matched.

### Tools

| Tool | Description |
|------|-------------|
| `list_validation_rules` | List all rules with optional severity filter |
| `add_validation_rule` | Create a new rule (pattern, size, or delta) |
| `update_validation_rule` | Modify enabled/severity/auto_fail |
| `validate_task_output` | Run all rules against a completed task |
| `get_validation_results` | Retrieve validation results for a task |

## Build Checks

Compile verification after code-modifying tasks.

### How It Works

1. After a task completes, TORQUE runs the project's build command
2. Build output is captured and analyzed for errors
3. Results are stored with pass/fail status, duration, and error details

### Configuration

```
configure_build_check { enabled: true }
```

When enabled, build checks run automatically after code tasks complete.

### Build Error Analysis

The `analyze_build_output` tool parses build output to categorize errors:

| Error Category | Description |
|----------------|-------------|
| `namespace_conflict` | Conflicting namespace declarations |
| `missing_type` | Referenced type not found |
| `compilation_error` | General compilation failure |

### Tools

| Tool | Description |
|------|-------------|
| `run_build_check` | Execute build check for a directory |
| `get_build_result` | Retrieve stored build results |
| `configure_build_check` | Enable/disable automatic builds |
| `analyze_build_output` | Parse and categorize build errors |
| `get_build_error_analysis` | Retrieve error analysis results |

## Quality Scoring

Composite quality metric combining multiple validation signals.

### Score Components

| Component | Weight | Source |
|-----------|--------|--------|
| `validation_score` | Variable | Validation rule results |
| `syntax_score` | Variable | Syntax check pass rate |
| `completeness_score` | Variable | Stub detection, file coverage |

### Overall Score

Range: 0-100, where 100 is perfect quality.

### Provider Quality Tracking

TORQUE tracks quality per provider to inform routing decisions:

| Metric | Description |
|--------|-------------|
| `total_tasks` | Tasks completed by provider |
| `avg_score` | Average quality score |
| `min_score` / `max_score` | Quality range |
| `success_rate` | Percentage of successful tasks |

### Best Provider Selection

`get_best_provider` recommends the optimal provider for a task type based on:
- Historical success rate
- Average quality score
- Minimum 3 completed tasks required for recommendation

### Tools

| Tool | Description |
|------|-------------|
| `get_quality_score` | Get quality score for a task |
| `get_provider_quality` | Quality statistics per provider |
| `get_provider_stats` | Success/failure rates per provider |
| `get_best_provider` | Recommended provider for task type |

## Approval Gates

Human review checkpoints triggered when quality thresholds are breached.

### Triggers

| Condition | Action |
|-----------|--------|
| File shrunk >50% | Requires approval before committing |
| Validation rule with `auto_fail: true` matched | Task blocked |
| Validation severity exceeds threshold | Task blocked |
| Diff preview required but not reviewed | Commit blocked |

### Diff Preview

When enabled, tasks must have their diff reviewed before changes can be committed:

```
configure_diff_preview { required: true }
```

### Approval Flow

1. Task completes with a triggered condition
2. Task moves to `pending_approval` state
3. User reviews via `preview_task_diff` or `/torque-review`
4. User calls `approve_diff` or `reject_task`

### Tools

| Tool | Description |
|------|-------------|
| `preview_task_diff` | View file changes before committing |
| `approve_diff` | Approve changes for commit |
| `reject_task` | Reject task output |
| `configure_diff_preview` | Enable/disable diff preview requirement |

## Rollback

Revert task changes when quality checks fail.

### Manual Rollback

```
rollback_task { task_id: "abc123" }
```

Uses git to revert the commit made by the task.

### Auto-Rollback

Triggered automatically when:
- Validation fails with critical severity
- Build check fails
- Test regression detected
- Syntax errors found

```
perform_auto_rollback {
  task_id: "abc123",
  working_directory: "/path/to/project",
  trigger_reason: "build_failure"
}
```

### Trigger Reasons

| Reason | Description |
|--------|-------------|
| `validation_failure` | Validation rules failed |
| `build_failure` | Build/compile check failed |
| `test_regression` | Tests that previously passed now fail |
| `file_location_anomaly` | Files created in wrong directory |
| `syntax_error` | Syntax validation failed |

### Rollback History

All rollbacks are logged with:
- Task ID
- Rollback type (`auto`, `manual`, `approval_gate`)
- Status (`pending`, `completed`, `failed`)
- Timestamp and reason

### Tools

| Tool | Description |
|------|-------------|
| `rollback_task` | Manually rollback task changes |
| `list_rollbacks` | View rollback history |
| `perform_auto_rollback` | Trigger automatic rollback |
| `get_auto_rollback_history` | View auto-rollback history |
| `list_backups` | List file backups for a task |
| `restore_backup` | Restore a specific file from backup |

## Adaptive Retry

Automatic retry with strategy adjustments when tasks fail.

### How It Works

1. Task fails (timeout, error, validation failure)
2. TORQUE analyzes the failure pattern
3. Retry strategy is selected based on learned patterns
4. Task is retried with adjusted parameters (different model, provider, or settings)

### Retry Strategies

| Strategy | Description |
|----------|-------------|
| Edit format switch | `diff` to `whole` (or vice versa) |
| Model escalation | Smaller model to larger model |
| Provider fallback | Local LLM to cloud provider |
| Parameter adjustment | Temperature, context window changes |

### Failure Patterns

Register known failure signatures to enable pattern-based retry:

```
add_failure_pattern {
  name: "model_refuses_code",
  description: "Model refuses to generate code in diff format",
  signature: "I cannot generate|I'm unable to",
  provider: "ollama",
  severity: "medium"
}
```

### Retry Rules

```
add_retry_rule {
  name: "diff_to_whole",
  description: "Switch to whole format on diff failure",
  rule_type: "edit_format",
  trigger: "diff_parse_error",
  fallback_provider: "claude-cli",
  max_retries: 1
}
```

### Tools

| Tool | Description |
|------|-------------|
| `add_failure_pattern` | Register a known failure signature |
| `get_failure_matches` | View matched patterns for a task |
| `list_retry_rules` | View retry rule configuration |
| `add_retry_rule` | Create an adaptive retry rule |
| `configure_adaptive_retry` | Configure retry behavior |
| `get_retry_recommendation` | Get optimal retry strategy |
| `retry_with_adaptation` | Retry with auto-adjusted parameters |
| `analyze_retry_patterns` | Identify which strategies work |

## Additional Safeguards

### Security Scanning

Scan files for security issues:

| Tool | Description |
|------|-------------|
| `run_security_scan` | Run security scan on task output |
| `scan_vulnerabilities` | Scan dependencies for CVEs |
| `get_security_results` | Retrieve scan results |

### Code Quality

| Tool | Description |
|------|-------------|
| `run_syntax_check` | Language-specific syntax validation |
| `run_style_check` | Linting and formatting (supports auto-fix) |
| `check_test_coverage` | Verify test files exist for changed files |
| `analyze_change_impact` | Show downstream impact of changes |
| `analyze_complexity` | Cyclomatic and cognitive complexity |
| `detect_dead_code` | Find unused functions and variables |

### XAML/WPF Validation

Specialized checks for WPF applications:

| Tool | Description |
|------|-------------|
| `validate_xaml_semantics` | Check XML structure, namespaces, types |
| `check_xaml_consistency` | Verify XAML/code-behind alignment |
| `run_app_smoke_test` | Launch app and check for startup errors |

### File Location Checks

Detect files created in unexpected locations:

| Tool | Description |
|------|-------------|
| `set_expected_output_path` | Define expected output directory |
| `check_file_locations` | Find files outside expected paths |
| `check_duplicate_files` | Detect duplicate file creation |

### LLM Safeguards

Project-level safeguard configuration:

```
configure_llm_safeguards {
  project: "my-app",
  enabled: true,
  file_quality_enabled: true,
  duplicate_detection_enabled: true,
  syntax_validation_enabled: true,
  min_code_lines: 5,
  max_comment_ratio: 0.5
}
```

### Pre-Commit Hooks

Install git hooks that run safeguards before commits:

```
setup_precommit_hook { working_directory: "/path/to/project" }
```

Creates platform-specific hooks (PowerShell on Windows, Bash on Unix) that warn about stubs and TODOs.

### Audit Trail

All safeguard actions are logged:

| Tool | Description |
|------|-------------|
| `get_audit_trail` | Complete event log with pagination |
| `get_audit_summary` | Statistics by period (daily/weekly/monthly) |
| `export_audit_report` | Generate audit report (JSON or CSV) |

## Configuration Summary

| Setting | Tool | Default |
|---------|------|---------|
| Build checks | `configure_build_check` | Disabled |
| Diff preview required | `configure_diff_preview` | Disabled |
| LLM safeguards | `configure_llm_safeguards` | Per-project |
| Output size limits | `configure_output_limits` | 1MB output, 512KB per file, 20 files |
| Stall recovery | Config: `stall_recovery_enabled` | Enabled |
| Stall recovery attempts | Config: `stall_recovery_max_attempts` | 3 |
