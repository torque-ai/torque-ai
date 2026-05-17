# Test Coverage TODOs

From bug hunt 2026-03-18. Issues that need new test files.

## Critical Coverage Gaps
- [ ] executeOllamaTaskWithAgentic (execution.js:339) — no integration test
- [x] executeApiProviderWithAgentic (execution.js:530) — covered in agentic-execution-fixes.test.js
- [ ] OOM/memory-error path (execute-ollama.js:345) — no unit test
- [ ] Context limit exceeded (execute-ollama.js:554) — no unit test
- [ ] Host-slot decrement on task failure (execute-ollama.js) — no test
