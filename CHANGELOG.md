# Changelog

## [1.34.0] - 2026-04-05

### Added
- Visual sweep hybrid architecture — automated capture, pre-analysis, dedup
- Visual sweep fleet — three-phase deep visual audit system
- Scouts via Codex + /torque-sweep full automated cycle
- Add decomposeTask with provider/model/metadata inheritance
- Add task-decomposition module with provider classes and shouldDecompose
- Sync all agent definitions to repo — repo is source of truth
- Add scout variant definitions to project repo
- Add /torque-scout variant system and codex-primary routing template
- Add /torque-team slash command for one-shot team spawning
- Separate subscription vs API providers in Budget view
- Deprecate v1 API — all dashboard calls now use requestV2
- Swappable activity chart — daily vs hourly toggle
- Hybrid bar+line activity chart with hourly data and smooth curves
- Temp file prevention — auto-commit filter + governance rule
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Use lastIndexOf for sandbox suffix extraction in resolveRelativePath
- Exclude dashboard.test.js from root config (needs jsdom)
- Skip dashboard.test.js when jsdom not available
- Guard cancelled→running transition + add jsdom dev dependency
- Update snapscope test — artifacts now persisted for adhoc captures
- Update peek test expectations for adhoc output dir behavior
- Commit remaining a11y JSX changes + QC active monitoring update
- Batch 13 — 6 DI bypasses, 3 N+1 fixes, rejection sweep, QC active monitoring
- Workstation adapter returns hostUrl not url
- 3 snapscope bugs from visual sweep live test
- Update handleSubmitTask test assertions for provider fix
- Promote core peek tools to tier 1 for immediate availability
- 4 session backlog items
- Add peek_wait, peek_action_sequence, peek_assert, peek_ocr to tier 2
- Snapscope install uses safe container.get with fallback
- Add logger.info/error for plugin install and mcpTools registration
- Preserve taskModel from test-writing promotion in resolveModificationRouting
- Add peek MCP tools and unlock_all_tools to visual sweep agent frontmatter
- GetPlanProject returns null instead of undefined for missing projects
- Batch 10 — eliminate 15 unhandled rejection warnings
- Use testDir instead of hardcoded path in smoke test
- 2 source bugs found by new tests + 2 test fixes
- Rewrite enforcement test to use real fs instead of CJS mocking
- Use vi.hoisted + vi.mock for CJS module mocking in enforcement test
- Convert manifest test files from CJS require to ESM imports
- Update manifest tests for test runner 4.1 compatibility
- Batch 8 — 4 a11y + 5 docs + dep patches + sweep findings
- Update 7 test files to match batch 7 source changes
- QC signals ready instead of running integration pass
- Batch 7 — security, architectural, performance, cleanup
- Update registry-not-initialized test for getInstalledRegistry
- Batch 6 test fixes — registry mock + concurrency handler
- Batch 6 — final cleanup, 8 quick wins
- Round 2 DI migration test fixes — fallback to getDbInstance
- Add container fallback for DI migration test compatibility
- Repair CJS module mocking in build-verification and task-startup tests
- Batch 3 — 12 accessibility fixes across dashboard
- Update decomposition tests for provider-class-aware thresholds
- Skip 4 governance tests — promisify.custom mock incompatibility
- Use vi.mock for child_process in governance tests
- Apply promisify.custom pattern to governance-integration test
- Set promisify.custom before module load in governance tests
- Restore promisify.custom on governance-hooks test mock
- Lazy promisify in governance hooks for test spy compatibility
- Remaining test caller fixes for batch 2 async conversions
- Update test callers for batch 2 async conversions
- Update handleScanProject tests for lstatSync/realpathSync in walkDir
- Batch 1 — 5 security fixes, 3 critical a11y fixes, 4 doc updates
- 5 code quality fixes in server/execution/
- Hard fail when agent definition files are missing
- Torque-team reads agent definitions from repo first, global fallback
- Add explicit shutdown response format to all agent definitions
- Re-skip close-phases quality test with accurate documentation
- Delete dead test, unskip close-phases, document skip reasons
- Handle async startTask rejections in 2 remaining callers
- Update dashboard convergence test — all endpoints now use requestV2
- Skip 3 flaky routing tests, fix test-container-helper exclude
- Disable all cloud providers in starttask routing tests
- Use setConfig instead of raw db.prepare for routing template clear
- Clear routing template in starttask tests, remove stale free-tier assertion
- Resolve 17 pre-existing test failures
- Resolve 6 pre-existing test failures
- Simplify database-backup integration tests for remote isolation
- Update database-backup tests for removed directory param
- Update remaining backup test assertions for removed directory param
- Remove directory param from listBackups handler, update tests
- Update integration-infra tests to use backups/ subdirectory
- Update backup tests for path validation security fix
- Wrap execFile manually instead of promisify for spy compatibility
- Use dynamic childProcess.execFile ref so tests can spy on it
- Use vi.mock with importOriginal for child_process in review tests
- Use beforeAll for execFile spy so promisify captures it at load time
- Spy on execFile before module load in adversarial-review tests
- Use vi.mock for child_process in adversarial-review tests
- Add await to async startTask/collectDiff callers across test files
- Add await to all async caller sites in test files
- Update 5 stale test assertions to match current code
- 7 deferred issues — session eviction, log levels, listener cleanup, dedup, docs
- Repair async conversion and DI fix regressions
- 8 security and quality fixes from scout findings
- Add shutdown handling to all agent definitions, fix duplicate brief
- Remove Budget now deletes all budget records, not just sets one to 0
- Allow budget_usd=0 to clear budget limit
- Add Remove Budget button to budget form
- Show all subscription providers in Budget, label progress as API-only
- Activity chart — smooth lines only, Y-axis starts at 0
- V2 timeseries handler now supports interval=hour param
- Resolve Codex sandbox paths in normalizeCommitPath via suffix matching
- Force LF line endings in CLI task environments via GIT_CONFIG env
- Resolve Strategy test mock setup for overview tab assertions
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Changed
- Batch 12 — extract concerns from 3 oversized functions
- Batch 5 — remove database require from 5 handler/API files
- Register task-decomposition in DI container
- Replace decomposition blocks with provider-class-aware logic
- Merge Queue Manager into QC, simplify pipeline to 3 agents
- Centralize sandbox path resolution into shared utility

### Documentation
- Add visual sweep hybrid architecture implementation plan
- Add visual sweep hybrid architecture design spec
- Add visual sweep fleet implementation plan
- Add visual sweep fleet design spec
- Update scout base definition — Codex is default execution provider
- Add smart decomposition implementation plan
- Add smart decomposition design spec
- Add documentation scan findings (2026-04-04)
- Add full-project quality scan findings (2026-04-04)
- Add full performance scan findings (2026-04-04)
- Add test coverage scan findings (2026-04-04)
- Add dependency scan findings (2026-04-04)
- Add full security scan findings (2026-04-04)
- Add accessibility scan findings for dashboard
- Add execution module quality scan findings
- Condense CLAUDE.md from 708 to 460 lines (35% reduction)
- Add test infrastructure performance scan findings (7 issues)
- Add runtime performance scan findings (2026-04-04)
- Add code quality scan findings (2026-04-04)
- Add security & reliability scan findings (2026-04-04)
- Add TORQUE agent team implementation plan
- Add TORQUE agent team design spec
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Batch 14 — 50 new test cases across 10 P2 modules
- Batch 11 — 97 new test cases across 9 P1 modules
- Batch 9 — 61 new test cases across 8 P0 untested modules
- Batch 4 — 85 new test cases across 8 modules
- Add integration tests for template + decomposition interaction
- Verify temp file filter excludes tmp/ from auto-commit
- Update Strategy tests for routing overview redesign

### Maintenance
- Add docs/findings/ directory for scout discovery artifacts
- Remove temp debug files from Strategy test investigation
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.33.0] - 2026-04-05

### Added
- Visual sweep fleet — three-phase deep visual audit system
- Scouts via Codex + /torque-sweep full automated cycle
- Add decomposeTask with provider/model/metadata inheritance
- Add task-decomposition module with provider classes and shouldDecompose
- Sync all agent definitions to repo — repo is source of truth
- Add scout variant definitions to project repo
- Add /torque-scout variant system and codex-primary routing template
- Add /torque-team slash command for one-shot team spawning
- Separate subscription vs API providers in Budget view
- Deprecate v1 API — all dashboard calls now use requestV2
- Swappable activity chart — daily vs hourly toggle
- Hybrid bar+line activity chart with hourly data and smooth curves
- Temp file prevention — auto-commit filter + governance rule
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Use lastIndexOf for sandbox suffix extraction in resolveRelativePath
- Exclude dashboard.test.js from root config (needs jsdom)
- Skip dashboard.test.js when jsdom not available
- Guard cancelled→running transition + add jsdom dev dependency
- Update snapscope test — artifacts now persisted for adhoc captures
- Update peek test expectations for adhoc output dir behavior
- Commit remaining a11y JSX changes + QC active monitoring update
- Batch 13 — 6 DI bypasses, 3 N+1 fixes, rejection sweep, QC active monitoring
- Workstation adapter returns hostUrl not url
- 3 snapscope bugs from visual sweep live test
- Update handleSubmitTask test assertions for provider fix
- Promote core peek tools to tier 1 for immediate availability
- 4 session backlog items
- Add peek_wait, peek_action_sequence, peek_assert, peek_ocr to tier 2
- Snapscope install uses safe container.get with fallback
- Add logger.info/error for plugin install and mcpTools registration
- Preserve taskModel from test-writing promotion in resolveModificationRouting
- Add peek MCP tools and unlock_all_tools to visual sweep agent frontmatter
- GetPlanProject returns null instead of undefined for missing projects
- Batch 10 — eliminate 15 unhandled rejection warnings
- Use testDir instead of hardcoded path in smoke test
- 2 source bugs found by new tests + 2 test fixes
- Rewrite enforcement test to use real fs instead of CJS mocking
- Use vi.hoisted + vi.mock for CJS module mocking in enforcement test
- Convert manifest test files from CJS require to ESM imports
- Update manifest tests for test runner 4.1 compatibility
- Batch 8 — 4 a11y + 5 docs + dep patches + sweep findings
- Update 7 test files to match batch 7 source changes
- QC signals ready instead of running integration pass
- Batch 7 — security, architectural, performance, cleanup
- Update registry-not-initialized test for getInstalledRegistry
- Batch 6 test fixes — registry mock + concurrency handler
- Batch 6 — final cleanup, 8 quick wins
- Round 2 DI migration test fixes — fallback to getDbInstance
- Add container fallback for DI migration test compatibility
- Repair CJS module mocking in build-verification and task-startup tests
- Batch 3 — 12 accessibility fixes across dashboard
- Update decomposition tests for provider-class-aware thresholds
- Skip 4 governance tests — promisify.custom mock incompatibility
- Use vi.mock for child_process in governance tests
- Apply promisify.custom pattern to governance-integration test
- Set promisify.custom before module load in governance tests
- Restore promisify.custom on governance-hooks test mock
- Lazy promisify in governance hooks for test spy compatibility
- Remaining test caller fixes for batch 2 async conversions
- Update test callers for batch 2 async conversions
- Update handleScanProject tests for lstatSync/realpathSync in walkDir
- Batch 1 — 5 security fixes, 3 critical a11y fixes, 4 doc updates
- 5 code quality fixes in server/execution/
- Hard fail when agent definition files are missing
- Torque-team reads agent definitions from repo first, global fallback
- Add explicit shutdown response format to all agent definitions
- Re-skip close-phases quality test with accurate documentation
- Delete dead test, unskip close-phases, document skip reasons
- Handle async startTask rejections in 2 remaining callers
- Update dashboard convergence test — all endpoints now use requestV2
- Skip 3 flaky routing tests, fix test-container-helper exclude
- Disable all cloud providers in starttask routing tests
- Use setConfig instead of raw db.prepare for routing template clear
- Clear routing template in starttask tests, remove stale free-tier assertion
- Resolve 17 pre-existing test failures
- Resolve 6 pre-existing test failures
- Simplify database-backup integration tests for remote isolation
- Update database-backup tests for removed directory param
- Update remaining backup test assertions for removed directory param
- Remove directory param from listBackups handler, update tests
- Update integration-infra tests to use backups/ subdirectory
- Update backup tests for path validation security fix
- Wrap execFile manually instead of promisify for spy compatibility
- Use dynamic childProcess.execFile ref so tests can spy on it
- Use vi.mock with importOriginal for child_process in review tests
- Use beforeAll for execFile spy so promisify captures it at load time
- Spy on execFile before module load in adversarial-review tests
- Use vi.mock for child_process in adversarial-review tests
- Add await to async startTask/collectDiff callers across test files
- Add await to all async caller sites in test files
- Update 5 stale test assertions to match current code
- 7 deferred issues — session eviction, log levels, listener cleanup, dedup, docs
- Repair async conversion and DI fix regressions
- 8 security and quality fixes from scout findings
- Add shutdown handling to all agent definitions, fix duplicate brief
- Remove Budget now deletes all budget records, not just sets one to 0
- Allow budget_usd=0 to clear budget limit
- Add Remove Budget button to budget form
- Show all subscription providers in Budget, label progress as API-only
- Activity chart — smooth lines only, Y-axis starts at 0
- V2 timeseries handler now supports interval=hour param
- Resolve Codex sandbox paths in normalizeCommitPath via suffix matching
- Force LF line endings in CLI task environments via GIT_CONFIG env
- Resolve Strategy test mock setup for overview tab assertions
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Changed
- Batch 12 — extract concerns from 3 oversized functions
- Batch 5 — remove database require from 5 handler/API files
- Register task-decomposition in DI container
- Replace decomposition blocks with provider-class-aware logic
- Merge Queue Manager into QC, simplify pipeline to 3 agents
- Centralize sandbox path resolution into shared utility

### Documentation
- Add visual sweep hybrid architecture implementation plan
- Add visual sweep hybrid architecture design spec
- Add visual sweep fleet implementation plan
- Add visual sweep fleet design spec
- Update scout base definition — Codex is default execution provider
- Add smart decomposition implementation plan
- Add smart decomposition design spec
- Add documentation scan findings (2026-04-04)
- Add full-project quality scan findings (2026-04-04)
- Add full performance scan findings (2026-04-04)
- Add test coverage scan findings (2026-04-04)
- Add dependency scan findings (2026-04-04)
- Add full security scan findings (2026-04-04)
- Add accessibility scan findings for dashboard
- Add execution module quality scan findings
- Condense CLAUDE.md from 708 to 460 lines (35% reduction)
- Add test infrastructure performance scan findings (7 issues)
- Add runtime performance scan findings (2026-04-04)
- Add code quality scan findings (2026-04-04)
- Add security & reliability scan findings (2026-04-04)
- Add TORQUE agent team implementation plan
- Add TORQUE agent team design spec
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Batch 14 — 50 new test cases across 10 P2 modules
- Batch 11 — 97 new test cases across 9 P1 modules
- Batch 9 — 61 new test cases across 8 P0 untested modules
- Batch 4 — 85 new test cases across 8 modules
- Add integration tests for template + decomposition interaction
- Verify temp file filter excludes tmp/ from auto-commit
- Update Strategy tests for routing overview redesign

### Maintenance
- Add docs/findings/ directory for scout discovery artifacts
- Remove temp debug files from Strategy test investigation
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.31.0] - 2026-04-05

### Added
- Visual sweep fleet — three-phase deep visual audit system
- Scouts via Codex + /torque-sweep full automated cycle
- Add decomposeTask with provider/model/metadata inheritance
- Add task-decomposition module with provider classes and shouldDecompose
- Sync all agent definitions to repo — repo is source of truth
- Add scout variant definitions to project repo
- Add /torque-scout variant system and codex-primary routing template
- Add /torque-team slash command for one-shot team spawning
- Separate subscription vs API providers in Budget view
- Deprecate v1 API — all dashboard calls now use requestV2
- Swappable activity chart — daily vs hourly toggle
- Hybrid bar+line activity chart with hourly data and smooth curves
- Temp file prevention — auto-commit filter + governance rule
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Workstation adapter returns hostUrl not url
- 3 snapscope bugs from visual sweep live test
- Update handleSubmitTask test assertions for provider fix
- Promote core peek tools to tier 1 for immediate availability
- 4 session backlog items
- Add peek_wait, peek_action_sequence, peek_assert, peek_ocr to tier 2
- Snapscope install uses safe container.get with fallback
- Add logger.info/error for plugin install and mcpTools registration
- Preserve taskModel from test-writing promotion in resolveModificationRouting
- Add peek MCP tools and unlock_all_tools to visual sweep agent frontmatter
- GetPlanProject returns null instead of undefined for missing projects
- Batch 10 — eliminate 15 unhandled rejection warnings
- Use testDir instead of hardcoded path in smoke test
- 2 source bugs found by new tests + 2 test fixes
- Rewrite enforcement test to use real fs instead of CJS mocking
- Use vi.hoisted + vi.mock for CJS module mocking in enforcement test
- Convert manifest test files from CJS require to ESM imports
- Update manifest tests for test runner 4.1 compatibility
- Batch 8 — 4 a11y + 5 docs + dep patches + sweep findings
- Update 7 test files to match batch 7 source changes
- QC signals ready instead of running integration pass
- Batch 7 — security, architectural, performance, cleanup
- Update registry-not-initialized test for getInstalledRegistry
- Batch 6 test fixes — registry mock + concurrency handler
- Batch 6 — final cleanup, 8 quick wins
- Round 2 DI migration test fixes — fallback to getDbInstance
- Add container fallback for DI migration test compatibility
- Repair CJS module mocking in build-verification and task-startup tests
- Batch 3 — 12 accessibility fixes across dashboard
- Update decomposition tests for provider-class-aware thresholds
- Skip 4 governance tests — promisify.custom mock incompatibility
- Use vi.mock for child_process in governance tests
- Apply promisify.custom pattern to governance-integration test
- Set promisify.custom before module load in governance tests
- Restore promisify.custom on governance-hooks test mock
- Lazy promisify in governance hooks for test spy compatibility
- Remaining test caller fixes for batch 2 async conversions
- Update test callers for batch 2 async conversions
- Update handleScanProject tests for lstatSync/realpathSync in walkDir
- Batch 1 — 5 security fixes, 3 critical a11y fixes, 4 doc updates
- 5 code quality fixes in server/execution/
- Hard fail when agent definition files are missing
- Torque-team reads agent definitions from repo first, global fallback
- Add explicit shutdown response format to all agent definitions
- Re-skip close-phases quality test with accurate documentation
- Delete dead test, unskip close-phases, document skip reasons
- Handle async startTask rejections in 2 remaining callers
- Update dashboard convergence test — all endpoints now use requestV2
- Skip 3 flaky routing tests, fix test-container-helper exclude
- Disable all cloud providers in starttask routing tests
- Use setConfig instead of raw db.prepare for routing template clear
- Clear routing template in starttask tests, remove stale free-tier assertion
- Resolve 17 pre-existing test failures
- Resolve 6 pre-existing test failures
- Simplify database-backup integration tests for remote isolation
- Update database-backup tests for removed directory param
- Update remaining backup test assertions for removed directory param
- Remove directory param from listBackups handler, update tests
- Update integration-infra tests to use backups/ subdirectory
- Update backup tests for path validation security fix
- Wrap execFile manually instead of promisify for spy compatibility
- Use dynamic childProcess.execFile ref so tests can spy on it
- Use vi.mock with importOriginal for child_process in review tests
- Use beforeAll for execFile spy so promisify captures it at load time
- Spy on execFile before module load in adversarial-review tests
- Use vi.mock for child_process in adversarial-review tests
- Add await to async startTask/collectDiff callers across test files
- Add await to all async caller sites in test files
- Update 5 stale test assertions to match current code
- 7 deferred issues — session eviction, log levels, listener cleanup, dedup, docs
- Repair async conversion and DI fix regressions
- 8 security and quality fixes from scout findings
- Add shutdown handling to all agent definitions, fix duplicate brief
- Remove Budget now deletes all budget records, not just sets one to 0
- Allow budget_usd=0 to clear budget limit
- Add Remove Budget button to budget form
- Show all subscription providers in Budget, label progress as API-only
- Activity chart — smooth lines only, Y-axis starts at 0
- V2 timeseries handler now supports interval=hour param
- Resolve Codex sandbox paths in normalizeCommitPath via suffix matching
- Force LF line endings in CLI task environments via GIT_CONFIG env
- Resolve Strategy test mock setup for overview tab assertions
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Changed
- Batch 12 — extract concerns from 3 oversized functions
- Batch 5 — remove database require from 5 handler/API files
- Register task-decomposition in DI container
- Replace decomposition blocks with provider-class-aware logic
- Merge Queue Manager into QC, simplify pipeline to 3 agents
- Centralize sandbox path resolution into shared utility

### Documentation
- Add visual sweep fleet implementation plan
- Add visual sweep fleet design spec
- Update scout base definition — Codex is default execution provider
- Add smart decomposition implementation plan
- Add smart decomposition design spec
- Add documentation scan findings (2026-04-04)
- Add full-project quality scan findings (2026-04-04)
- Add full performance scan findings (2026-04-04)
- Add test coverage scan findings (2026-04-04)
- Add dependency scan findings (2026-04-04)
- Add full security scan findings (2026-04-04)
- Add accessibility scan findings for dashboard
- Add execution module quality scan findings
- Condense CLAUDE.md from 708 to 460 lines (35% reduction)
- Add test infrastructure performance scan findings (7 issues)
- Add runtime performance scan findings (2026-04-04)
- Add code quality scan findings (2026-04-04)
- Add security & reliability scan findings (2026-04-04)
- Add TORQUE agent team implementation plan
- Add TORQUE agent team design spec
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Batch 11 — 97 new test cases across 9 P1 modules
- Batch 9 — 61 new test cases across 8 P0 untested modules
- Batch 4 — 85 new test cases across 8 modules
- Add integration tests for template + decomposition interaction
- Verify temp file filter excludes tmp/ from auto-commit
- Update Strategy tests for routing overview redesign

### Maintenance
- Add docs/findings/ directory for scout discovery artifacts
- Remove temp debug files from Strategy test investigation
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.30.0] - 2026-04-05

### Added
- Visual sweep fleet — three-phase deep visual audit system
- Scouts via Codex + /torque-sweep full automated cycle
- Add decomposeTask with provider/model/metadata inheritance
- Add task-decomposition module with provider classes and shouldDecompose
- Sync all agent definitions to repo — repo is source of truth
- Add scout variant definitions to project repo
- Add /torque-scout variant system and codex-primary routing template
- Add /torque-team slash command for one-shot team spawning
- Separate subscription vs API providers in Budget view
- Deprecate v1 API — all dashboard calls now use requestV2
- Swappable activity chart — daily vs hourly toggle
- Hybrid bar+line activity chart with hourly data and smooth curves
- Temp file prevention — auto-commit filter + governance rule
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- 3 snapscope bugs from visual sweep live test
- Update handleSubmitTask test assertions for provider fix
- Promote core peek tools to tier 1 for immediate availability
- 4 session backlog items
- Add peek_wait, peek_action_sequence, peek_assert, peek_ocr to tier 2
- Snapscope install uses safe container.get with fallback
- Add logger.info/error for plugin install and mcpTools registration
- Preserve taskModel from test-writing promotion in resolveModificationRouting
- Add peek MCP tools and unlock_all_tools to visual sweep agent frontmatter
- GetPlanProject returns null instead of undefined for missing projects
- Batch 10 — eliminate 15 unhandled rejection warnings
- Use testDir instead of hardcoded path in smoke test
- 2 source bugs found by new tests + 2 test fixes
- Rewrite enforcement test to use real fs instead of CJS mocking
- Use vi.hoisted + vi.mock for CJS module mocking in enforcement test
- Convert manifest test files from CJS require to ESM imports
- Update manifest tests for test runner 4.1 compatibility
- Batch 8 — 4 a11y + 5 docs + dep patches + sweep findings
- Update 7 test files to match batch 7 source changes
- QC signals ready instead of running integration pass
- Batch 7 — security, architectural, performance, cleanup
- Update registry-not-initialized test for getInstalledRegistry
- Batch 6 test fixes — registry mock + concurrency handler
- Batch 6 — final cleanup, 8 quick wins
- Round 2 DI migration test fixes — fallback to getDbInstance
- Add container fallback for DI migration test compatibility
- Repair CJS module mocking in build-verification and task-startup tests
- Batch 3 — 12 accessibility fixes across dashboard
- Update decomposition tests for provider-class-aware thresholds
- Skip 4 governance tests — promisify.custom mock incompatibility
- Use vi.mock for child_process in governance tests
- Apply promisify.custom pattern to governance-integration test
- Set promisify.custom before module load in governance tests
- Restore promisify.custom on governance-hooks test mock
- Lazy promisify in governance hooks for test spy compatibility
- Remaining test caller fixes for batch 2 async conversions
- Update test callers for batch 2 async conversions
- Update handleScanProject tests for lstatSync/realpathSync in walkDir
- Batch 1 — 5 security fixes, 3 critical a11y fixes, 4 doc updates
- 5 code quality fixes in server/execution/
- Hard fail when agent definition files are missing
- Torque-team reads agent definitions from repo first, global fallback
- Add explicit shutdown response format to all agent definitions
- Re-skip close-phases quality test with accurate documentation
- Delete dead test, unskip close-phases, document skip reasons
- Handle async startTask rejections in 2 remaining callers
- Update dashboard convergence test — all endpoints now use requestV2
- Skip 3 flaky routing tests, fix test-container-helper exclude
- Disable all cloud providers in starttask routing tests
- Use setConfig instead of raw db.prepare for routing template clear
- Clear routing template in starttask tests, remove stale free-tier assertion
- Resolve 17 pre-existing test failures
- Resolve 6 pre-existing test failures
- Simplify database-backup integration tests for remote isolation
- Update database-backup tests for removed directory param
- Update remaining backup test assertions for removed directory param
- Remove directory param from listBackups handler, update tests
- Update integration-infra tests to use backups/ subdirectory
- Update backup tests for path validation security fix
- Wrap execFile manually instead of promisify for spy compatibility
- Use dynamic childProcess.execFile ref so tests can spy on it
- Use vi.mock with importOriginal for child_process in review tests
- Use beforeAll for execFile spy so promisify captures it at load time
- Spy on execFile before module load in adversarial-review tests
- Use vi.mock for child_process in adversarial-review tests
- Add await to async startTask/collectDiff callers across test files
- Add await to all async caller sites in test files
- Update 5 stale test assertions to match current code
- 7 deferred issues — session eviction, log levels, listener cleanup, dedup, docs
- Repair async conversion and DI fix regressions
- 8 security and quality fixes from scout findings
- Add shutdown handling to all agent definitions, fix duplicate brief
- Remove Budget now deletes all budget records, not just sets one to 0
- Allow budget_usd=0 to clear budget limit
- Add Remove Budget button to budget form
- Show all subscription providers in Budget, label progress as API-only
- Activity chart — smooth lines only, Y-axis starts at 0
- V2 timeseries handler now supports interval=hour param
- Resolve Codex sandbox paths in normalizeCommitPath via suffix matching
- Force LF line endings in CLI task environments via GIT_CONFIG env
- Resolve Strategy test mock setup for overview tab assertions
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Changed
- Batch 12 — extract concerns from 3 oversized functions
- Batch 5 — remove database require from 5 handler/API files
- Register task-decomposition in DI container
- Replace decomposition blocks with provider-class-aware logic
- Merge Queue Manager into QC, simplify pipeline to 3 agents
- Centralize sandbox path resolution into shared utility

### Documentation
- Add visual sweep fleet implementation plan
- Add visual sweep fleet design spec
- Update scout base definition — Codex is default execution provider
- Add smart decomposition implementation plan
- Add smart decomposition design spec
- Add documentation scan findings (2026-04-04)
- Add full-project quality scan findings (2026-04-04)
- Add full performance scan findings (2026-04-04)
- Add test coverage scan findings (2026-04-04)
- Add dependency scan findings (2026-04-04)
- Add full security scan findings (2026-04-04)
- Add accessibility scan findings for dashboard
- Add execution module quality scan findings
- Condense CLAUDE.md from 708 to 460 lines (35% reduction)
- Add test infrastructure performance scan findings (7 issues)
- Add runtime performance scan findings (2026-04-04)
- Add code quality scan findings (2026-04-04)
- Add security & reliability scan findings (2026-04-04)
- Add TORQUE agent team implementation plan
- Add TORQUE agent team design spec
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Batch 11 — 97 new test cases across 9 P1 modules
- Batch 9 — 61 new test cases across 8 P0 untested modules
- Batch 4 — 85 new test cases across 8 modules
- Add integration tests for template + decomposition interaction
- Verify temp file filter excludes tmp/ from auto-commit
- Update Strategy tests for routing overview redesign

### Maintenance
- Add docs/findings/ directory for scout discovery artifacts
- Remove temp debug files from Strategy test investigation
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.29.0] - 2026-04-05

### Added
- Visual sweep fleet — three-phase deep visual audit system
- Scouts via Codex + /torque-sweep full automated cycle
- Add decomposeTask with provider/model/metadata inheritance
- Add task-decomposition module with provider classes and shouldDecompose
- Sync all agent definitions to repo — repo is source of truth
- Add scout variant definitions to project repo
- Add /torque-scout variant system and codex-primary routing template
- Add /torque-team slash command for one-shot team spawning
- Separate subscription vs API providers in Budget view
- Deprecate v1 API — all dashboard calls now use requestV2
- Swappable activity chart — daily vs hourly toggle
- Hybrid bar+line activity chart with hourly data and smooth curves
- Temp file prevention — auto-commit filter + governance rule
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Add peek_wait, peek_action_sequence, peek_assert, peek_ocr to tier 2
- Snapscope install uses safe container.get with fallback
- Add logger.info/error for plugin install and mcpTools registration
- Preserve taskModel from test-writing promotion in resolveModificationRouting
- Add peek MCP tools and unlock_all_tools to visual sweep agent frontmatter
- GetPlanProject returns null instead of undefined for missing projects
- Batch 10 — eliminate 15 unhandled rejection warnings
- Use testDir instead of hardcoded path in smoke test
- 2 source bugs found by new tests + 2 test fixes
- Rewrite enforcement test to use real fs instead of CJS mocking
- Use vi.hoisted + vi.mock for CJS module mocking in enforcement test
- Convert manifest test files from CJS require to ESM imports
- Update manifest tests for test runner 4.1 compatibility
- Batch 8 — 4 a11y + 5 docs + dep patches + sweep findings
- Update 7 test files to match batch 7 source changes
- QC signals ready instead of running integration pass
- Batch 7 — security, architectural, performance, cleanup
- Update registry-not-initialized test for getInstalledRegistry
- Batch 6 test fixes — registry mock + concurrency handler
- Batch 6 — final cleanup, 8 quick wins
- Round 2 DI migration test fixes — fallback to getDbInstance
- Add container fallback for DI migration test compatibility
- Repair CJS module mocking in build-verification and task-startup tests
- Batch 3 — 12 accessibility fixes across dashboard
- Update decomposition tests for provider-class-aware thresholds
- Skip 4 governance tests — promisify.custom mock incompatibility
- Use vi.mock for child_process in governance tests
- Apply promisify.custom pattern to governance-integration test
- Set promisify.custom before module load in governance tests
- Restore promisify.custom on governance-hooks test mock
- Lazy promisify in governance hooks for test spy compatibility
- Remaining test caller fixes for batch 2 async conversions
- Update test callers for batch 2 async conversions
- Update handleScanProject tests for lstatSync/realpathSync in walkDir
- Batch 1 — 5 security fixes, 3 critical a11y fixes, 4 doc updates
- 5 code quality fixes in server/execution/
- Hard fail when agent definition files are missing
- Torque-team reads agent definitions from repo first, global fallback
- Add explicit shutdown response format to all agent definitions
- Re-skip close-phases quality test with accurate documentation
- Delete dead test, unskip close-phases, document skip reasons
- Handle async startTask rejections in 2 remaining callers
- Update dashboard convergence test — all endpoints now use requestV2
- Skip 3 flaky routing tests, fix test-container-helper exclude
- Disable all cloud providers in starttask routing tests
- Use setConfig instead of raw db.prepare for routing template clear
- Clear routing template in starttask tests, remove stale free-tier assertion
- Resolve 17 pre-existing test failures
- Resolve 6 pre-existing test failures
- Simplify database-backup integration tests for remote isolation
- Update database-backup tests for removed directory param
- Update remaining backup test assertions for removed directory param
- Remove directory param from listBackups handler, update tests
- Update integration-infra tests to use backups/ subdirectory
- Update backup tests for path validation security fix
- Wrap execFile manually instead of promisify for spy compatibility
- Use dynamic childProcess.execFile ref so tests can spy on it
- Use vi.mock with importOriginal for child_process in review tests
- Use beforeAll for execFile spy so promisify captures it at load time
- Spy on execFile before module load in adversarial-review tests
- Use vi.mock for child_process in adversarial-review tests
- Add await to async startTask/collectDiff callers across test files
- Add await to all async caller sites in test files
- Update 5 stale test assertions to match current code
- 7 deferred issues — session eviction, log levels, listener cleanup, dedup, docs
- Repair async conversion and DI fix regressions
- 8 security and quality fixes from scout findings
- Add shutdown handling to all agent definitions, fix duplicate brief
- Remove Budget now deletes all budget records, not just sets one to 0
- Allow budget_usd=0 to clear budget limit
- Add Remove Budget button to budget form
- Show all subscription providers in Budget, label progress as API-only
- Activity chart — smooth lines only, Y-axis starts at 0
- V2 timeseries handler now supports interval=hour param
- Resolve Codex sandbox paths in normalizeCommitPath via suffix matching
- Force LF line endings in CLI task environments via GIT_CONFIG env
- Resolve Strategy test mock setup for overview tab assertions
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Changed
- Batch 12 — extract concerns from 3 oversized functions
- Batch 5 — remove database require from 5 handler/API files
- Register task-decomposition in DI container
- Replace decomposition blocks with provider-class-aware logic
- Merge Queue Manager into QC, simplify pipeline to 3 agents
- Centralize sandbox path resolution into shared utility

### Documentation
- Add visual sweep fleet implementation plan
- Add visual sweep fleet design spec
- Update scout base definition — Codex is default execution provider
- Add smart decomposition implementation plan
- Add smart decomposition design spec
- Add documentation scan findings (2026-04-04)
- Add full-project quality scan findings (2026-04-04)
- Add full performance scan findings (2026-04-04)
- Add test coverage scan findings (2026-04-04)
- Add dependency scan findings (2026-04-04)
- Add full security scan findings (2026-04-04)
- Add accessibility scan findings for dashboard
- Add execution module quality scan findings
- Condense CLAUDE.md from 708 to 460 lines (35% reduction)
- Add test infrastructure performance scan findings (7 issues)
- Add runtime performance scan findings (2026-04-04)
- Add code quality scan findings (2026-04-04)
- Add security & reliability scan findings (2026-04-04)
- Add TORQUE agent team implementation plan
- Add TORQUE agent team design spec
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Batch 11 — 97 new test cases across 9 P1 modules
- Batch 9 — 61 new test cases across 8 P0 untested modules
- Batch 4 — 85 new test cases across 8 modules
- Add integration tests for template + decomposition interaction
- Verify temp file filter excludes tmp/ from auto-commit
- Update Strategy tests for routing overview redesign

### Maintenance
- Add docs/findings/ directory for scout discovery artifacts
- Remove temp debug files from Strategy test investigation
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.21.0] - 2026-04-05

### Added
- Add decomposeTask with provider/model/metadata inheritance
- Add task-decomposition module with provider classes and shouldDecompose
- Sync all agent definitions to repo — repo is source of truth
- Add scout variant definitions to project repo
- Add /torque-scout variant system and codex-primary routing template
- Add /torque-team slash command for one-shot team spawning
- Separate subscription vs API providers in Budget view
- Deprecate v1 API — all dashboard calls now use requestV2
- Swappable activity chart — daily vs hourly toggle
- Hybrid bar+line activity chart with hourly data and smooth curves
- Temp file prevention — auto-commit filter + governance rule
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Round 2 DI migration test fixes — fallback to getDbInstance
- Add container fallback for DI migration test compatibility
- Repair CJS module mocking in build-verification and task-startup tests
- Batch 3 — 12 accessibility fixes across dashboard
- Update decomposition tests for provider-class-aware thresholds
- Skip 4 governance tests — promisify.custom mock incompatibility
- Use vi.mock for child_process in governance tests
- Apply promisify.custom pattern to governance-integration test
- Set promisify.custom before module load in governance tests
- Restore promisify.custom on governance-hooks test mock
- Lazy promisify in governance hooks for test spy compatibility
- Remaining test caller fixes for batch 2 async conversions
- Update test callers for batch 2 async conversions
- Update handleScanProject tests for lstatSync/realpathSync in walkDir
- Batch 1 — 5 security fixes, 3 critical a11y fixes, 4 doc updates
- 5 code quality fixes in server/execution/
- Hard fail when agent definition files are missing
- Torque-team reads agent definitions from repo first, global fallback
- Add explicit shutdown response format to all agent definitions
- Re-skip close-phases quality test with accurate documentation
- Delete dead test, unskip close-phases, document skip reasons
- Handle async startTask rejections in 2 remaining callers
- Update dashboard convergence test — all endpoints now use requestV2
- Skip 3 flaky routing tests, fix test-container-helper exclude
- Disable all cloud providers in starttask routing tests
- Use setConfig instead of raw db.prepare for routing template clear
- Clear routing template in starttask tests, remove stale free-tier assertion
- Resolve 17 pre-existing test failures
- Resolve 6 pre-existing test failures
- Simplify database-backup integration tests for remote isolation
- Update database-backup tests for removed directory param
- Update remaining backup test assertions for removed directory param
- Remove directory param from listBackups handler, update tests
- Update integration-infra tests to use backups/ subdirectory
- Update backup tests for path validation security fix
- Wrap execFile manually instead of promisify for spy compatibility
- Use dynamic childProcess.execFile ref so tests can spy on it
- Use vi.mock with importOriginal for child_process in review tests
- Use beforeAll for execFile spy so promisify captures it at load time
- Spy on execFile before module load in adversarial-review tests
- Use vi.mock for child_process in adversarial-review tests
- Add await to async startTask/collectDiff callers across test files
- Add await to all async caller sites in test files
- Update 5 stale test assertions to match current code
- 7 deferred issues — session eviction, log levels, listener cleanup, dedup, docs
- Repair async conversion and DI fix regressions
- 8 security and quality fixes from scout findings
- Add shutdown handling to all agent definitions, fix duplicate brief
- Remove Budget now deletes all budget records, not just sets one to 0
- Allow budget_usd=0 to clear budget limit
- Add Remove Budget button to budget form
- Show all subscription providers in Budget, label progress as API-only
- Activity chart — smooth lines only, Y-axis starts at 0
- V2 timeseries handler now supports interval=hour param
- Resolve Codex sandbox paths in normalizeCommitPath via suffix matching
- Force LF line endings in CLI task environments via GIT_CONFIG env
- Resolve Strategy test mock setup for overview tab assertions
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Changed
- Batch 5 — remove database require from 5 handler/API files
- Register task-decomposition in DI container
- Replace decomposition blocks with provider-class-aware logic
- Merge Queue Manager into QC, simplify pipeline to 3 agents
- Centralize sandbox path resolution into shared utility

### Documentation
- Add smart decomposition implementation plan
- Add smart decomposition design spec
- Add documentation scan findings (2026-04-04)
- Add full-project quality scan findings (2026-04-04)
- Add full performance scan findings (2026-04-04)
- Add test coverage scan findings (2026-04-04)
- Add dependency scan findings (2026-04-04)
- Add full security scan findings (2026-04-04)
- Add accessibility scan findings for dashboard
- Add execution module quality scan findings
- Condense CLAUDE.md from 708 to 460 lines (35% reduction)
- Add test infrastructure performance scan findings (7 issues)
- Add runtime performance scan findings (2026-04-04)
- Add code quality scan findings (2026-04-04)
- Add security & reliability scan findings (2026-04-04)
- Add TORQUE agent team implementation plan
- Add TORQUE agent team design spec
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Batch 4 — 85 new test cases across 8 modules
- Add integration tests for template + decomposition interaction
- Verify temp file filter excludes tmp/ from auto-commit
- Update Strategy tests for routing overview redesign

### Maintenance
- Add docs/findings/ directory for scout discovery artifacts
- Remove temp debug files from Strategy test investigation
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.20.0] - 2026-04-05

### Added
- Add decomposeTask with provider/model/metadata inheritance
- Add task-decomposition module with provider classes and shouldDecompose
- Sync all agent definitions to repo — repo is source of truth
- Add scout variant definitions to project repo
- Add /torque-scout variant system and codex-primary routing template
- Add /torque-team slash command for one-shot team spawning
- Separate subscription vs API providers in Budget view
- Deprecate v1 API — all dashboard calls now use requestV2
- Swappable activity chart — daily vs hourly toggle
- Hybrid bar+line activity chart with hourly data and smooth curves
- Temp file prevention — auto-commit filter + governance rule
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Repair CJS module mocking in build-verification and task-startup tests
- Batch 3 — 12 accessibility fixes across dashboard
- Update decomposition tests for provider-class-aware thresholds
- Skip 4 governance tests — promisify.custom mock incompatibility
- Use vi.mock for child_process in governance tests
- Apply promisify.custom pattern to governance-integration test
- Set promisify.custom before module load in governance tests
- Restore promisify.custom on governance-hooks test mock
- Lazy promisify in governance hooks for test spy compatibility
- Remaining test caller fixes for batch 2 async conversions
- Update test callers for batch 2 async conversions
- Update handleScanProject tests for lstatSync/realpathSync in walkDir
- Batch 1 — 5 security fixes, 3 critical a11y fixes, 4 doc updates
- 5 code quality fixes in server/execution/
- Hard fail when agent definition files are missing
- Torque-team reads agent definitions from repo first, global fallback
- Add explicit shutdown response format to all agent definitions
- Re-skip close-phases quality test with accurate documentation
- Delete dead test, unskip close-phases, document skip reasons
- Handle async startTask rejections in 2 remaining callers
- Update dashboard convergence test — all endpoints now use requestV2
- Skip 3 flaky routing tests, fix test-container-helper exclude
- Disable all cloud providers in starttask routing tests
- Use setConfig instead of raw db.prepare for routing template clear
- Clear routing template in starttask tests, remove stale free-tier assertion
- Resolve 17 pre-existing test failures
- Resolve 6 pre-existing test failures
- Simplify database-backup integration tests for remote isolation
- Update database-backup tests for removed directory param
- Update remaining backup test assertions for removed directory param
- Remove directory param from listBackups handler, update tests
- Update integration-infra tests to use backups/ subdirectory
- Update backup tests for path validation security fix
- Wrap execFile manually instead of promisify for spy compatibility
- Use dynamic childProcess.execFile ref so tests can spy on it
- Use vi.mock with importOriginal for child_process in review tests
- Use beforeAll for execFile spy so promisify captures it at load time
- Spy on execFile before module load in adversarial-review tests
- Use vi.mock for child_process in adversarial-review tests
- Add await to async startTask/collectDiff callers across test files
- Add await to all async caller sites in test files
- Update 5 stale test assertions to match current code
- 7 deferred issues — session eviction, log levels, listener cleanup, dedup, docs
- Repair async conversion and DI fix regressions
- 8 security and quality fixes from scout findings
- Add shutdown handling to all agent definitions, fix duplicate brief
- Remove Budget now deletes all budget records, not just sets one to 0
- Allow budget_usd=0 to clear budget limit
- Add Remove Budget button to budget form
- Show all subscription providers in Budget, label progress as API-only
- Activity chart — smooth lines only, Y-axis starts at 0
- V2 timeseries handler now supports interval=hour param
- Resolve Codex sandbox paths in normalizeCommitPath via suffix matching
- Force LF line endings in CLI task environments via GIT_CONFIG env
- Resolve Strategy test mock setup for overview tab assertions
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Changed
- Register task-decomposition in DI container
- Replace decomposition blocks with provider-class-aware logic
- Merge Queue Manager into QC, simplify pipeline to 3 agents
- Centralize sandbox path resolution into shared utility

### Documentation
- Add smart decomposition implementation plan
- Add smart decomposition design spec
- Add documentation scan findings (2026-04-04)
- Add full-project quality scan findings (2026-04-04)
- Add full performance scan findings (2026-04-04)
- Add test coverage scan findings (2026-04-04)
- Add dependency scan findings (2026-04-04)
- Add full security scan findings (2026-04-04)
- Add accessibility scan findings for dashboard
- Add execution module quality scan findings
- Condense CLAUDE.md from 708 to 460 lines (35% reduction)
- Add test infrastructure performance scan findings (7 issues)
- Add runtime performance scan findings (2026-04-04)
- Add code quality scan findings (2026-04-04)
- Add security & reliability scan findings (2026-04-04)
- Add TORQUE agent team implementation plan
- Add TORQUE agent team design spec
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Batch 4 — 85 new test cases across 8 modules
- Add integration tests for template + decomposition interaction
- Verify temp file filter excludes tmp/ from auto-commit
- Update Strategy tests for routing overview redesign

### Maintenance
- Add docs/findings/ directory for scout discovery artifacts
- Remove temp debug files from Strategy test investigation
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.19.0] - 2026-04-05

### Added
- Add decomposeTask with provider/model/metadata inheritance
- Add task-decomposition module with provider classes and shouldDecompose
- Sync all agent definitions to repo — repo is source of truth
- Add scout variant definitions to project repo
- Add /torque-scout variant system and codex-primary routing template
- Add /torque-team slash command for one-shot team spawning
- Separate subscription vs API providers in Budget view
- Deprecate v1 API — all dashboard calls now use requestV2
- Swappable activity chart — daily vs hourly toggle
- Hybrid bar+line activity chart with hourly data and smooth curves
- Temp file prevention — auto-commit filter + governance rule
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Batch 3 — 12 accessibility fixes across dashboard
- Update decomposition tests for provider-class-aware thresholds
- Skip 4 governance tests — promisify.custom mock incompatibility
- Use vi.mock for child_process in governance tests
- Apply promisify.custom pattern to governance-integration test
- Set promisify.custom before module load in governance tests
- Restore promisify.custom on governance-hooks test mock
- Lazy promisify in governance hooks for test spy compatibility
- Remaining test caller fixes for batch 2 async conversions
- Update test callers for batch 2 async conversions
- Update handleScanProject tests for lstatSync/realpathSync in walkDir
- Batch 1 — 5 security fixes, 3 critical a11y fixes, 4 doc updates
- 5 code quality fixes in server/execution/
- Hard fail when agent definition files are missing
- Torque-team reads agent definitions from repo first, global fallback
- Add explicit shutdown response format to all agent definitions
- Re-skip close-phases quality test with accurate documentation
- Delete dead test, unskip close-phases, document skip reasons
- Handle async startTask rejections in 2 remaining callers
- Update dashboard convergence test — all endpoints now use requestV2
- Skip 3 flaky routing tests, fix test-container-helper exclude
- Disable all cloud providers in starttask routing tests
- Use setConfig instead of raw db.prepare for routing template clear
- Clear routing template in starttask tests, remove stale free-tier assertion
- Resolve 17 pre-existing test failures
- Resolve 6 pre-existing test failures
- Simplify database-backup integration tests for remote isolation
- Update database-backup tests for removed directory param
- Update remaining backup test assertions for removed directory param
- Remove directory param from listBackups handler, update tests
- Update integration-infra tests to use backups/ subdirectory
- Update backup tests for path validation security fix
- Wrap execFile manually instead of promisify for spy compatibility
- Use dynamic childProcess.execFile ref so tests can spy on it
- Use vi.mock with importOriginal for child_process in review tests
- Use beforeAll for execFile spy so promisify captures it at load time
- Spy on execFile before module load in adversarial-review tests
- Use vi.mock for child_process in adversarial-review tests
- Add await to async startTask/collectDiff callers across test files
- Add await to all async caller sites in test files
- Update 5 stale test assertions to match current code
- 7 deferred issues — session eviction, log levels, listener cleanup, dedup, docs
- Repair async conversion and DI fix regressions
- 8 security and quality fixes from scout findings
- Add shutdown handling to all agent definitions, fix duplicate brief
- Remove Budget now deletes all budget records, not just sets one to 0
- Allow budget_usd=0 to clear budget limit
- Add Remove Budget button to budget form
- Show all subscription providers in Budget, label progress as API-only
- Activity chart — smooth lines only, Y-axis starts at 0
- V2 timeseries handler now supports interval=hour param
- Resolve Codex sandbox paths in normalizeCommitPath via suffix matching
- Force LF line endings in CLI task environments via GIT_CONFIG env
- Resolve Strategy test mock setup for overview tab assertions
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Changed
- Register task-decomposition in DI container
- Replace decomposition blocks with provider-class-aware logic
- Merge Queue Manager into QC, simplify pipeline to 3 agents
- Centralize sandbox path resolution into shared utility

### Documentation
- Add smart decomposition implementation plan
- Add smart decomposition design spec
- Add documentation scan findings (2026-04-04)
- Add full-project quality scan findings (2026-04-04)
- Add full performance scan findings (2026-04-04)
- Add test coverage scan findings (2026-04-04)
- Add dependency scan findings (2026-04-04)
- Add full security scan findings (2026-04-04)
- Add accessibility scan findings for dashboard
- Add execution module quality scan findings
- Condense CLAUDE.md from 708 to 460 lines (35% reduction)
- Add test infrastructure performance scan findings (7 issues)
- Add runtime performance scan findings (2026-04-04)
- Add code quality scan findings (2026-04-04)
- Add security & reliability scan findings (2026-04-04)
- Add TORQUE agent team implementation plan
- Add TORQUE agent team design spec
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Add integration tests for template + decomposition interaction
- Verify temp file filter excludes tmp/ from auto-commit
- Update Strategy tests for routing overview redesign

### Maintenance
- Add docs/findings/ directory for scout discovery artifacts
- Remove temp debug files from Strategy test investigation
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.18.0] - 2026-04-05

### Added
- Add decomposeTask with provider/model/metadata inheritance
- Add task-decomposition module with provider classes and shouldDecompose
- Sync all agent definitions to repo — repo is source of truth
- Add scout variant definitions to project repo
- Add /torque-scout variant system and codex-primary routing template
- Add /torque-team slash command for one-shot team spawning
- Separate subscription vs API providers in Budget view
- Deprecate v1 API — all dashboard calls now use requestV2
- Swappable activity chart — daily vs hourly toggle
- Hybrid bar+line activity chart with hourly data and smooth curves
- Temp file prevention — auto-commit filter + governance rule
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Update decomposition tests for provider-class-aware thresholds
- Skip 4 governance tests — promisify.custom mock incompatibility
- Use vi.mock for child_process in governance tests
- Apply promisify.custom pattern to governance-integration test
- Set promisify.custom before module load in governance tests
- Restore promisify.custom on governance-hooks test mock
- Lazy promisify in governance hooks for test spy compatibility
- Remaining test caller fixes for batch 2 async conversions
- Update test callers for batch 2 async conversions
- Update handleScanProject tests for lstatSync/realpathSync in walkDir
- Batch 1 — 5 security fixes, 3 critical a11y fixes, 4 doc updates
- 5 code quality fixes in server/execution/
- Hard fail when agent definition files are missing
- Torque-team reads agent definitions from repo first, global fallback
- Add explicit shutdown response format to all agent definitions
- Re-skip close-phases quality test with accurate documentation
- Delete dead test, unskip close-phases, document skip reasons
- Handle async startTask rejections in 2 remaining callers
- Update dashboard convergence test — all endpoints now use requestV2
- Skip 3 flaky routing tests, fix test-container-helper exclude
- Disable all cloud providers in starttask routing tests
- Use setConfig instead of raw db.prepare for routing template clear
- Clear routing template in starttask tests, remove stale free-tier assertion
- Resolve 17 pre-existing test failures
- Resolve 6 pre-existing test failures
- Simplify database-backup integration tests for remote isolation
- Update database-backup tests for removed directory param
- Update remaining backup test assertions for removed directory param
- Remove directory param from listBackups handler, update tests
- Update integration-infra tests to use backups/ subdirectory
- Update backup tests for path validation security fix
- Wrap execFile manually instead of promisify for spy compatibility
- Use dynamic childProcess.execFile ref so tests can spy on it
- Use vi.mock with importOriginal for child_process in review tests
- Use beforeAll for execFile spy so promisify captures it at load time
- Spy on execFile before module load in adversarial-review tests
- Use vi.mock for child_process in adversarial-review tests
- Add await to async startTask/collectDiff callers across test files
- Add await to all async caller sites in test files
- Update 5 stale test assertions to match current code
- 7 deferred issues — session eviction, log levels, listener cleanup, dedup, docs
- Repair async conversion and DI fix regressions
- 8 security and quality fixes from scout findings
- Add shutdown handling to all agent definitions, fix duplicate brief
- Remove Budget now deletes all budget records, not just sets one to 0
- Allow budget_usd=0 to clear budget limit
- Add Remove Budget button to budget form
- Show all subscription providers in Budget, label progress as API-only
- Activity chart — smooth lines only, Y-axis starts at 0
- V2 timeseries handler now supports interval=hour param
- Resolve Codex sandbox paths in normalizeCommitPath via suffix matching
- Force LF line endings in CLI task environments via GIT_CONFIG env
- Resolve Strategy test mock setup for overview tab assertions
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Changed
- Register task-decomposition in DI container
- Replace decomposition blocks with provider-class-aware logic
- Merge Queue Manager into QC, simplify pipeline to 3 agents
- Centralize sandbox path resolution into shared utility

### Documentation
- Add smart decomposition implementation plan
- Add smart decomposition design spec
- Add documentation scan findings (2026-04-04)
- Add full-project quality scan findings (2026-04-04)
- Add full performance scan findings (2026-04-04)
- Add test coverage scan findings (2026-04-04)
- Add dependency scan findings (2026-04-04)
- Add full security scan findings (2026-04-04)
- Add accessibility scan findings for dashboard
- Add execution module quality scan findings
- Condense CLAUDE.md from 708 to 460 lines (35% reduction)
- Add test infrastructure performance scan findings (7 issues)
- Add runtime performance scan findings (2026-04-04)
- Add code quality scan findings (2026-04-04)
- Add security & reliability scan findings (2026-04-04)
- Add TORQUE agent team implementation plan
- Add TORQUE agent team design spec
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Add integration tests for template + decomposition interaction
- Verify temp file filter excludes tmp/ from auto-commit
- Update Strategy tests for routing overview redesign

### Maintenance
- Add docs/findings/ directory for scout discovery artifacts
- Remove temp debug files from Strategy test investigation
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.17.0] - 2026-04-04

### Added
- Sync all agent definitions to repo — repo is source of truth
- Add scout variant definitions to project repo
- Add /torque-scout variant system and codex-primary routing template
- Add /torque-team slash command for one-shot team spawning
- Separate subscription vs API providers in Budget view
- Deprecate v1 API — all dashboard calls now use requestV2
- Swappable activity chart — daily vs hourly toggle
- Hybrid bar+line activity chart with hourly data and smooth curves
- Temp file prevention — auto-commit filter + governance rule
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Update handleScanProject tests for lstatSync/realpathSync in walkDir
- Batch 1 — 5 security fixes, 3 critical a11y fixes, 4 doc updates
- 5 code quality fixes in server/execution/
- Hard fail when agent definition files are missing
- Torque-team reads agent definitions from repo first, global fallback
- Add explicit shutdown response format to all agent definitions
- Re-skip close-phases quality test with accurate documentation
- Delete dead test, unskip close-phases, document skip reasons
- Handle async startTask rejections in 2 remaining callers
- Update dashboard convergence test — all endpoints now use requestV2
- Skip 3 flaky routing tests, fix test-container-helper exclude
- Disable all cloud providers in starttask routing tests
- Use setConfig instead of raw db.prepare for routing template clear
- Clear routing template in starttask tests, remove stale free-tier assertion
- Resolve 17 pre-existing test failures
- Resolve 6 pre-existing test failures
- Simplify database-backup integration tests for remote isolation
- Update database-backup tests for removed directory param
- Update remaining backup test assertions for removed directory param
- Remove directory param from listBackups handler, update tests
- Update integration-infra tests to use backups/ subdirectory
- Update backup tests for path validation security fix
- Wrap execFile manually instead of promisify for spy compatibility
- Use dynamic childProcess.execFile ref so tests can spy on it
- Use vi.mock with importOriginal for child_process in review tests
- Use beforeAll for execFile spy so promisify captures it at load time
- Spy on execFile before module load in adversarial-review tests
- Use vi.mock for child_process in adversarial-review tests
- Add await to async startTask/collectDiff callers across test files
- Add await to all async caller sites in test files
- Update 5 stale test assertions to match current code
- 7 deferred issues — session eviction, log levels, listener cleanup, dedup, docs
- Repair async conversion and DI fix regressions
- 8 security and quality fixes from scout findings
- Add shutdown handling to all agent definitions, fix duplicate brief
- Remove Budget now deletes all budget records, not just sets one to 0
- Allow budget_usd=0 to clear budget limit
- Add Remove Budget button to budget form
- Show all subscription providers in Budget, label progress as API-only
- Activity chart — smooth lines only, Y-axis starts at 0
- V2 timeseries handler now supports interval=hour param
- Resolve Codex sandbox paths in normalizeCommitPath via suffix matching
- Force LF line endings in CLI task environments via GIT_CONFIG env
- Resolve Strategy test mock setup for overview tab assertions
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Changed
- Merge Queue Manager into QC, simplify pipeline to 3 agents
- Centralize sandbox path resolution into shared utility

### Documentation
- Add documentation scan findings (2026-04-04)
- Add full-project quality scan findings (2026-04-04)
- Add full performance scan findings (2026-04-04)
- Add test coverage scan findings (2026-04-04)
- Add dependency scan findings (2026-04-04)
- Add full security scan findings (2026-04-04)
- Add accessibility scan findings for dashboard
- Add execution module quality scan findings
- Condense CLAUDE.md from 708 to 460 lines (35% reduction)
- Add test infrastructure performance scan findings (7 issues)
- Add runtime performance scan findings (2026-04-04)
- Add code quality scan findings (2026-04-04)
- Add security & reliability scan findings (2026-04-04)
- Add TORQUE agent team implementation plan
- Add TORQUE agent team design spec
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Verify temp file filter excludes tmp/ from auto-commit
- Update Strategy tests for routing overview redesign

### Maintenance
- Add docs/findings/ directory for scout discovery artifacts
- Remove temp debug files from Strategy test investigation
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.16.0] - 2026-04-04

### Added
- Sync all agent definitions to repo — repo is source of truth
- Add scout variant definitions to project repo
- Add /torque-scout variant system and codex-primary routing template
- Add /torque-team slash command for one-shot team spawning
- Separate subscription vs API providers in Budget view
- Deprecate v1 API — all dashboard calls now use requestV2
- Swappable activity chart — daily vs hourly toggle
- Hybrid bar+line activity chart with hourly data and smooth curves
- Temp file prevention — auto-commit filter + governance rule
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- 5 code quality fixes in server/execution/
- Hard fail when agent definition files are missing
- Torque-team reads agent definitions from repo first, global fallback
- Add explicit shutdown response format to all agent definitions
- Re-skip close-phases quality test with accurate documentation
- Delete dead test, unskip close-phases, document skip reasons
- Handle async startTask rejections in 2 remaining callers
- Update dashboard convergence test — all endpoints now use requestV2
- Skip 3 flaky routing tests, fix test-container-helper exclude
- Disable all cloud providers in starttask routing tests
- Use setConfig instead of raw db.prepare for routing template clear
- Clear routing template in starttask tests, remove stale free-tier assertion
- Resolve 17 pre-existing test failures
- Resolve 6 pre-existing test failures
- Simplify database-backup integration tests for remote isolation
- Update database-backup tests for removed directory param
- Update remaining backup test assertions for removed directory param
- Remove directory param from listBackups handler, update tests
- Update integration-infra tests to use backups/ subdirectory
- Update backup tests for path validation security fix
- Wrap execFile manually instead of promisify for spy compatibility
- Use dynamic childProcess.execFile ref so tests can spy on it
- Use vi.mock with importOriginal for child_process in review tests
- Use beforeAll for execFile spy so promisify captures it at load time
- Spy on execFile before module load in adversarial-review tests
- Use vi.mock for child_process in adversarial-review tests
- Add await to async startTask/collectDiff callers across test files
- Add await to all async caller sites in test files
- Update 5 stale test assertions to match current code
- 7 deferred issues — session eviction, log levels, listener cleanup, dedup, docs
- Repair async conversion and DI fix regressions
- 8 security and quality fixes from scout findings
- Add shutdown handling to all agent definitions, fix duplicate brief
- Remove Budget now deletes all budget records, not just sets one to 0
- Allow budget_usd=0 to clear budget limit
- Add Remove Budget button to budget form
- Show all subscription providers in Budget, label progress as API-only
- Activity chart — smooth lines only, Y-axis starts at 0
- V2 timeseries handler now supports interval=hour param
- Resolve Codex sandbox paths in normalizeCommitPath via suffix matching
- Force LF line endings in CLI task environments via GIT_CONFIG env
- Resolve Strategy test mock setup for overview tab assertions
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Changed
- Merge Queue Manager into QC, simplify pipeline to 3 agents
- Centralize sandbox path resolution into shared utility

### Documentation
- Add documentation scan findings (2026-04-04)
- Add full-project quality scan findings (2026-04-04)
- Add full performance scan findings (2026-04-04)
- Add test coverage scan findings (2026-04-04)
- Add dependency scan findings (2026-04-04)
- Add full security scan findings (2026-04-04)
- Add accessibility scan findings for dashboard
- Add execution module quality scan findings
- Condense CLAUDE.md from 708 to 460 lines (35% reduction)
- Add test infrastructure performance scan findings (7 issues)
- Add runtime performance scan findings (2026-04-04)
- Add code quality scan findings (2026-04-04)
- Add security & reliability scan findings (2026-04-04)
- Add TORQUE agent team implementation plan
- Add TORQUE agent team design spec
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Verify temp file filter excludes tmp/ from auto-commit
- Update Strategy tests for routing overview redesign

### Maintenance
- Add docs/findings/ directory for scout discovery artifacts
- Remove temp debug files from Strategy test investigation
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.15.0] - 2026-04-04

### Added
- Sync all agent definitions to repo — repo is source of truth
- Add scout variant definitions to project repo
- Add /torque-scout variant system and codex-primary routing template
- Add /torque-team slash command for one-shot team spawning
- Separate subscription vs API providers in Budget view
- Deprecate v1 API — all dashboard calls now use requestV2
- Swappable activity chart — daily vs hourly toggle
- Hybrid bar+line activity chart with hourly data and smooth curves
- Temp file prevention — auto-commit filter + governance rule
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Hard fail when agent definition files are missing
- Torque-team reads agent definitions from repo first, global fallback
- Add explicit shutdown response format to all agent definitions
- Re-skip close-phases quality test with accurate documentation
- Delete dead test, unskip close-phases, document skip reasons
- Handle async startTask rejections in 2 remaining callers
- Update dashboard convergence test — all endpoints now use requestV2
- Skip 3 flaky routing tests, fix test-container-helper exclude
- Disable all cloud providers in starttask routing tests
- Use setConfig instead of raw db.prepare for routing template clear
- Clear routing template in starttask tests, remove stale free-tier assertion
- Resolve 17 pre-existing test failures
- Resolve 6 pre-existing test failures
- Simplify database-backup integration tests for remote isolation
- Update database-backup tests for removed directory param
- Update remaining backup test assertions for removed directory param
- Remove directory param from listBackups handler, update tests
- Update integration-infra tests to use backups/ subdirectory
- Update backup tests for path validation security fix
- Wrap execFile manually instead of promisify for spy compatibility
- Use dynamic childProcess.execFile ref so tests can spy on it
- Use vi.mock with importOriginal for child_process in review tests
- Use beforeAll for execFile spy so promisify captures it at load time
- Spy on execFile before module load in adversarial-review tests
- Use vi.mock for child_process in adversarial-review tests
- Add await to async startTask/collectDiff callers across test files
- Add await to all async caller sites in test files
- Update 5 stale test assertions to match current code
- 7 deferred issues — session eviction, log levels, listener cleanup, dedup, docs
- Repair async conversion and DI fix regressions
- 8 security and quality fixes from scout findings
- Add shutdown handling to all agent definitions, fix duplicate brief
- Remove Budget now deletes all budget records, not just sets one to 0
- Allow budget_usd=0 to clear budget limit
- Add Remove Budget button to budget form
- Show all subscription providers in Budget, label progress as API-only
- Activity chart — smooth lines only, Y-axis starts at 0
- V2 timeseries handler now supports interval=hour param
- Resolve Codex sandbox paths in normalizeCommitPath via suffix matching
- Force LF line endings in CLI task environments via GIT_CONFIG env
- Resolve Strategy test mock setup for overview tab assertions
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Changed
- Merge Queue Manager into QC, simplify pipeline to 3 agents
- Centralize sandbox path resolution into shared utility

### Documentation
- Add execution module quality scan findings
- Condense CLAUDE.md from 708 to 460 lines (35% reduction)
- Add test infrastructure performance scan findings (7 issues)
- Add runtime performance scan findings (2026-04-04)
- Add code quality scan findings (2026-04-04)
- Add security & reliability scan findings (2026-04-04)
- Add TORQUE agent team implementation plan
- Add TORQUE agent team design spec
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Verify temp file filter excludes tmp/ from auto-commit
- Update Strategy tests for routing overview redesign

### Maintenance
- Add docs/findings/ directory for scout discovery artifacts
- Remove temp debug files from Strategy test investigation
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.14.0] - 2026-04-04

### Added
- Add scout variant definitions to project repo
- Add /torque-scout variant system and codex-primary routing template
- Add /torque-team slash command for one-shot team spawning
- Separate subscription vs API providers in Budget view
- Deprecate v1 API — all dashboard calls now use requestV2
- Swappable activity chart — daily vs hourly toggle
- Hybrid bar+line activity chart with hourly data and smooth curves
- Temp file prevention — auto-commit filter + governance rule
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Re-skip close-phases quality test with accurate documentation
- Delete dead test, unskip close-phases, document skip reasons
- Handle async startTask rejections in 2 remaining callers
- Update dashboard convergence test — all endpoints now use requestV2
- Skip 3 flaky routing tests, fix test-container-helper exclude
- Disable all cloud providers in starttask routing tests
- Use setConfig instead of raw db.prepare for routing template clear
- Clear routing template in starttask tests, remove stale free-tier assertion
- Resolve 17 pre-existing test failures
- Resolve 6 pre-existing test failures
- Simplify database-backup integration tests for remote isolation
- Update database-backup tests for removed directory param
- Update remaining backup test assertions for removed directory param
- Remove directory param from listBackups handler, update tests
- Update integration-infra tests to use backups/ subdirectory
- Update backup tests for path validation security fix
- Wrap execFile manually instead of promisify for spy compatibility
- Use dynamic childProcess.execFile ref so tests can spy on it
- Use vi.mock with importOriginal for child_process in review tests
- Use beforeAll for execFile spy so promisify captures it at load time
- Spy on execFile before module load in adversarial-review tests
- Use vi.mock for child_process in adversarial-review tests
- Add await to async startTask/collectDiff callers across test files
- Add await to all async caller sites in test files
- Update 5 stale test assertions to match current code
- 7 deferred issues — session eviction, log levels, listener cleanup, dedup, docs
- Repair async conversion and DI fix regressions
- 8 security and quality fixes from scout findings
- Add shutdown handling to all agent definitions, fix duplicate brief
- Remove Budget now deletes all budget records, not just sets one to 0
- Allow budget_usd=0 to clear budget limit
- Add Remove Budget button to budget form
- Show all subscription providers in Budget, label progress as API-only
- Activity chart — smooth lines only, Y-axis starts at 0
- V2 timeseries handler now supports interval=hour param
- Resolve Codex sandbox paths in normalizeCommitPath via suffix matching
- Force LF line endings in CLI task environments via GIT_CONFIG env
- Resolve Strategy test mock setup for overview tab assertions
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Changed
- Merge Queue Manager into QC, simplify pipeline to 3 agents
- Centralize sandbox path resolution into shared utility

### Documentation
- Add test infrastructure performance scan findings (7 issues)
- Add runtime performance scan findings (2026-04-04)
- Add code quality scan findings (2026-04-04)
- Add security & reliability scan findings (2026-04-04)
- Add TORQUE agent team implementation plan
- Add TORQUE agent team design spec
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Verify temp file filter excludes tmp/ from auto-commit
- Update Strategy tests for routing overview redesign

### Maintenance
- Add docs/findings/ directory for scout discovery artifacts
- Remove temp debug files from Strategy test investigation
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.13.0] - 2026-04-04

### Added
- Add scout variant definitions to project repo
- Add /torque-scout variant system and codex-primary routing template
- Add /torque-team slash command for one-shot team spawning
- Separate subscription vs API providers in Budget view
- Deprecate v1 API — all dashboard calls now use requestV2
- Swappable activity chart — daily vs hourly toggle
- Hybrid bar+line activity chart with hourly data and smooth curves
- Temp file prevention — auto-commit filter + governance rule
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Resolve 6 pre-existing test failures
- Simplify database-backup integration tests for remote isolation
- Update database-backup tests for removed directory param
- Update remaining backup test assertions for removed directory param
- Remove directory param from listBackups handler, update tests
- Update integration-infra tests to use backups/ subdirectory
- Update backup tests for path validation security fix
- Wrap execFile manually instead of promisify for spy compatibility
- Use dynamic childProcess.execFile ref so tests can spy on it
- Use vi.mock with importOriginal for child_process in review tests
- Use beforeAll for execFile spy so promisify captures it at load time
- Spy on execFile before module load in adversarial-review tests
- Use vi.mock for child_process in adversarial-review tests
- Add await to async startTask/collectDiff callers across test files
- Add await to all async caller sites in test files
- Update 5 stale test assertions to match current code
- 7 deferred issues — session eviction, log levels, listener cleanup, dedup, docs
- Repair async conversion and DI fix regressions
- 8 security and quality fixes from scout findings
- Add shutdown handling to all agent definitions, fix duplicate brief
- Remove Budget now deletes all budget records, not just sets one to 0
- Allow budget_usd=0 to clear budget limit
- Add Remove Budget button to budget form
- Show all subscription providers in Budget, label progress as API-only
- Activity chart — smooth lines only, Y-axis starts at 0
- V2 timeseries handler now supports interval=hour param
- Resolve Codex sandbox paths in normalizeCommitPath via suffix matching
- Force LF line endings in CLI task environments via GIT_CONFIG env
- Resolve Strategy test mock setup for overview tab assertions
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Changed
- Merge Queue Manager into QC, simplify pipeline to 3 agents
- Centralize sandbox path resolution into shared utility

### Documentation
- Add test infrastructure performance scan findings (7 issues)
- Add runtime performance scan findings (2026-04-04)
- Add code quality scan findings (2026-04-04)
- Add security & reliability scan findings (2026-04-04)
- Add TORQUE agent team implementation plan
- Add TORQUE agent team design spec
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Verify temp file filter excludes tmp/ from auto-commit
- Update Strategy tests for routing overview redesign

### Maintenance
- Add docs/findings/ directory for scout discovery artifacts
- Remove temp debug files from Strategy test investigation
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.12.0] - 2026-04-04

### Added
- Add scout variant definitions to project repo
- Add /torque-scout variant system and codex-primary routing template
- Add /torque-team slash command for one-shot team spawning
- Separate subscription vs API providers in Budget view
- Deprecate v1 API — all dashboard calls now use requestV2
- Swappable activity chart — daily vs hourly toggle
- Hybrid bar+line activity chart with hourly data and smooth curves
- Temp file prevention — auto-commit filter + governance rule
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Simplify database-backup integration tests for remote isolation
- Update database-backup tests for removed directory param
- Update remaining backup test assertions for removed directory param
- Remove directory param from listBackups handler, update tests
- Update integration-infra tests to use backups/ subdirectory
- Update backup tests for path validation security fix
- Wrap execFile manually instead of promisify for spy compatibility
- Use dynamic childProcess.execFile ref so tests can spy on it
- Use vi.mock with importOriginal for child_process in review tests
- Use beforeAll for execFile spy so promisify captures it at load time
- Spy on execFile before module load in adversarial-review tests
- Use vi.mock for child_process in adversarial-review tests
- Add await to async startTask/collectDiff callers across test files
- Add await to all async caller sites in test files
- Update 5 stale test assertions to match current code
- 7 deferred issues — session eviction, log levels, listener cleanup, dedup, docs
- Repair async conversion and DI fix regressions
- 8 security and quality fixes from scout findings
- Add shutdown handling to all agent definitions, fix duplicate brief
- Remove Budget now deletes all budget records, not just sets one to 0
- Allow budget_usd=0 to clear budget limit
- Add Remove Budget button to budget form
- Show all subscription providers in Budget, label progress as API-only
- Activity chart — smooth lines only, Y-axis starts at 0
- V2 timeseries handler now supports interval=hour param
- Resolve Codex sandbox paths in normalizeCommitPath via suffix matching
- Force LF line endings in CLI task environments via GIT_CONFIG env
- Resolve Strategy test mock setup for overview tab assertions
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Changed
- Merge Queue Manager into QC, simplify pipeline to 3 agents
- Centralize sandbox path resolution into shared utility

### Documentation
- Add test infrastructure performance scan findings (7 issues)
- Add runtime performance scan findings (2026-04-04)
- Add code quality scan findings (2026-04-04)
- Add security & reliability scan findings (2026-04-04)
- Add TORQUE agent team implementation plan
- Add TORQUE agent team design spec
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Verify temp file filter excludes tmp/ from auto-commit
- Update Strategy tests for routing overview redesign

### Maintenance
- Add docs/findings/ directory for scout discovery artifacts
- Remove temp debug files from Strategy test investigation
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.11.0] - 2026-04-04

### Added
- Add scout variant definitions to project repo
- Add /torque-scout variant system and codex-primary routing template
- Add /torque-team slash command for one-shot team spawning
- Separate subscription vs API providers in Budget view
- Deprecate v1 API — all dashboard calls now use requestV2
- Swappable activity chart — daily vs hourly toggle
- Hybrid bar+line activity chart with hourly data and smooth curves
- Temp file prevention — auto-commit filter + governance rule
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Repair async conversion and DI fix regressions
- 8 security and quality fixes from scout findings
- Add shutdown handling to all agent definitions, fix duplicate brief
- Remove Budget now deletes all budget records, not just sets one to 0
- Allow budget_usd=0 to clear budget limit
- Add Remove Budget button to budget form
- Show all subscription providers in Budget, label progress as API-only
- Activity chart — smooth lines only, Y-axis starts at 0
- V2 timeseries handler now supports interval=hour param
- Resolve Codex sandbox paths in normalizeCommitPath via suffix matching
- Force LF line endings in CLI task environments via GIT_CONFIG env
- Resolve Strategy test mock setup for overview tab assertions
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Changed
- Centralize sandbox path resolution into shared utility

### Documentation
- Add code quality scan findings (2026-04-04)
- Add security & reliability scan findings (2026-04-04)
- Add TORQUE agent team implementation plan
- Add TORQUE agent team design spec
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Verify temp file filter excludes tmp/ from auto-commit
- Update Strategy tests for routing overview redesign

### Maintenance
- Add docs/findings/ directory for scout discovery artifacts
- Remove temp debug files from Strategy test investigation
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.10.0] - 2026-04-04

### Added
- Separate subscription vs API providers in Budget view
- Deprecate v1 API — all dashboard calls now use requestV2
- Swappable activity chart — daily vs hourly toggle
- Hybrid bar+line activity chart with hourly data and smooth curves
- Temp file prevention — auto-commit filter + governance rule
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Remove Budget now deletes all budget records, not just sets one to 0
- Allow budget_usd=0 to clear budget limit
- Add Remove Budget button to budget form
- Show all subscription providers in Budget, label progress as API-only
- Activity chart — smooth lines only, Y-axis starts at 0
- V2 timeseries handler now supports interval=hour param
- Resolve Codex sandbox paths in normalizeCommitPath via suffix matching
- Force LF line endings in CLI task environments via GIT_CONFIG env
- Resolve Strategy test mock setup for overview tab assertions
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Changed
- Centralize sandbox path resolution into shared utility

### Documentation
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Verify temp file filter excludes tmp/ from auto-commit
- Update Strategy tests for routing overview redesign

### Maintenance
- Remove temp debug files from Strategy test investigation
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.9.0] - 2026-04-03

### Added
- Deprecate v1 API — all dashboard calls now use requestV2
- Swappable activity chart — daily vs hourly toggle
- Hybrid bar+line activity chart with hourly data and smooth curves
- Temp file prevention — auto-commit filter + governance rule
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Activity chart — smooth lines only, Y-axis starts at 0
- V2 timeseries handler now supports interval=hour param
- Resolve Codex sandbox paths in normalizeCommitPath via suffix matching
- Force LF line endings in CLI task environments via GIT_CONFIG env
- Resolve Strategy test mock setup for overview tab assertions
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Changed
- Centralize sandbox path resolution into shared utility

### Documentation
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Verify temp file filter excludes tmp/ from auto-commit
- Update Strategy tests for routing overview redesign

### Maintenance
- Remove temp debug files from Strategy test investigation
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.8.0] - 2026-04-03

### Added
- Swappable activity chart — daily vs hourly toggle
- Hybrid bar+line activity chart with hourly data and smooth curves
- Temp file prevention — auto-commit filter + governance rule
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Activity chart — smooth lines only, Y-axis starts at 0
- V2 timeseries handler now supports interval=hour param
- Resolve Codex sandbox paths in normalizeCommitPath via suffix matching
- Force LF line endings in CLI task environments via GIT_CONFIG env
- Resolve Strategy test mock setup for overview tab assertions
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Changed
- Centralize sandbox path resolution into shared utility

### Documentation
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Verify temp file filter excludes tmp/ from auto-commit
- Update Strategy tests for routing overview redesign

### Maintenance
- Remove temp debug files from Strategy test investigation
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.7.0] - 2026-04-03

### Added
- Temp file prevention — auto-commit filter + governance rule
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Force LF line endings in CLI task environments via GIT_CONFIG env
- Resolve Strategy test mock setup for overview tab assertions
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Documentation
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Update Strategy tests for routing overview redesign

### Maintenance
- Remove temp debug files from Strategy test investigation
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.6.0] - 2026-04-03

### Added
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Resolve Strategy test mock setup for overview tab assertions
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Documentation
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Update Strategy tests for routing overview redesign

### Maintenance
- Remove temp debug files from Strategy test investigation
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.5.0] - 2026-04-03

### Added
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Use resetAllMocks to clear leaked mock implementations between tests
- Use clearAllMocks instead of restoreAllMocks in Strategy tests
- Set root in dashboard config to prevent CWD-dependent resolution
- Add explicit include pattern to dashboard config
- Scope test runner configs to prevent cross-suite leaking
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Documentation
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Testing
- Update Strategy tests for routing overview redesign

### Maintenance
- Rebuild dashboard dist with strategy overview redesign
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.4.0] - 2026-04-03

### Added
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- 8 UI/data issues in Strategy routing overview page
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Documentation
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Maintenance
- Rebuild dashboard dist
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.3.0] - 2026-04-03

### Added
- Replace dagre with inline DAG layout, eliminate lodash vulnerabilities
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Override lodash to 4.18.1 to resolve 2 Dependabot vulnerabilities
- Add unmount guards to 6 async state-write race conditions in dashboard
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Documentation
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Maintenance
- Rebuild dashboard dist with latest source
- Add module comment to charts index

## [1.2.0] - 2026-04-03

### Added
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Guard queue TTL expiry query with try/catch
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Documentation
- Recharts replacement plan — 402KB library to ~5KB SVG components

### Maintenance
- Add module comment to charts index

## [1.1.0] - 2026-04-02

### Added
- Replace recharts with lightweight SVG chart components
- Schedule enforcement, direct commit tracking, CLAUDE.md versioning docs

### Fixed
- Resolve versioned project paths with normalization and basename fallback
- Add data-testid to Strategy decision rows for sort order verification
- Migrate 3 remaining request() calls to requestV2() in dashboard api
- Filter GCM credential warnings from torque-remote sync output
- Registry-null tests expect 404 (agent lookup fails before registry check)
- Restore deleted it() wrapper in handleDeleteAgent registry test
- Registry cache tests — mock getDbInstance to return null directly
- Resolve remaining 9 test failures
- Frontend lint cleanup, server bug fixes, and remaining test updates
- Update 9 schedule API test expectations to match object-based createCronScheduledTask signature
- Update backup test mock filenames to match ISO timestamp pattern
- Update 5 test expectations to match current source behavior
- Update dashboard tests for recharts→SVG chart migration
- Use ERE instead of PCRE for binary extension check in PII hook
- Re-fetch server state on failed optimistic save instead of stale revert
- Link release commit back to triggering task/workflow

### Documentation
- Recharts replacement plan — 402KB library to ~5KB SVG components

## [1.0.0] - 2026-04-01

### Testing
- Verify version control dashboard tracking

All notable changes to TORQUE are documented here. This project follows Semantic Versioning.

## [2.1.0] - 2026-01-27

### Added

- **Test Suite Expansion**
  - Provider tests: Ollama, Claude CLI, Anthropic API, Groq
  - Safeguard tests: validation rules, baseline detection, build checks
  - Git operations tests: baselines, rollback, pre-commit hooks
  - Provider routing tests: keyword analysis, complexity scoring
  - Platform tests: Windows PowerShell, WSL2, macOS, Linux
  - Discovery tests: Ollama LAN discovery via mDNS

- **CI/CD Pipeline**
  - GitHub Actions workflow for automated testing
  - Tests run on Node 18 and Node 22
  - Test matrix: Ubuntu, Windows (PowerShell)
  - Coverage tracking and reporting
  - Artifact uploads for test results

- **Documentation (Phase 6)**
  - Windows setup guide: prerequisites, installation, WSL considerations, Ollama
  - Troubleshooting guide: common issues, port conflicts, provider problems, database issues
  - Architecture documentation: component diagram, data flow, provider routing, quality pipeline
  - CHANGELOG: version history and changes tracking

- **REST API Server**
  - New HTTP server on port 3457 (separate from MCP stdio)
  - Endpoints: `/api/tasks`, `/api/status`, `/api/config`, `/api/workflows`
  - JSON request/response format
  - CORS headers for external tool integration
  - Swagger documentation generation

- **Provider Abstraction Layer**
  - Anthropic API provider: direct SDK calls, token tracking, rate limit handling
  - Groq provider: alternative cloud backend
  - Provider registry pattern for extensibility
  - Unified execute() interface across all providers

- **Logging & Observability**
  - Structured JSON logging (Winston)
  - Log rotation: max 5 files, 10MB each
  - Log levels: debug, info, warn, error
  - Console output in development, file-based in production
  - Performance metrics per provider (avg response time, success rate)

- **Dashboard Improvements**
  - Static lightweight fallback dashboard (no build required)
  - Served as HTML from server/public/dashboard.html
  - WebSocket connection with automatic reconnect
  - Real-time task status updates
  - Provider health indicators
  - Cost tracking visualization

### Changed

- **Database Schema Updates**
  - Added `priority_boost` column to tasks table for priority adjustment
  - Added `review_status` column: pending, approved, needs_correction
  - Added `complexity_score` column for routing decisions
  - Added `provider_selected` column to log which provider executed task
  - Index optimizations for faster queries

- **Provider Routing**
  - More sophisticated complexity scoring (0-10 scale)
  - Multi-factor analysis: keywords + file extensions + file count
  - Configurable routing rules with priority
  - Default routes: XAML/WPF always to cloud (better semantic understanding)
  - Cost tracking per task (input tokens, output tokens, USD cost)

- **Error Handling**
  - Graceful degradation when providers fail
  - Automatic fallback to alternative provider
  - Better error messages with actionable suggestions
  - Timeout handling for hung providers
  - Provider health checks every 30 seconds

- **Dashboard Server**
  - Updated to serve static fallback dashboard
  - Fallback activated if build fails or main dashboard unavailable
  - Minimal dependencies: no Next.js, no build step required

### Fixed

- **Windows PowerShell Compatibility**
  - Pre-commit hooks generate .ps1 PowerShell scripts on Windows
  - Shell wrapper shims for bash compatibility
  - Path separator handling (backslash vs forward slash)
  - Long path support (>260 characters) with registry fix

- **Stuck Task Handling**
  - Auto-cleanup for tasks stuck in "running" state
  - Grace period: 5 minutes before force cleanup
  - Force cleanup on Windows (ungraceful termination)
  - Better detection of zombie processes

- **Task Cancellation on Windows**
  - Fixed issue where cancel_task didn't work on Windows
  - Now properly kills child processes
  - Force-kills after timeout (2 seconds)

- **WSL2 Compatibility**
  - 30-second timeout for git operations in WSL2 (due to file system latency)
  - Auto-detection of WSL2 environment
  - Warning when using slow file system (mapped /mnt/c/)
  - Recommendation to use native Windows Node.js

- **Database Locking Issues**
  - Single-server enforcement (only one instance at a time)
  - Better lock timeout handling
  - Cleanup of stale lock files on startup

### Deprecated

- Codex provider: deprecated in favor of Anthropic API and Groq
  - Still functional for backward compatibility
  - Will be removed in v3.0.0

### Security

- Environment variable validation for API keys
- No sensitive data logged (API keys, credentials)
- Audit trail of all operations (audit_log table)
- CORS configuration for API server
- Input validation and sanitization for all parameters

## [2.0.0] - 2026-01-20

### Added

- **Smart Task Routing**
  - Automatic provider selection based on task complexity
  - Local LLM (Ollama) for simple tasks (free, no rate limits)
  - Cloud providers for complex tasks (better quality)
  - Configurable routing rules with priorities
  - Cost tracking and ROI analysis

- **Multi-Host Ollama Support**
  - Load balancing across multiple Ollama instances
  - Host capacity tracking (CPU, memory, GPU)
  - Automatic failover to secondary hosts
  - Host health monitoring and recovery
  - LAN discovery via mDNS

- **Quality Safeguards**
  - Baseline capture before task execution
  - Output validation (stub detection, empty files, truncation)
  - Approval gates for suspicious results
  - Build verification (compile check)
  - Automatic rollback on failure

- **Dashboard**
  - Real-time task monitoring
  - WebSocket updates for live status
  - Provider health indicators
  - Cost tracking by provider and project
  - Workflow visualization (DAG display)

- **Workflow/DAG Support**
  - Define task dependencies as directed acyclic graphs
  - Conditional execution (success, failure, always)
  - Parallel task execution
  - Workflow templates for reusable patterns
  - Critical path analysis

- **Provider Management**
  - Anthropic API integration (Claude 3 models)
  - Groq provider for faster inference
  - Claude CLI wrapper (subprocess execution)
  - Codex API (legacy)
  - Provider performance metrics and cost tracking

- **Adaptive Retry**
  - Automatic retry with alternative provider
  - Exponential backoff strategy
  - Configurable retry limits
  - Retry patterns learned from failures

- **Windows/PowerShell Compatibility**
  - Pre-commit hooks as PowerShell scripts
  - Shell wrappers for cross-platform compatibility
  - Path handling for Windows file systems
  - Environment variable support

- **Orphan Mode**
  - Server continues running if MCP connection drops
  - In-flight tasks complete before shutdown
  - Grace period for task completion
  - Auto-exit after grace period expires

### Changed

- Complete rewrite of provider abstraction
- Database schema redesigned (v2 format)
- Tool handlers refactored for clarity
- Quality checks integrated into task lifecycle
- Routing logic moved to centralized decision engine

### Fixed

- Task state persistence across server restarts
- Provider timeout handling
- Database transaction safety
- Memory leaks in long-running servers
- File path normalization

## [1.0.0] - 2026-01-01

### Added

- **Initial Release**
  - MCP server with stdio interface
  - Task delegation to Codex CLI
  - SQLite persistence for task state
  - Task queuing with priority levels
  - Progress tracking and status monitoring
  - Basic error handling and logging
  - Command-line interface via MCP tools

- **Core Features**
  - Task submission and execution
  - Queue management (FIFO with priorities)
  - Task status tracking (queued, running, completed, failed)
  - Result storage and retrieval
  - Simple provider abstraction
  - Database initialization and schema creation

- **Basic Configuration**
  - Environment variable support
  - SQLite database path configuration
  - Server port configuration
  - Task timeout configuration
  - Provider selection (Codex only)

## Version Numbering

TORQUE follows Semantic Versioning (MAJOR.MINOR.PATCH):

- **MAJOR**: Breaking changes to API or data format
- **MINOR**: New features, backward compatible
- **PATCH**: Bug fixes, performance improvements

## Release Schedule

- Regular releases on the 20th of each month
- Hotfixes released as needed for critical issues
- Long-term support (LTS) versions designated annually

## Migration Guides

### Upgrading from 1.x to 2.x

- Database schema v1 → v2 (auto-migration on first run)
- Provider configuration changed (see docs/architecture.md)
- Routing rules must be reconfigured for 2.x (see CLAUDE.md)

### Upgrading from 2.0 to 2.1

- No breaking changes
- Optional: enable new providers (Anthropic API, Groq)
- Optional: configure new routing rules

## Known Issues

- WSL2 file system latency causes slow git operations (workaround: use native Windows Node.js)
- Ollama GPU support limited on older hardware (fallback: use CPU mode)
- Large task outputs (>10MB) may exceed memory limits (workaround: split into smaller tasks)

## Future Plans (v2.2+)

- Distributed task execution across multiple servers
- Machine learning-based provider selection
- Advanced workflow scheduling and optimization
- Enhanced dashboard with custom visualizations
- Integration with external version control systems
- Task result caching and deduplication
- Real-time collaborative task editing
