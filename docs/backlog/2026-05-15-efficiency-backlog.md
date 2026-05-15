# Efficiency backlog — 2026-05-15

Findings from a one-shot audit looking for runtime waste in the request/queue/maintenance hot paths. The primary "scary" item gets its own section; the rest are smaller things noticed along the way so they don't get lost.

Audited against main @ `e6dc571d` (`refactor(factory): Phase 2c-adapt slice 1 — SENSE stage runner`).

Each entry: **what**, **where**, **fix sketch**, **confidence**.

---

## #0 (HEADLINE) Sync FS import-graph walk on every context-stuffed `smart_submit`

**What.** Every smart-submit whose chosen provider is in `CONTEXT_STUFFING_PROVIDERS` (groq, cerebras, google-ai, openrouter, ollama-cloud) walks the project's import graph with synchronous `fs.readFileSync` + `fs.statSync` on the MCP request thread. The handler file ships an explicit `eslint-disable torque/no-sync-fs-on-hot-paths -- routing handler sync calls are in project file detection paths run at submission time; Phase 2 async conversion tracked separately`, so the codebase already knows.

**Where.**
- `server/handlers/integration/routing.js` (top-of-file eslint-disable; calls `resolveContextFiles()`)
- `server/utils/smart-scan.js`
  - `:128` `fs.readFileSync` inside `parseImports()` — runs per frontier file
  - `:296` `fs.statSync` inside `addFile()` — runs per discovered import
  - `:72–94` `resolveImportPath()` probes up to **12 candidates per unresolved specifier** (6 extensions, then 6 `index.<ext>`)
  - `:342–345` Phase 3 re-walks every discovered file for convention matches (more stats per file)

**How often.** Per smart-submit call to a context-stuffing provider. On the default routing template that's the common path.

**Why it's scary.** At `contextDepth=1` on a hub module that imports ~40 siblings: 300+ stat calls and 40 file reads on the request thread. Windows Defender / Search Indexer intercept `statSync` and add ~1–5 ms each, so a single submission can stall the event loop ~0.5–1.5 s — during which the 5 s queue poll, SSE keepalives, every other MCP request, and `restart_server`'s barrier checks all wait. There's no caching, no timeout, no async yield, and no memoization across submissions for the same repo.

**Fix sketch.**
1. Convert to `fs.promises` with bounded concurrency. The codegraph indexer at `server/plugins/codegraph/indexer.js:67–73` is the in-repo pattern.
2. Memoize `parseImports(file)` by `(path, mtime, size)`.
3. Cache directory listings (one `fs.readdir` beats 12 `stat`s) so `resolveImportPath` becomes a Map lookup.
4. Lift the Phase 3 convention probes onto the same cache.

**Confidence.** High. The eslint-disable comment is the codebase admitting the bug; the call graph from `routing.js` → `smart-scan.js` is direct and unguarded.

---

## #1 Coordination scheduler does N+1 task lookups every 30 s

**Where.** `server/maintenance/scheduler.js:294–303`

Every 30 s the scheduler lists active claims, then issues `db.getTask(claim.task_id)` per claim and `db.renewLease(claim.id, 600)` per running match. Three queries per active claim per tick.

**Fix.** Single JOIN (`SELECT c.id FROM claims c JOIN tasks t ON t.id = c.task_id WHERE c.status='active' AND t.status='running'`), then one batched `UPDATE` for renew.

**Confidence.** High. Impact is small today, scales linearly with active-claim count.

---

## #2 Maintenance 60 s tick is one big critical section

**Where.** `server/maintenance/scheduler.js:85–242`

The 60 s interval chains disk-space check → budget alerts → task archival → output purge → log-dir prune → cron exec → growth-table purge → file-lock cleanup → factory-decision cleanup inline. A single slow step (e.g. `db.vacuum()` from the `all` branch, or a large `purgeOldTaskOutput`) starves the rest until it finishes.

**Fix.** Stagger by tick number (each cleanup runs every Nth minute), or split into independent intervals with their own cadence.

**Confidence.** Medium. Only bites when one step regresses, but when it does, downstream cleanups silently miss their window.

---

## #3 Codegraph reindex is wholesale delete-then-rebuild

**Where.** `server/plugins/codegraph/indexer.js:113–119`

`runIndex()` issues `DELETE FROM cg_files / cg_symbols / cg_references / cg_dispatch_edges / cg_class_edges / cg_imports / cg_locals WHERE repo_path = ?` and re-inserts everything from scratch. Worker thread + dedicated DB file are mitigations, not cures — a one-file change still triggers a full repo rebuild.

The schema already has `content_sha` on `cg_files`; it's unused for incremental updates.

**Fix.** Diff `content_sha` against what's currently in `cg_files` for the repo and only re-extract changed paths.

**Confidence.** High mechanically; user-facing impact is bounded by manual trigger cadence (`cg_reindex` is operator-invoked, not on every task).

---

## #4 Tool-def surface is eagerly required at boot

**Where.** `server/tool-defs/*.js` (~53 files / ~14,400 lines) plus plugin tool-defs

Pulled into the require graph at startup even though most live behind progressive-unlock tiers. Cost is paid every restart and every test-suite require-graph traversal.

**Fix.** Lazy-require per tier on first `unlock_tier` call, or move tool defs into JSON files loaded on demand.

**Confidence.** Medium — needs require-graph profile to confirm cold-start contribution.

---

## #5 `getRunDirManager()` resolves the container per call inside a prune loop

**Where.** `server/maintenance/scheduler.js:32–42`, used in the per-task-id loop at `:517–531`

Helper does a `require('../container')` and `defaultContainer.get('runDirManager')` lookup every time it's called from inside the prune loop. O(n) `require()` chain.

**Fix.** Resolve once outside the loop and pass into `sweepRunDir`.

**Confidence.** High. Tiny but trivially fixable.

---

## #6 Token-budget check happens *after* the full prompt is assembled

**Where.** `server/utils/context-stuffing.js:112–161`

`stuffContext()` reads every candidate file, joins everything into one giant string, then estimates tokens. If the result exceeds budget, it throws — discarding all the read + join work via exception.

**Fix.** Maintain a running token estimate while iterating files; bail out (or truncate) before the next read once the budget is blown. Cheap and removes a wasted I/O burst.

**Confidence.** High.

---

## #7 CI run cache pruned unconditionally on every server start

**Where.** `server/index.js:1873`

`db.pruneCiRunCache(7)` runs on every startup regardless of how long it's been since the last prune.

**Fix.** Gate on `last_pruned_at` row, or fold into the 60 s maintenance tick instead of running per boot.

**Confidence.** Medium — low cost, included for completeness.

---

## #8 `resolveImportPath` probes 12 candidates per unresolved specifier

**Where.** `server/utils/smart-scan.js:72–97`

For each `./foo` specifier that isn't an exact hit, the resolver tries 6 extensions, then 6 `index.<ext>` candidates, each via `fs.statSync`. A file with N unresolved siblings (common when path aliases or removed files exist) costs `12N` stats.

**Fix.** Cache `fs.readdirSync(importerDir)` per directory and resolve against the set; or honor `package.json` `exports`/`main` once instead of probing.

**Confidence.** High. Absorbed by the #0 fix.

---

## #9 `parseImports` regex `lastIndex` reset pattern is concurrency-hostile

**Where.** `server/utils/smart-scan.js:136–138`

`IMPORT_PATTERNS` are module-level `/g` regexes with manual `lastIndex = 0` resets per call. Works today because everything is sync, but it forecloses on the async fix in #0.

**Fix.** Switch to `String.prototype.matchAll(/.../g)` — stateless, safe under concurrency.

**Confidence.** High. Absorbed by the #0 fix.

---

## #10 SSE keepalive + reaper allocated per connection

**Where.** `server/mcp/sse.js:416, 758`

Every MCP SSE connection allocates its own keepalive interval. A 60 s stale-session sweep walks the in-memory sessions Map linearly. Cheap today; linear in connection count.

**Fix.** Single shared sweep with a min-heap keyed by next-deadline.

**Confidence.** Low — only matters with many concurrent MCP clients.

---

## Notes

- The headline fix (#0) absorbs #8 and #9 — they live in the same function family.
- #1, #5, #6 are textbook "fix while you're already in the file" — bundle with the next touch instead of standalone tasks.
- Companion memory: `project_efficiency_audit_2026_05_15.md` in the operator's memory dir mirrors this content for cross-session recall.
