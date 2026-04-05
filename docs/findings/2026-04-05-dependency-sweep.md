# Dependency Sweep - 2026-04-05

**Variant:** dependency
**Scope:** `server/package.json`, `dashboard/package.json`
**Working directory:** `C:\Users\<user>\Projects\torque-public`

## Executive Summary

- 1 new likely-unused dependency group in `dashboard`: `@types/react` and `@types/react-dom`.
- 7 outdated direct packages are currently reported in `server`: 5 have in-range updates available now, and 2 are behind newer out-of-range releases.
- 0 confirmed new CVEs. `npm audit --json` did not complete because the npm advisory endpoint request failed, so the CVE result is inconclusive rather than clean.

## New Findings

### 1. `dashboard` is JS/JSX-only, but still carries optional TypeScript type packages

**Severity:** LOW
**Files:** `dashboard/package.json:28-29`

`@types/react` and `@types/react-dom` are declared directly even though the dashboard currently contains only `.js` and `.jsx` files and no `tsconfig.*`. The lockfile evidence also shows these packages as optional peer metadata rather than required runtime or build dependencies.

Impact:
- Extra install surface and lockfile churn for packages the current dashboard toolchain does not consume.
- React upgrades look heavier than they really are because optional editor-time packages are presented like mandatory project dependencies.

Evidence:

    rg -n -F "@types/react" dashboard
    dashboard\package.json:28:    "@types/react": "^19.2.5"

    rg -n -F "@types/react-dom" dashboard
    dashboard\package.json:29:    "@types/react-dom": "^19.2.3"

    rg --files dashboard | rg "(^|\\)(tsconfig.*|.*\.ts$|.*\.tsx$)"
    # no matches

    rg -n -C 2 -F "\"@types/react\"" dashboard\package-lock.json
    2078-      },
    2079-      "peerDependenciesMeta": {
    2080:        "@types/react": {
    2081-          "optional": true

    rg -n -C 2 -F "\"@types/react-dom\"" dashboard\package-lock.json
    2081-          "optional": true
    2082-        },
    2083:        "@types/react-dom": {
    2084-          "optional": true

### 2. `server` has seven outdated direct dependencies and devDependencies

**Severity:** LOW to MEDIUM
**Files:** `server/package.json:34-40`, `server/package.json:51-53`

`npm outdated --json` reported seven direct packages behind current releases. Five can be updated within the currently declared semver range; two are behind newer out-of-range releases and need compatibility review before bumping.

| Package | Current | Wanted | Latest | Notes |
|--------|---------|--------|--------|-------|
| `ws` | `8.19.0` | `8.20.0` | `8.20.0` | Patch update available now |
| `undici` | `7.24.4` | `7.24.7` | `8.0.2` | Patch available now, major also pending |
| `eslint` | `9.39.2` | `9.39.4` | `10.2.0` | Patch available now, major also pending |
| `vitest` | `4.0.18` | `4.1.2` | `4.1.2` | In-range minor update available |
| `@vitest/coverage-v8` | `4.0.18` | `4.1.2` | `4.1.2` | In-range minor update available |
| `better-sqlite3` | `11.10.0` | `11.10.0` | `12.8.0` | Newer breaking major only |
| `web-tree-sitter` | `0.24.7` | `0.24.7` | `0.26.8` | Newer out-of-range release only |

Evidence:

    npm outdated --json
    {
      "@vitest/coverage-v8": { "current": "4.0.18", "wanted": "4.1.2", "latest": "4.1.2" },
      "better-sqlite3": { "current": "11.10.0", "wanted": "11.10.0", "latest": "12.8.0" },
      "eslint": { "current": "9.39.2", "wanted": "9.39.4", "latest": "10.2.0" },
      "undici": { "current": "7.24.4", "wanted": "7.24.7", "latest": "8.0.2" },
      "vitest": { "current": "4.0.18", "wanted": "4.1.2", "latest": "4.1.2" },
      "web-tree-sitter": { "current": "0.24.7", "wanted": "0.24.7", "latest": "0.26.8" },
      "ws": { "current": "8.19.0", "wanted": "8.20.0", "latest": "8.20.0" }
    }

## CVE Check

No new CVEs were confirmed in this run. `npm audit --json` failed before returning advisory data:

    npm audit --json
    {
      "message": "request to https://registry.npmjs.org/-/npm/v1/security/advisories/bulk failed, reason: ",
      "error": {
        "summary": "",
        "detail": ""
      }
    }

Treat the CVE status as unknown until the audit command can reach the npm advisory endpoint.

## Exclusions

These were intentionally not reported as new issues:

- Previously fixed items: removed unused dashboard dependencies, added `license`, and moved `bcryptjs` to `optionalDependencies`.
- `server` optional packages are currently referenced: `bcryptjs` in `server/plugins/auth/user-manager.js`, `sharp` and `tesseract.js` in `server/plugins/snapscope/handlers/capture.js`.
- `@vitest/coverage-v8` is in active use in both `server/vitest.config.js` and `dashboard/vitest.config.js` via `coverage.provider = 'v8'`.
- `@testing-library/dom` was not counted as unused because `dashboard/package-lock.json` shows it as a peer dependency requirement for `@testing-library/react`.