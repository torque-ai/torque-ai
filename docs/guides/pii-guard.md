# PII Guard

Automatic personal data sanitization for TORQUE-managed projects.

## What It Does

PII Guard scans for personal data and auto-replaces it with safe placeholders:

| Category | Example Match | Replacement |
|----------|--------------|-------------|
| User paths | `C:\Users\<name>\Projects\...` | `C:\Users\<user>\Projects\...` |
| Private IPs | `192.168.1.100` | `192.0.2.100` |
| Emails | `someone@gmail.com` | `user@example.com` |
| Hostnames | Your machine name | `example-host` |
| Custom | Any string you define | Your replacement |

## Setup

### 1. Configure per-project

    set_project_defaults({
      working_directory: "/path/to/project",
      pii_guard: {
        enabled: true,
        custom_patterns: [
          { "pattern": "MyUsername", "replacement": "<user>" },
          { "pattern": "MyMachine", "replacement": "example-host" }
        ]
      }
    })

### 2. Install git pre-commit hook

    cp scripts/pii-pre-commit.sh /path/to/project/.git/hooks/pre-commit
    chmod +x /path/to/project/.git/hooks/pre-commit

### 3. Add Claude Code hook (optional)

Add to `~/.claude/settings.json` under the existing `hooks.PreToolUse` array:

    {
      "matcher": "Write|Edit",
      "hooks": [
        {
          "type": "command",
          "command": "/path/to/torque-public/scripts/pii-claude-hook.sh"
        }
      ]
    }

## Three Layers

1. **TORQUE Output Safeguards** — scans task output before files are written (automatic, no setup needed)
2. **Claude Code Hook** — scans Write/Edit tool calls before execution (requires settings.json entry)
3. **Git Pre-Commit Hook** — scans staged files before commit (requires hook install)

## Configuration

All config via `set_project_defaults`. Built-in categories are on by default.

Disable a category:

    set_project_defaults({
      working_directory: "...",
      pii_guard: {
        builtin_categories: { emails: false }
      }
    })

Add custom patterns:

    set_project_defaults({
      working_directory: "...",
      pii_guard: {
        custom_patterns: [
          { "pattern": "SecretProject", "replacement": "example-project" },
          { "pattern": "\\d{3}-\\d{2}-\\d{4}", "replacement": "XXX-XX-XXXX", "regex": true }
        ]
      }
    })

## Offline Behavior

| Layer | TORQUE Running | TORQUE Down |
|-------|---------------|-------------|
| Output Safeguards | Auto-fix | N/A (TORQUE is down) |
| Claude Code Hook | Auto-fix via API | Allows through (git hook is backstop) |
| Git Pre-Commit | Auto-fix via API | Blocks with fallback regex scan (no auto-fix) |
