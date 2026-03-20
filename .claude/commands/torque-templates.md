---
name: torque-templates
description: View, activate, and manage TORQUE routing templates — control which providers handle which task types
argument-hint: "[list | activate <name> | show <name> | create | categories]"
allowed-tools:
  - mcp__torque__list_routing_templates
  - mcp__torque__get_routing_template
  - mcp__torque__set_routing_template
  - mcp__torque__delete_routing_template
  - mcp__torque__activate_routing_template
  - mcp__torque__get_active_routing
  - mcp__torque__list_routing_categories
  - AskUserQuestion
---

# TORQUE Routing Templates

Manage routing templates that control which providers handle which task categories.

## Background

TORQUE auto-classifies every task into one of 9 categories (security, xaml_wpf, architectural, reasoning, large_code_gen, documentation, simple_generation, targeted_file_edit, default). A routing template maps each category to a provider fallback chain. When a template is active, it overrides smart routing defaults.

## Instructions

### If no argument or "list" — show all templates:

1. Call in parallel:
   - `list_routing_templates` — get all preset + custom templates
   - `get_active_routing` — get currently active template

2. Present as:

```
## Routing Templates

Active: [template name] — [description]
(or: No template active — using smart routing defaults)

### Available Templates
| Template | Description | Type |
|----------|-------------|------|
| System Default | Codex for hard problems, free cloud for rest | preset |
| Quality First | Codex primary for all code work | preset |
| Cost Saver | Free models first, Codex as last resort | preset |
| Cloud Sprint | Cerebras primary, maximum speed | preset |
| Free Agentic | Zero-cost providers only | preset |
| Free Speed | Cerebras for lowest latency | preset |
| All Local | Ollama for everything | preset |
| [custom...] | ... | custom |

To activate: /torque-templates activate <name>
To inspect: /torque-templates show <name>
```

### If argument starts with "activate":

1. Parse template name from argument (e.g., "activate Cost Saver")
2. Call `activate_routing_template({ name: "<template name>" })`
3. Confirm activation:
   ```
   Activated "Cost Saver" — free models first, Codex as last resort.
   All tasks will now route through this template.
   Per-task overrides still work: /torque-submit ... provider=codex
   ```

### If argument starts with "show" or is a template name:

1. Call `get_routing_template({ name: "<template name>" })`
2. Present the category → provider mappings:

```
## Cost Saver

Free models first, Codex as last resort.

| Category | Provider Chain |
|----------|---------------|
| security | cerebras → ollama-cloud → google-ai → codex |
| xaml_wpf | cerebras → google-ai → codex |
| architectural | ollama-cloud (kimi-k2) → ollama-cloud (mistral) → cerebras → codex |
| reasoning | ollama-cloud (mistral) → ollama-cloud (kimi-k2) → cerebras → codex |
| large_code_gen | ollama-cloud (kimi-k2) → ollama-cloud (qwen3-coder) → cerebras → codex |
| documentation | groq → cerebras → google-ai |
| simple_generation | cerebras → groq → openrouter |
| targeted_file_edit | hashline-ollama → cerebras → codex |
| default | cerebras → google-ai → ollama-cloud → openrouter → codex |

Complexity overrides: [if any]
```

### If argument is "categories":

1. Call `list_routing_categories`
2. Present the 9 categories with descriptions and detection keywords:

```
## Task Categories

| Category | Description | Detected By |
|----------|-------------|-------------|
| security | Auth, encryption, vulnerabilities | auth, encrypt, injection, xss, csrf |
| xaml_wpf | XAML, WPF, UWP, MAUI | .xaml files, wpf, maui keywords |
| architectural | System design, refactoring | architect, refactor, system design |
| reasoning | Complex analysis, debugging | analyze, debug, root cause |
| large_code_gen | Implementing systems, features | implement system, build feature |
| documentation | Docs, READMEs, JSDoc | document, explain, summarize |
| simple_generation | Commit messages, boilerplate | commit message, scaffold, template |
| targeted_file_edit | Fix/update specific files | fix/update + file path reference |
| default | Everything else | catch-all |

Categories are auto-detected from task descriptions — no manual tagging needed.
```

### If argument is "create":

1. Ask user for template details via AskUserQuestion:
   - Template name
   - Description
   - Which categories matter most (guide them through the 9 categories)
   - For each important category: which provider(s) to prefer

2. Build the template rules object and call `set_routing_template`

3. Ask if they want to activate it immediately

### If argument is "deactivate" or "none":

1. Call `activate_routing_template({ name: "" })` to clear the active template
2. Confirm: "Routing template deactivated. Tasks will use smart routing defaults."

### Template Selection Guide

If the user isn't sure which template to use, guide them:

- **"I want the best quality"** → Quality First
- **"I want to save money"** → Cost Saver or Free Agentic
- **"I need things done fast"** → Cloud Sprint or Free Speed
- **"I want everything local/private"** → All Local
- **"I want zero cost"** → Free Agentic
- **"Just the default"** → System Default
- **"I want to customize"** → offer to create a custom template
