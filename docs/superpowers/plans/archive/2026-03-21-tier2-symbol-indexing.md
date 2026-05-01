# AST-Level Symbol Indexing for Context Stuffing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Enhance context-stuffing for free providers to operate at symbol level (functions, classes, interfaces) instead of whole files, dramatically improving context quality within the same token budget.

**Architecture:** A lightweight symbol indexer using tree-sitter parses project files into an SQLite symbol table (name, kind, file, start_line, end_line, content_hash). Context enrichment queries this index to stuff only relevant symbols instead of entire files. Incremental indexing via content hashes -- only re-parses changed files.

**Tech Stack:** tree-sitter (npm: tree-sitter + language grammars), SQLite, existing context-enrichment.js

**Inspired by:** Gobby's CodeIndexer (tree-sitter to SQLite, 90%+ token savings, incremental via content hashes)

---

### Task 1: Symbol indexer core

**Files:**
- Create: `server/utils/symbol-indexer.js`
- Test: `server/tests/symbol-indexer.test.js`

Functions:
- `indexProject(workingDir, options)` -- walks project files, parses with tree-sitter, upserts symbols to SQLite
- `indexFile(filePath, content)` -- parses one file, returns array of Symbol objects
- `getStaleFiles(workingDir)` -- compares content hashes, returns files needing re-index
- `cleanupOrphans(workingDir)` -- removes symbols for deleted files

Symbol model: { id, filePath, name, kind (function|class|interface|method|type|enum|const), startLine, endLine, signature, contentHash, workingDir }

Supported languages (via tree-sitter grammars): TypeScript, JavaScript, Python, Rust, Go, C#. Start with TS/JS as primary.

- [ ] Step 1: Write failing tests for indexFile (extract function and class symbols from a TS snippet)
- [ ] Step 2: Implement tree-sitter parsing for TypeScript/JavaScript
- [ ] Step 3: Write failing tests for incremental indexing (stale detection, orphan cleanup)
- [ ] Step 4: Implement indexProject with content hash tracking
- [ ] Step 5: Run tests
- [ ] Step 6: Commit

---

### Task 2: Symbol search and retrieval

**Files:**
- Modify: `server/utils/symbol-indexer.js` -- add search functions
- Test: `server/tests/symbol-indexer.test.js`

Functions:
- `searchSymbols(query, workingDir, options)` -- name match (prefix, contains, exact), filtered by kind
- `getSymbolSource(symbolId)` -- reads the source lines for a specific symbol from the actual file
- `getFileOutline(filePath)` -- returns hierarchical symbol map (classes containing methods)
- `findRelatedSymbols(symbolName, workingDir)` -- finds imports, usages, implementations

- [ ] Step 1: Write failing tests for searchSymbols
- [ ] Step 2: Implement search queries
- [ ] Step 3: Write failing tests for getSymbolSource
- [ ] Step 4: Implement source retrieval (reads file, extracts startLine-endLine)
- [ ] Step 5: Run tests
- [ ] Step 6: Commit

---

### Task 3: Integrate into context enrichment

**Files:**
- Modify: `server/utils/context-enrichment.js` -- use symbol index when available
- Test: `server/tests/context-enrichment-symbols.test.js`

Current behavior: context-enrichment reads entire files and prepends to prompt.
New behavior: when symbol index exists for the project, resolve which symbols are relevant (from task description mentions, import graph, file references), stuff symbol sources instead of whole files. Fall back to whole-file when no index exists.

- [ ] Step 1: Write failing test -- symbol-level stuffing produces smaller context than file-level for same relevance
- [ ] Step 2: Add symbol resolution logic to context enrichment: extract symbol names from task description, query index, rank by relevance
- [ ] Step 3: Replace whole-file reads with symbol source reads when index is available
- [ ] Step 4: Run tests
- [ ] Step 5: Commit

---

### Task 4: Auto-index trigger

**Files:**
- Modify: `server/handlers/task/pipeline.js` or scan_project handler -- trigger indexing
- Create: `server/utils/symbol-indexer-worker.js` (if needed for background processing)

- [ ] Step 1: Trigger incremental index on scan_project calls
- [ ] Step 2: Trigger incremental index when a task completes and modifies files
- [ ] Step 3: Add index_project MCP tool for manual triggering
- [ ] Step 4: Run tests
- [ ] Step 5: Commit

---

### Task 5: Schema and MCP tools

**Files:**
- Modify: `server/db/schema-tables.js` -- add symbol_index table
- Modify: MCP tool definitions -- add search_symbols, get_file_outline tools
- Modify: `server/tool-annotations.js`

- [ ] Step 1: Add symbol_index table schema
- [ ] Step 2: Add MCP tools
- [ ] Step 3: Run tests
- [ ] Step 4: Commit
