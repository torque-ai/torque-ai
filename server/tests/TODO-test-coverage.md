# Test Coverage TODOs

From bug hunt 2026-03-18. Issues that need new test files.

## Critical Coverage Gaps
- [x] executeOllamaTaskWithAgentic (execution.js:339) — covered by agentic-execution-fixes.test.js — executeOllamaTask wrapper contract (happy path, error throw, metadata cleanup)
- [x] executeApiProviderWithAgentic (execution.js:530) — covered in agentic-execution-fixes.test.js
- [x] OOM/memory-error path (execute-ollama.js:415) — covered in task-distribution-runtime-truth.test.js
- [ ] Context limit exceeded (execute-ollama.js:554) — no unit test
- [x] Host-slot decrement on task failure (execute-ollama.js) — covered in task-distribution-runtime-truth.test.js (test: "releases host slot exactly once when the HTTP request rejects")
