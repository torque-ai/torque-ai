# Dependency Sweep - 2026-04-12

**Variant:** dependency
**Scope:** `server/package.json`, `dashboard/package.json`
**Working directory:** `C:\Users\<user>\Projects\torque-public`

## Executive Summary

- 1 new dependency finding in `server`: optional `tesseract.js` is still declared, but the current SnapScope OCR flow no longer imports it locally.
- `server` still has 4 outdated direct packages, but they are a reduced subset of the already-documented 2026-04-05 stale set and are not repeated here.
- `npm audit --json` failed in both `server` and `dashboard`, so direct-dependency CVE status is unknown for this sweep rather than clean.
- `dashboard` `npm outdated --json` crashed with `npm error Exit handler never called!`, so dashboard freshness is inconclusive for this run.
- License review stayed permissive: both package roots declare `MIT`, and no direct dependency inspected locally exposed GPL/AGPL license text.

## Inventory Snapshot

- `server` runtime deps: `better-sqlite3`, `bonjour-service`, `tree-sitter-wasms`, `undici`, `uuid`, `web-tree-sitter`, `ws`; optional deps: `bcryptjs`, `sharp`, `tesseract.js`; dev deps: `@vitest/coverage-v8`, `eslint`, `jsdom`, `vitest`.
- `dashboard` runtime deps: `date-fns`, `react`, `react-dom`, `react-router-dom`; dev deps: `@eslint/js`, `@playwright/test`, `@tailwindcss/vite`, `@testing-library/dom`, `@testing-library/jest-dom`, `@testing-library/react`, `@vitejs/plugin-react`, `@vitest/coverage-v8`, `eslint`, `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh`, `globals`, `jsdom`, `tailwindcss`, `vite`, `vitest`.

## New Findings

### 1. `server` still declares optional `tesseract.js`, but OCR now delegates to the remote peek host

**Severity:** MEDIUM
**Files:** `server/package.json:42-45`, `server/plugins/snapscope/handlers/capture.js:277-297`, `server/plugins/snapscope/handlers/analysis.js:273-295`, `server/tests/peek-capture-handlers.test.js:163`, `server/package-lock.json:3990-3994`

The current SnapScope OCR path no longer imports `tesseract.js` in runtime code. Both server-side OCR entry points now proxy requests to `hostUrl + '/ocr'`, and the only remaining in-repo `tesseract.js` reference is a test mock. That leaves `tesseract.js` declared in `optionalDependencies` without a local production consumer, while its lockfile entry still carries an install script and pulls `tesseract.js-core`.

Impact:

- Unused optional dependency surface remains in the shipped server manifest.
- The package still adds install-time script execution and transitive payload even though runtime OCR is offloaded to the remote peek host.
- The 2026-04-05 dependency sweep excluded `tesseract.js` as active; that assumption is no longer true in the current code.

Evidence:

    rg -n "tesseract\.js|/ocr|hasInstallScript" server/package.json server/package-lock.json server/plugins/snapscope/handlers/capture.js server/plugins/snapscope/handlers/analysis.js server/tests/peek-capture-handlers.test.js
    server/plugins/snapscope/handlers/capture.js:285:        const ocrResult = await peekHttpPostWithRetry(hostUrl + '/ocr', ocrPayload, timeoutMs);
    server/plugins/snapscope/handlers/analysis.js:273:    const result = await peekHttpPostWithRetry(hostUrl + '/ocr', payload, timeoutMs);
    server/tests/peek-capture-handlers.test.js:163:  installMock('tesseract.js', mockTesseract);
    server/package-lock.json:3990:    "node_modules/tesseract.js": {
    server/package-lock.json:3994:      "hasInstallScript": true
    server/package.json:45:    "tesseract.js": "^7.0.0"

## CVE Check

No new CVEs were confirmed in this run. `npm audit --json` failed in both package roots before returning advisory data:

    cd server && npm audit --json
    npm warn audit request to https://registry.npmjs.org/-/npm/v1/security/advisories/bulk failed, reason:
    npm error audit endpoint returned an error

    cd dashboard && npm audit --json
    npm warn audit request to https://registry.npmjs.org/-/npm/v1/security/advisories/bulk failed, reason:
    npm error audit endpoint returned an error

Treat direct-dependency CVE status as unknown for this sweep.

## Exclusions

- The remaining `server` outdated packages were already documented on 2026-04-05, so they were not re-reported. `cd server && npm outdated --json` now returns only `@vitest/coverage-v8`, `eslint`, `undici`, and `vitest`; previously-reported `better-sqlite3` and `web-tree-sitter` are no longer in the outdated set.
- `cd dashboard && npm outdated --json` was attempted twice and failed both times with `npm error Exit handler never called!`, so dashboard outdated status is inconclusive rather than clean.
- All current `dashboard` runtime dependencies show live source usage in `dashboard/src`: `date-fns`, `react`, `react-dom`, and `react-router-dom`.
- All `server` runtime and optional dependencies besides `tesseract.js` show live code usage in `server/**/*.js`: `better-sqlite3`, `bonjour-service`, `tree-sitter-wasms`, `undici`, `uuid`, `web-tree-sitter`, `ws`, `bcryptjs`, and `sharp`.
- Duplicate toolchain versions do exist across the two package roots (`eslint`, `vitest`, `@vitest/coverage-v8`, `jsdom`), but they are split across separate manifests and were not treated as a new defect absent breakage.
- No new license conflict was found in the scoped manifests. `server/package.json` and `dashboard/package.json` both declare `MIT`; the locally installed direct packages inspected for this sweep were permissive or weak-copyleft-free. The previously-documented `sharp` transitive LGPL binary remains an already-known item and was not re-reported.
