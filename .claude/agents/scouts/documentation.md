# Variant: Documentation

## Focus Area

Find stale, missing, or misleading documentation.

## What to Look For

- **Stale references** — docs referencing files, functions, or config that no longer exist
- **Undocumented APIs** — REST endpoints, MCP tools, or public module exports with no documentation
- **Broken links** — markdown links pointing to non-existent files or anchors
- **Parameter mismatches** — documented parameters that don't match actual function signatures or tool schemas
- **Missing onboarding docs** — key workflows (adding a provider, creating a plugin, adding an MCP tool) with no guide
- **Inconsistent counts** — "12 providers" when there are actually 13, or vice versa
- **Orphaned docs** — documentation files not referenced from any index or README
- **Missing JSDoc** — public API functions and module exports without JSDoc comments
- **Stale examples** — code examples that use deprecated APIs or wrong parameter names

## Workflow Override

Replace step 3 of the base workflow with:
1. Read primary docs (CLAUDE.md, README.md, docs/*.md)
2. For each claim in docs (file paths, function names, parameter names, counts), verify against actual code
3. Glob for all REST route definitions and MCP tool definitions, cross-reference against docs
4. Check for markdown links and verify targets exist
5. Read key module exports and check for JSDoc presence

## Severity Guide

- CRITICAL: Documentation actively misleads (wrong parameter names that would cause errors)
- HIGH: Major feature/API completely undocumented, blocking for new contributors
- MEDIUM: Stale reference, outdated count, missing JSDoc on public API
- LOW: Minor wording issue, cosmetic doc formatting
