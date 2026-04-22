'use strict';

/**
 * Codex Native Binary Resolver
 *
 * TORQUE launches Codex on Windows via `codex.cmd` → `node codex.js` → `codex.exe`
 * → `pwsh.exe` (Codex's command-safety AST parser). Even with `windowsHide: true`
 * on our direct spawn, the flag does not propagate to the descendant pwsh window,
 * producing visible flashes during factory execution.
 *
 * This module resolves the bundled native `codex.exe` inside the installed
 * `@openai/codex` package so callers can spawn it directly, skipping the node
 * wrapper. It mirrors the resolution logic in `@openai/codex/bin/codex.js`:
 *   - Find the platform package (e.g. `@openai/codex-win32-x64`) installed
 *     inside the codex root's `node_modules/`.
 *   - Construct the vendor binary path:
 *     `<platformPkg>/vendor/<targetTriple>/codex/codex.exe`.
 *   - Return the vendor `path/` directory containing the bundled `rg.exe`, so
 *     callers can prepend it to PATH.
 *
 * Any failure (missing install, unsupported platform, permission error) returns
 * `null` — callers fall back to the existing `codex.cmd` path.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Mirrors PLATFORM_PACKAGE_BY_TARGET in @openai/codex/bin/codex.js
const PLATFORM_PACKAGE_BY_TARGET = {
  'x86_64-unknown-linux-musl': '@openai/codex-linux-x64',
  'aarch64-unknown-linux-musl': '@openai/codex-linux-arm64',
  'x86_64-apple-darwin': '@openai/codex-darwin-x64',
  'aarch64-apple-darwin': '@openai/codex-darwin-arm64',
  'x86_64-pc-windows-msvc': '@openai/codex-win32-x64',
  'aarch64-pc-windows-msvc': '@openai/codex-win32-arm64',
};

function detectTargetTriple(platform, arch) {
  if (platform === 'linux' || platform === 'android') {
    if (arch === 'x64') return 'x86_64-unknown-linux-musl';
    if (arch === 'arm64') return 'aarch64-unknown-linux-musl';
  }
  if (platform === 'darwin') {
    if (arch === 'x64') return 'x86_64-apple-darwin';
    if (arch === 'arm64') return 'aarch64-apple-darwin';
  }
  if (platform === 'win32') {
    if (arch === 'x64') return 'x86_64-pc-windows-msvc';
    if (arch === 'arm64') return 'aarch64-pc-windows-msvc';
  }
  return null;
}

/**
 * Locate the root of the installed @openai/codex package. Tries, in order:
 *   1. `require.resolve('@openai/codex/package.json')` — works when TORQUE's
 *      own node_modules has codex or when NODE_PATH includes the global.
 *   2. Walk up from `which codex` / `where.exe codex` to the `@openai/codex`
 *      dir — works for global npm installs that aren't on require's resolve path.
 * Returns the absolute path to the codex package root, or null.
 */
function resolveCodexPackageRoot({ platform = process.platform, env = process.env } = {}) {
  // Path 1: Node's resolver — cheap and exact.
  try {
    const pkgJson = require.resolve('@openai/codex/package.json');
    return path.dirname(pkgJson);
  } catch (_err) {
    // not on resolve path
  }

  // Path 2: Find the CLI shim on PATH, then walk to the codex package root.
  // On npm globals (Windows), the .cmd is at <npmPrefix>/codex.cmd and the
  // package is at <npmPrefix>/node_modules/@openai/codex/.
  const finder = platform === 'win32' ? 'where.exe' : 'which';
  const cmdName = platform === 'win32' ? 'codex.cmd' : 'codex';
  let cliPath;
  try {
    const raw = execFileSync(finder, [cmdName], {
      encoding: 'utf8',
      windowsHide: true,
      env,
    }).trim();
    cliPath = raw.split(/\r?\n/)[0].trim();
  } catch (_err) {
    return null;
  }
  if (!cliPath) return null;

  // npm globals: <npmPrefix>/codex.cmd  → <npmPrefix>/node_modules/@openai/codex
  const cliDir = path.dirname(cliPath);
  const candidate = path.join(cliDir, 'node_modules', '@openai', 'codex');
  if (fs.existsSync(path.join(candidate, 'package.json'))) {
    return candidate;
  }

  return null;
}

/**
 * Resolve the native codex binary path + bundled-tools PATH dir for the current
 * platform. Mirrors the logic in @openai/codex/bin/codex.js.
 *
 * @param {object} [opts]
 * @param {string} [opts.platform] — override for tests (default: process.platform)
 * @param {string} [opts.arch] — override for tests (default: process.arch)
 * @param {object} [opts.env] — override for tests (default: process.env)
 * @param {function} [opts.fileExists] — override for tests (default: fs.existsSync)
 * @returns {{ binaryPath: string, vendorPathDir: string | null, targetTriple: string } | null}
 */
function resolveCodexNativeBinary({
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  fileExists = fs.existsSync,
  resolveRoot = null,
} = {}) {
  const targetTriple = detectTargetTriple(platform, arch);
  if (!targetTriple) return null;

  const platformPackage = PLATFORM_PACKAGE_BY_TARGET[targetTriple];
  if (!platformPackage) return null;

  const codexRoot = resolveRoot
    ? resolveRoot({ platform, env })
    : resolveCodexPackageRoot({ platform, env });
  if (!codexRoot) return null;

  // Codex's own resolver first tries require.resolve(platformPackage/package.json)
  // from the codex package. We mirror that by looking at the nested node_modules.
  // Fallback: check `vendor/` directly alongside the codex package (matches the
  // localBinaryPath fallback in bin/codex.js).
  const binaryName = platform === 'win32' ? 'codex.exe' : 'codex';

  const nestedPkgRoot = path.join(codexRoot, 'node_modules', platformPackage);
  const nestedVendor = path.join(nestedPkgRoot, 'vendor');
  const localVendor = path.join(codexRoot, 'vendor');

  let vendorRoot = null;
  if (fileExists(path.join(nestedPkgRoot, 'package.json'))) {
    vendorRoot = nestedVendor;
  } else if (fileExists(path.join(localVendor, targetTriple, 'codex', binaryName))) {
    vendorRoot = localVendor;
  } else {
    return null;
  }

  const archRoot = path.join(vendorRoot, targetTriple);
  const binaryPath = path.join(archRoot, 'codex', binaryName);
  if (!fileExists(binaryPath)) return null;

  // The vendored `path/` dir holds bundled tools (rg.exe etc.) that Codex expects
  // to find on PATH. Optional — Codex works without it, just with degraded search.
  const vendorPathDir = path.join(archRoot, 'path');
  const pathDir = fileExists(vendorPathDir) ? vendorPathDir : null;

  return { binaryPath, vendorPathDir: pathDir, targetTriple };
}

module.exports = {
  resolveCodexNativeBinary,
  // Exposed for tests only.
  _internal: {
    detectTargetTriple,
    resolveCodexPackageRoot,
    PLATFORM_PACKAGE_BY_TARGET,
  },
};
