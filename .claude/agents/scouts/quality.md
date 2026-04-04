# Variant: Quality

## Focus Area

Find code quality and maintainability issues.

## What to Look For

- **DI container inconsistencies** — modules using direct `require('./database')` or `require('./task-manager')` instead of the DI container
- **Dead code** — exported functions never imported elsewhere, unused variables, unreachable branches
- **Complexity hotspots** — functions over 80 lines, nesting deeper than 3 levels, files over 1000 lines
- **Missing validation** — public API endpoints that don't validate input, MCP handlers that don't check required args
- **Inconsistent patterns** — modules mixing init(deps), createXxx factory, and direct require patterns
- **Error handling gaps** — empty catch blocks, swallowed errors logged at wrong level, missing try/catch in async handlers
- **Code duplication** — identical or near-identical logic repeated across modules
- **Stale code** — deprecated patterns still in use, TODO/FIXME comments older than 3 months

## Search Patterns

Look for: `require('./database')`, `require('./task-manager')` outside container.js, empty catch blocks `catch (_) {}`, `// TODO`, `// FIXME`, functions with 80+ lines, files with 1000+ lines.

## Severity Guide

- CRITICAL: Bug-producing pattern (e.g., swallowed error hides data corruption)
- HIGH: Significant maintainability issue (DI bypass, major duplication)
- MEDIUM: Code smell that increases maintenance cost
- LOW: Style inconsistency, minor convention drift
