import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';

const { resolveCodexNativeBinary, _internal } = require('../execution/codex-native-resolve');

describe('codex-native-resolve', () => {
  describe('detectTargetTriple', () => {
    it('maps Windows x64 correctly', () => {
      expect(_internal.detectTargetTriple('win32', 'x64')).toBe('x86_64-pc-windows-msvc');
    });

    it('maps Windows arm64 correctly', () => {
      expect(_internal.detectTargetTriple('win32', 'arm64')).toBe('aarch64-pc-windows-msvc');
    });

    it('maps Linux and macOS targets', () => {
      expect(_internal.detectTargetTriple('linux', 'x64')).toBe('x86_64-unknown-linux-musl');
      expect(_internal.detectTargetTriple('linux', 'arm64')).toBe('aarch64-unknown-linux-musl');
      expect(_internal.detectTargetTriple('darwin', 'x64')).toBe('x86_64-apple-darwin');
      expect(_internal.detectTargetTriple('darwin', 'arm64')).toBe('aarch64-apple-darwin');
    });

    it('returns null for unsupported platform/arch', () => {
      expect(_internal.detectTargetTriple('sunos', 'x64')).toBeNull();
      expect(_internal.detectTargetTriple('linux', 'mips')).toBeNull();
    });
  });

  describe('resolveCodexNativeBinary', () => {
    // Synthesize a virtual codex-install layout, driven by a fileExists
    // predicate. No real filesystem writes — the resolver only probes paths.
    function fakeLayout({
      withNestedPkg = true,
      withLocalVendor = false,
      withBinary = true,
      withVendorPath = true,
    } = {}) {
      const codexRoot = path.join(os.tmpdir(), 'fake-codex-' + Math.random().toString(36).slice(2));
      const triple = 'x86_64-pc-windows-msvc';
      const platformPkg = '@openai/codex-win32-x64';
      const nestedPkgDir = path.join(codexRoot, 'node_modules', platformPkg);
      const nestedBinary = path.join(nestedPkgDir, 'vendor', triple, 'codex', 'codex.exe');
      const nestedVendorPath = path.join(nestedPkgDir, 'vendor', triple, 'path');
      const localBinary = path.join(codexRoot, 'vendor', triple, 'codex', 'codex.exe');
      const localVendorPath = path.join(codexRoot, 'vendor', triple, 'path');

      const existing = new Set();
      if (withNestedPkg) existing.add(path.join(nestedPkgDir, 'package.json'));
      if (withBinary) {
        if (withNestedPkg) existing.add(nestedBinary);
        if (withLocalVendor) existing.add(localBinary);
      }
      if (withVendorPath) {
        if (withNestedPkg) existing.add(nestedVendorPath);
        if (withLocalVendor) existing.add(localVendorPath);
      }

      return {
        codexRoot,
        nestedBinary,
        nestedVendorPath,
        localBinary,
        localVendorPath,
        fileExists: (p) => existing.has(p),
      };
    }

    it('resolves the nested platform-package binary path on Windows x64', () => {
      const layout = fakeLayout();
      const res = resolveCodexNativeBinary({
        platform: 'win32',
        arch: 'x64',
        fileExists: layout.fileExists,
        resolveRoot: () => layout.codexRoot,
      });
      expect(res).not.toBeNull();
      expect(res.binaryPath).toBe(layout.nestedBinary);
      expect(res.vendorPathDir).toBe(layout.nestedVendorPath);
      expect(res.targetTriple).toBe('x86_64-pc-windows-msvc');
    });

    it('falls back to the local vendor dir when the nested platform package is absent', () => {
      const layout = fakeLayout({ withNestedPkg: false, withLocalVendor: true });
      const res = resolveCodexNativeBinary({
        platform: 'win32',
        arch: 'x64',
        fileExists: layout.fileExists,
        resolveRoot: () => layout.codexRoot,
      });
      expect(res).not.toBeNull();
      expect(res.binaryPath).toBe(layout.localBinary);
      expect(res.vendorPathDir).toBe(layout.localVendorPath);
    });

    it('returns null when neither nested nor local vendor has the binary', () => {
      const layout = fakeLayout({ withNestedPkg: false, withLocalVendor: false });
      const res = resolveCodexNativeBinary({
        platform: 'win32',
        arch: 'x64',
        fileExists: layout.fileExists,
        resolveRoot: () => layout.codexRoot,
      });
      expect(res).toBeNull();
    });

    it('returns null when resolveRoot cannot find codex', () => {
      const res = resolveCodexNativeBinary({
        platform: 'win32',
        arch: 'x64',
        fileExists: () => true,
        resolveRoot: () => null,
      });
      expect(res).toBeNull();
    });

    it('returns null for unsupported platform triples', () => {
      const res = resolveCodexNativeBinary({
        platform: 'sunos',
        arch: 'x64',
        fileExists: () => true,
        resolveRoot: () => '/does/not/matter',
      });
      expect(res).toBeNull();
    });

    it('returns vendorPathDir=null when the vendor path/ dir does not exist', () => {
      const layout = fakeLayout({ withVendorPath: false });
      const res = resolveCodexNativeBinary({
        platform: 'win32',
        arch: 'x64',
        fileExists: layout.fileExists,
        resolveRoot: () => layout.codexRoot,
      });
      expect(res).not.toBeNull();
      expect(res.binaryPath).toBe(layout.nestedBinary);
      expect(res.vendorPathDir).toBeNull();
    });
  });
});
