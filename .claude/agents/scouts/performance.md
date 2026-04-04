# Variant: Performance

## Focus Area

Find performance bottlenecks and resource efficiency issues.

## What to Look For

- **Synchronous I/O on the event loop** — `readFileSync`, `writeFileSync`, `execSync`, `execFileSync` in request handlers or hot paths
- **N+1 query patterns** — loops that execute a DB query per iteration instead of batching
- **Missing database indexes** — queries filtering/sorting on columns without indexes (check CREATE TABLE and CREATE INDEX statements)
- **Unbounded loops** — loops without size limits processing user-controlled collections
- **Memory leaks** — event listeners added in request handlers without removal, growing Maps/Sets without eviction, closures capturing large objects
- **Blocking the event loop** — CPU-intensive operations (JSON.parse on large payloads, regex on long strings, crypto) without worker threads
- **Unnecessary work** — redundant DB queries, re-reading files already in memory, duplicate computations
- **Missing caching** — expensive operations repeated on every call with no memoization
- **Large payload handling** — endpoints that load entire result sets into memory instead of streaming
- **Timer/interval leaks** — setInterval without clearInterval, setTimeout without .unref() blocking shutdown

## Search Patterns

Look for: `Sync(` in non-startup code, `for.*await.*db` (N+1), `setInterval` without corresponding `clearInterval`, `JSON.parse` on request bodies without size limits.

## Severity Guide

- CRITICAL: Event loop blocked for >1s in request path, memory leak under normal usage
- HIGH: Sync I/O in hot path, N+1 query, unbounded collection processing
- MEDIUM: Missing cache for expensive operation, timer leak, redundant work
- LOW: Suboptimal but not impactful under current load
