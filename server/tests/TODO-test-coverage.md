# Test Coverage TODOs

From bug hunt 2026-03-18. Issues that need new test files.

## Critical Coverage Gaps
- [ ] executeOllamaTaskWithAgentic (execution.js:339) — no integration test
- [ ] executeApiProviderWithAgentic (execution.js:530) — no integration test
- [ ] ollama-tools.js list_directory, search_files — no unit tests
- [ ] truncateOldestToolResults (ollama-agentic.js:65) — no unit test
- [ ] HTTPS enforcement (execute-ollama.js:391) — no unit test
- [ ] OOM/memory-error path (execute-ollama.js:345) — no unit test
- [ ] Context limit exceeded (execute-ollama.js:554) — no unit test
- [ ] edit_file with replace_all (ollama-tools.js) — no test
- [ ] MAX_FILE_READ_BYTES truncation (ollama-tools.js) — no test
- [ ] MAX_COMMAND_TIMEOUT_MS enforcement (ollama-tools.js) — no test
- [ ] Symlink path-jail escape (ollama-tools.js:9) — no security test
- [ ] Host-slot decrement on task failure (execute-ollama.js) — no test
- [ ] Pre-routed host URL verification (execute-ollama.test.js:342)
