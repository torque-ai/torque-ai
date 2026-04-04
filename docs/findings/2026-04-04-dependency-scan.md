# Dependency Scan Findings

**Date:** 2026-04-04
**Scope:** `server/package.json` (8 prod + 2 optional + 3 dev) and `dashboard/package.json` (7 prod + 15 dev)
**Node.js:** v22.20.0

---

## Executive Summary

- **0 CVEs** in either project (`npm audit` clean for both server and dashboard)
- **3 unused production dependencies** in dashboard (`@dnd-kit/core`, `@dnd-kit/sortable`, `@tanstack/react-table`)
- **1 LGPL-3.0 transitive dependency** via `sharp` (prebuilt native binary -- acceptable for dynamic linking)
- **7 outdated packages** in server, **16 outdated packages** in dashboard
- **1 major version available** for `better-sqlite3` (v11 -> v12) with potential breaking changes
- **50 MB** consumed by `tree-sitter-wasms` alone (used by a single module)

---

## Finding DEP-01: Unused Dashboard Dependencies (6 MB wasted)

**Status:** NEW
**Severity:** Low
**Impact:** Unnecessary bundle bloat and install time

Three production dependencies in `dashboard/package.json` have **zero imports** anywhere in `dashboard/src/`:

| Package | Installed | Size on Disk | Imports Found |
|---------|-----------|--------------|---------------|
| `@dnd-kit/core` | ^6.3.1 | 1.7 MB (combined) | 0 |
| `@dnd-kit/sortable` | ^10.0.0 | (included above) | 0 |
| `@tanstack/react-table` | ^8.21.3 | 4.3 MB | 0 |

Searched for: `@dnd-kit`, `DndContext`, `useSortable`, `SortableContext`, `tanstack`, `useReactTable`, `flexRender`, `getCoreRowModel` -- all returned zero matches.

**Recommendation:** Remove from `dashboard/package.json` and run `npm install` to clean up.

---

## Finding DEP-02: Heavy tree-sitter-wasms Install (50 MB)

**Status:** NEW
**Severity:** Info
**Impact:** Install size; single consumer

`tree-sitter-wasms` (50 MB on disk) is used exclusively by `server/utils/symbol-indexer.js` for AST-level symbol extraction. The paired `web-tree-sitter` is 0.24.7 (latest is 0.26.8 -- 2 minor versions behind).

The WASM directory contains pre-compiled parsers for ~30 languages. If the project only needs JS/TS/Python/Go/Rust/C#/C/C++/CSS (the 10 extensions mapped in `symbol-indexer.js`), there may be an opportunity to use individual `tree-sitter-<lang>` WASM files instead, but this is low priority.

**Recommendation:** No action required. Note the 50 MB footprint for CI/container optimization if needed.

---

## Finding DEP-03: Outdated Dependencies

**Status:** NEW
**Severity:** Low (no CVEs, but staying current reduces future upgrade burden)

### Server (7 outdated)

| Package | Current | Wanted | Latest | Notes |
|---------|---------|--------|--------|-------|
| `better-sqlite3` | 11.10.0 | 11.10.0 | **12.8.0** | Major version bump; may have breaking API changes |
| `web-tree-sitter` | 0.24.7 | 0.24.7 | 0.26.8 | 2 minor versions behind |
| `ws` | 8.19.0 | 8.20.0 | 8.20.0 | Patch update |
| `undici` | 7.24.4 | 7.24.7 | 8.0.2 | Minor patches in v7; v8 is major |
| `vitest` | 4.0.18 | 4.1.2 | 4.1.2 | Dev dependency |
| `@vitest/coverage-v8` | 4.0.18 | 4.1.2 | 4.1.2 | Dev dependency |
| `eslint` | 9.39.2 | 9.39.4 | 10.2.0 | Dev dependency; v10 is major |

### Dashboard (16 outdated)

| Package | Current | Wanted | Latest | Notes |
|---------|---------|--------|--------|-------|
| `react` | 19.2.3 | 19.2.4 | 19.2.4 | Patch |
| `react-dom` | 19.2.3 | 19.2.4 | 19.2.4 | Patch |
| `react-router-dom` | 7.12.0 | 7.14.0 | 7.14.0 | Minor update |
| `tailwindcss` | 4.1.18 | 4.2.2 | 4.2.2 | Minor update |
| `@tailwindcss/vite` | 4.1.18 | 4.2.2 | 4.2.2 | Minor update |
| `vite` | 7.3.1 | 7.3.1 | **8.0.3** | Major version available |
| `@vitejs/plugin-react` | 5.1.2 | 5.2.0 | **6.0.1** | Major version available |
| `jsdom` | 28.1.0 | 28.1.0 | **29.0.1** | Major version available |
| `globals` | 16.5.0 | 16.5.0 | **17.4.0** | Major version available |
| `eslint-plugin-react-refresh` | 0.4.26 | 0.4.26 | 0.5.2 | Minor |
| `@playwright/test` | 1.58.2 | 1.59.1 | 1.59.1 | Minor |
| `vitest` | 4.1.0 | 4.1.2 | 4.1.2 | Patch |
| `@vitest/coverage-v8` | 4.1.0 | 4.1.2 | 4.1.2 | Patch |
| `eslint` | 9.39.2 | 9.39.4 | 10.2.0 | Major available |
| `@eslint/js` | 9.39.2 | 9.39.4 | 10.0.1 | Major available |
| `@types/react` | 19.2.9 | 19.2.14 | 19.2.14 | Patch |

**Recommendation:**
- **Safe to update now** (patch/minor within semver range): `ws`, `undici` (7.x), `react`, `react-dom`, `react-router-dom`, `tailwindcss`, `@tailwindcss/vite`, `vitest`, `@vitest/coverage-v8`, `@types/react`, `@playwright/test`
- **Evaluate before updating** (major versions): `better-sqlite3` v12, `vite` v8, `eslint` v10, `jsdom` v29

---

## Finding DEP-04: LGPL-3.0 Transitive Dependency (sharp)

**Status:** NEW
**Severity:** Info
**Impact:** License compliance consideration

`sharp` (optional dependency, Apache-2.0) bundles `@img/sharp-win32-x64` which is dual-licensed `Apache-2.0 AND LGPL-3.0-or-later`. This is the prebuilt libvips native binary.

Since `sharp` is listed as an **optional dependency** and libvips is dynamically linked (not statically compiled into the project), this is standard LGPL compliance -- no source disclosure obligation for the TORQUE project itself.

All other production dependencies are permissively licensed (MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, Unlicense).

**Recommendation:** No action required. Document the LGPL transitive dependency in a LICENSE-THIRD-PARTY file if preparing for formal distribution.

---

## Finding DEP-05: Missing License Field in package.json

**Status:** NEW
**Severity:** Low
**Impact:** Package metadata

- `server/package.json` has no `license` field (shows as UNKNOWN in license-checker)
- `dashboard/package.json` is `private: true` with no license (shows as UNLICENSED)

The root project is MIT licensed per the repo, but the individual `package.json` files don't declare it.

**Recommendation:** Add `"license": "MIT"` to both `server/package.json` and `dashboard/package.json`.

---

## Finding DEP-06: bcryptjs Used Only in Auth Plugin

**Status:** NEW
**Severity:** Info
**Impact:** Dependency footprint

`bcryptjs` (a production dependency in `server/package.json`) is only imported in `server/plugins/auth/user-manager.js` -- the enterprise auth plugin that loads only when `TORQUE_AUTH_MODE=enterprise`.

In default local mode, bcryptjs is installed but never loaded. It's lightweight (BSD-3-Clause, small footprint) so this is informational only.

**Recommendation:** Consider moving to `optionalDependencies` alongside `sharp` and `tesseract.js`, since it's only needed for enterprise mode. Low priority.

---

## Finding DEP-07: bonjour-service Used Only in discovery.js

**Status:** NEW
**Severity:** Info
**Impact:** Dependency footprint

`bonjour-service` is imported only in `server/discovery.js` for mDNS/Bonjour LAN host discovery. It's small (135 KB) and MIT licensed.

**Recommendation:** No action required.

---

## Dependency Usage Summary

### Server Production Dependencies

| Package | Version | Files Using It | Status |
|---------|---------|---------------|--------|
| `better-sqlite3` | 11.10.0 | 49 files (core DB layer + tests) | Active, heavily used |
| `uuid` | 13.x | 53 files | Active, heavily used |
| `ws` | 8.19.0 | 2 files (dashboard-server) | Active |
| `undici` | 7.24.4 | 1 file (proxy-agent) | Active |
| `web-tree-sitter` | 0.24.7 | 1 file (symbol-indexer) | Active |
| `tree-sitter-wasms` | 0.1.13 | 1 file (symbol-indexer, path ref) | Active |
| `bonjour-service` | 1.3.x | 1 file (discovery) | Active |
| `bcryptjs` | 3.0.3 | 1 file (auth plugin only) | Active (enterprise mode) |

### Server Optional Dependencies

| Package | Version | Files Using It | Status |
|---------|---------|---------------|--------|
| `sharp` | 0.34.5 | 3 files (snapscope plugin) | Active |
| `tesseract.js` | 7.0.0 | 2 files (snapscope plugin) | Active |

### Dashboard Production Dependencies

| Package | Version | Files Using It | Status |
|---------|---------|---------------|--------|
| `react` | 19.2.3 | 46 files | Active, core framework |
| `react-dom` | 19.2.3 | 46 files | Active, core framework |
| `react-router-dom` | 7.12.0 | 12 files | Active |
| `date-fns` | 4.1.0 | 11 files | Active |
| `@dnd-kit/core` | 6.3.1 | **0 files** | **UNUSED -- remove** |
| `@dnd-kit/sortable` | 10.0.0 | **0 files** | **UNUSED -- remove** |
| `@tanstack/react-table` | 8.21.3 | **0 files** | **UNUSED -- remove** |

---

## Actionable Summary

| ID | Finding | Severity | Action |
|----|---------|----------|--------|
| DEP-01 | 3 unused dashboard deps (6 MB) | Low | Remove `@dnd-kit/core`, `@dnd-kit/sortable`, `@tanstack/react-table` |
| DEP-02 | tree-sitter-wasms 50 MB footprint | Info | Awareness only |
| DEP-03 | 23 outdated packages (0 CVEs) | Low | Update patch/minor versions; evaluate majors separately |
| DEP-04 | LGPL-3.0 via sharp prebuilt binary | Info | Document in LICENSE-THIRD-PARTY if distributing |
| DEP-05 | Missing license fields in package.json | Low | Add `"license": "MIT"` to both |
| DEP-06 | bcryptjs only used in enterprise mode | Info | Consider moving to optionalDependencies |
| DEP-07 | bonjour-service single consumer | Info | No action |
