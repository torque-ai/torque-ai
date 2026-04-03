# Changelog

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
