# Project Template System with Agent Context Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Auto-detect project type using file markers and dependency analysis, then inject framework-specific instructions into task prompts to improve output quality -- especially for free/local providers.

**Architecture:** A template registry of JSON definitions with detection rules (file existence, dependency checks) and priority scoring. scan_project triggers detection and caches the result per project. Context enrichment reads the cached template and prepends its agent_context to task prompts.

**Tech Stack:** JSON template definitions, existing scan_project, existing context-enrichment.js, existing project config

**Inspired by:** Goblin Forge's template engine (40+ YAML templates, priority scoring, inheritance, agent_context injection)

---

### Task 1: Template definitions

**Files:**
- Create: `server/templates/registry.js`
- Create: `server/templates/definitions/` (directory of JSON template files)
- Test: `server/tests/project-templates.test.js`

Template structure:
```json
{
  "id": "nextjs",
  "name": "Next.js",
  "category": "framework",
  "priority": 110,
  "extends": "nodejs",
  "detection": {
    "files": ["package.json"],
    "dependencies": { "file": "package.json", "key": "next" }
  },
  "agent_context": "This is a Next.js project using the App Router...",
  "verify_command_suggestion": "npx next build",
  "critical_error_patterns": ["Module not found", "NEXT_NOT_FOUND"],
  "worktree_symlinks": ["node_modules", ".next"]
}
```

Initial templates: nodejs, typescript, nextjs, react, vue, svelte, python, django, fastapi, rust, go, csharp-dotnet, unity. Start with 10-15 covering common stacks.

- [ ] Step 1: Design template JSON schema
- [ ] Step 2: Write 10-15 template definitions
- [ ] Step 3: Implement registry.js with loadTemplates(), getTemplate(id)
- [ ] Step 4: Write tests for registry loading
- [ ] Step 5: Commit

---

### Task 2: Project type detector

**Files:**
- Create: `server/templates/detector.js`
- Test: `server/tests/project-templates.test.js` (append)

Functions:
- `detectProjectType(workingDir)` -- scans for marker files, checks dependencies, returns best-match template with score
- `detectDependency(filePath, key)` -- checks package.json/requirements.txt/Cargo.toml/go.mod for a dependency name
- Priority resolution: frameworks (110) override languages (50). When multiple match, highest priority wins. Ties broken by specificity (more detection rules matched = higher).

- [ ] Step 1: Write failing tests -- detect Next.js project, detect Python project, detect Go project
- [ ] Step 2: Implement detector with file-based and dependency-based rules
- [ ] Step 3: Write test for priority resolution (framework beats language)
- [ ] Step 4: Run tests
- [ ] Step 5: Commit

---

### Task 3: Cache detection result in project config

**Files:**
- Modify: `server/db/project-config-core.js` -- add detected_template field
- Modify: scan_project handler -- trigger detection and cache

- [ ] Step 1: Add detected_template and detected_template_at fields to project config
- [ ] Step 2: In scan_project, run detectProjectType and store result
- [ ] Step 3: Write test -- scan_project populates detected_template
- [ ] Step 4: Run tests
- [ ] Step 5: Commit

---

### Task 4: Inject agent_context into task prompts

**Files:**
- Modify: `server/utils/context-enrichment.js` -- prepend agent_context from cached template
- Test: `server/tests/project-templates.test.js` (integration)

- [ ] Step 1: In context enrichment, read detected_template from project config
- [ ] Step 2: If template has agent_context, prepend to the context block
- [ ] Step 3: Write test -- task for a Next.js project includes "App Router" in enriched context
- [ ] Step 4: Run tests
- [ ] Step 5: Commit

---

### Task 5: MCP tool for template management

**Files:**
- Modify: MCP tool definitions -- add get_project_template, list_templates tools
- Modify: `server/tool-annotations.js`

- [ ] Step 1: Add get_project_template(working_directory) tool
- [ ] Step 2: Add list_templates() tool
- [ ] Step 3: Suggest verify_command from template when not configured
- [ ] Step 4: Run tests
- [ ] Step 5: Commit
