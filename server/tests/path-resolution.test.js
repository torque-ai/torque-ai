import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const path = require('node:path');

const {
  normalizePath,
  pathMatchesProject,
  resolveRelativePath,
} = require('../utils/path-resolution');

describe('utils/path-resolution', () => {
  it('normalizePath normalizes backslashes, trailing slashes, and case', () => {
    expect(normalizePath('C:\\Users\\Example\\Torque-Public\\\\')).toBe('c:/users/example/torque-public');
  });

  it('normalizePath returns an empty string for nullish and empty inputs', () => {
    expect(normalizePath(null)).toBe('');
    expect(normalizePath(undefined)).toBe('');
    expect(normalizePath('')).toBe('');
  });

  it('pathMatchesProject matches exact, normalized, and basename-equivalent paths', () => {
    const canonicalPath = path.join(process.cwd(), 'projects', 'torque-public');

    expect(pathMatchesProject(canonicalPath, canonicalPath)).toBe(true);
    expect(
      pathMatchesProject(
        canonicalPath.replace(/\\/g, '/').toUpperCase() + '/',
        canonicalPath.toLowerCase(),
      ),
    ).toBe(true);
    expect(
      pathMatchesProject(
        path.join(process.cwd(), 'sandbox', 'job-123', 'torque-public'),
        canonicalPath,
      ),
    ).toBe(true);
  });

  it('pathMatchesProject returns false for falsy inputs and non-matching paths', () => {
    const canonicalPath = path.join(process.cwd(), 'projects', 'torque-public');

    expect(pathMatchesProject(null, canonicalPath)).toBe(false);
    expect(pathMatchesProject(canonicalPath, undefined)).toBe(false);
    expect(pathMatchesProject('', canonicalPath)).toBe(false);
    expect(
      pathMatchesProject(
        path.join(process.cwd(), 'sandbox', 'job-123', 'different-project'),
        canonicalPath,
      ),
    ).toBe(false);
  });

  it('resolveRelativePath extracts a project-relative path in standard and sandbox suffix cases', () => {
    const canonicalProjectPath = path.join(process.cwd(), 'projects', 'torque-public');
    const standardFilePath = path.join(
      canonicalProjectPath,
      'server',
      'utils',
      'path-resolution.js',
    );
    const sandboxFilePath = path.join(
      process.cwd(),
      'sandbox',
      'job-123',
      'torque-public',
      'server',
      'utils',
      'path-resolution.js',
    );

    expect(resolveRelativePath(standardFilePath, canonicalProjectPath)).toBe(
      'server/utils/path-resolution.js',
    );
    expect(resolveRelativePath(sandboxFilePath, canonicalProjectPath)).toBe(
      'server/utils/path-resolution.js',
    );
  });
});
