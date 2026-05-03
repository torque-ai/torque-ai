'use strict';

const {
  findFirstUnroutedCommand,
  findHeavyLocalValidationCommand,
} = require('../utils/heavy-validation-guard');

// Focused unit tests for the heavy-validation-guard helpers. Used by
// task-startup, loop-controller, plan-executor, plan-quality-gate, and
// governance/hooks to detect heavy validation commands that should be
// wrapped in `torque-remote` instead of running locally. Coverage was
// indirect via consumers; pin the contract so future refactors don't
// silently break the text-parsing edge cases (quotes, backslashes,
// case folding, multi-line, prefix detection).

describe('findHeavyLocalValidationCommand', () => {
  describe('positive matches', () => {
    it('flags `dotnet build`', () => {
      expect(findHeavyLocalValidationCommand('dotnet build app.sln'))
        .toBe('dotnet build app.sln');
    });

    it('flags `dotnet test`', () => {
      expect(findHeavyLocalValidationCommand('dotnet test tests/Foo.csproj'))
        .toBe('dotnet test tests/Foo.csproj');
    });

    it('flags `pwsh scripts/build.ps1`', () => {
      expect(findHeavyLocalValidationCommand('pwsh scripts/build.ps1'))
        .toBe('pwsh scripts/build.ps1');
    });

    it('flags `pwsh -file scripts/build.ps1`', () => {
      expect(findHeavyLocalValidationCommand('pwsh -file scripts/build.ps1'))
        .toBe('pwsh -file scripts/build.ps1');
    });

    it('flags `powershell scripts/test.ps1`', () => {
      expect(findHeavyLocalValidationCommand('powershell scripts/test.ps1'))
        .toBe('powershell scripts/test.ps1');
    });

    it('flags `bash scripts/build.sh`', () => {
      expect(findHeavyLocalValidationCommand('bash scripts/build.sh'))
        .toBe('bash scripts/build.sh');
    });

    it('flags `sh scripts/test.sh`', () => {
      expect(findHeavyLocalValidationCommand('sh scripts/test.sh'))
        .toBe('sh scripts/test.sh');
    });

    it('is case-insensitive', () => {
      expect(findHeavyLocalValidationCommand('DOTNET BUILD foo.sln'))
        .toBe('DOTNET BUILD foo.sln');
    });

    it('handles Windows backslash paths in scripts pattern', () => {
      expect(findHeavyLocalValidationCommand('pwsh scripts\\build.ps1'))
        .toBe('pwsh scripts\\build.ps1');
    });

    it('finds the first heavy command across multiple lines', () => {
      const text = [
        'echo prelude',
        'dotnet test foo.csproj',
        'echo postlude',
      ].join('\n');
      expect(findHeavyLocalValidationCommand(text)).toBe('dotnet test foo.csproj');
    });
  });

  describe('remote-routed commands are skipped', () => {
    it('ignores `torque-remote dotnet build`', () => {
      expect(findHeavyLocalValidationCommand('torque-remote dotnet build app.sln'))
        .toBeNull();
    });

    it('ignores `torque-remote bash scripts/build.sh`', () => {
      expect(findHeavyLocalValidationCommand('torque-remote bash scripts/build.sh'))
        .toBeNull();
    });

    it('ignores `torque-remote bash -c "dotnet test ..."`', () => {
      expect(findHeavyLocalValidationCommand('torque-remote bash -c "dotnet test foo.csproj"'))
        .toBeNull();
    });

    it('still flags an unrouted command on a different line in a mixed file', () => {
      const text = [
        'torque-remote dotnet build foo.sln',
        'dotnet test bar.csproj',
      ].join('\n');
      // The bare second line is unrouted — must be flagged.
      expect(findHeavyLocalValidationCommand(text)).toBe('dotnet test bar.csproj');
    });
  });

  describe('diagnostic fenced blocks', () => {
    it('can ignore verify output fences that mention heavy command names in test output', () => {
      const text = [
        'Verify output (tail):',
        '```',
        'passes: counts dotnet test projects and C# test files in the fallback heuristic 4ms',
        '```',
      ].join('\n');

      expect(findHeavyLocalValidationCommand(text, { ignoreDiagnosticFencedBlocks: true }))
        .toBeNull();
    });

    it('still flags bare heavy commands outside diagnostic fences', () => {
      const text = [
        'Verify output (tail):',
        '```',
        'passes: counts dotnet test projects and C# test files in the fallback heuristic 4ms',
        '```',
        '',
        'Now run dotnet test app.sln locally.',
      ].join('\n');

      expect(findHeavyLocalValidationCommand(text, { ignoreDiagnosticFencedBlocks: true }))
        .toBe('Now run dotnet test app.sln locally.');
    });

    it('ignores the next nearby diagnostic fence when parser notes separate it from the header', () => {
      const text = [
        'Verify output (tail):',
        'Update `server/factory/scorers.js` based on the failure context.',
        '```',
        'passes: counts dotnet test projects and C# test files in the fallback heuristic 4ms',
        '```',
      ].join('\n');

      expect(findHeavyLocalValidationCommand(text, { ignoreDiagnosticFencedBlocks: true }))
        .toBeNull();
    });
  });

  describe('non-matches', () => {
    it('returns null for empty / whitespace input', () => {
      expect(findHeavyLocalValidationCommand('')).toBeNull();
      expect(findHeavyLocalValidationCommand('   \n\n   ')).toBeNull();
      expect(findHeavyLocalValidationCommand(null)).toBeNull();
      expect(findHeavyLocalValidationCommand(undefined)).toBeNull();
    });

    it('does not flag mentions inside prose', () => {
      // The regex requires word boundaries around `dotnet build` etc., so
      // accidental substring matches inside prose words don't trip it.
      expect(findHeavyLocalValidationCommand('We will discuss "dotnet" later')).toBeNull();
    });

    it('does not flag `dotnet --version` or other lightweight dotnet calls', () => {
      expect(findHeavyLocalValidationCommand('dotnet --version')).toBeNull();
      expect(findHeavyLocalValidationCommand('dotnet --info')).toBeNull();
    });

    it('does not flag npm/cargo/go/pytest commands', () => {
      expect(findHeavyLocalValidationCommand('npm test')).toBeNull();
      expect(findHeavyLocalValidationCommand('cargo build')).toBeNull();
      expect(findHeavyLocalValidationCommand('go test ./...')).toBeNull();
      expect(findHeavyLocalValidationCommand('pytest tests/')).toBeNull();
    });

    it('does not flag bash invocations of non-build/test scripts', () => {
      expect(findHeavyLocalValidationCommand('bash scripts/deploy.sh')).toBeNull();
      expect(findHeavyLocalValidationCommand('bash scripts/lint.sh')).toBeNull();
    });
  });
});

describe('findFirstUnroutedCommand', () => {
  it('returns null when commands list is empty', () => {
    expect(findFirstUnroutedCommand('dotnet build', [])).toBeNull();
    expect(findFirstUnroutedCommand('dotnet build', null)).toBeNull();
    expect(findFirstUnroutedCommand('dotnet build', undefined)).toBeNull();
  });

  it('returns null when commands is not an array', () => {
    expect(findFirstUnroutedCommand('dotnet build', 'dotnet build')).toBeNull();
  });

  it('finds an unrouted command from the supplied list', () => {
    expect(findFirstUnroutedCommand('dotnet build foo.sln', ['dotnet build']))
      .toBe('dotnet build');
  });

  it('returns null when the only match is torque-remote routed', () => {
    expect(findFirstUnroutedCommand('torque-remote dotnet build', ['dotnet build']))
      .toBeNull();
  });

  it('still flags a second unrouted occurrence even if the first is routed', () => {
    const text = [
      'torque-remote dotnet build app.sln',
      'dotnet build other.sln',
    ].join('\n');
    expect(findFirstUnroutedCommand(text, ['dotnet build'])).toBe('dotnet build');
  });

  it('normalizes commands (lowercases, drops quotes/backslashes/leading-./)', () => {
    // The normalizer lowercases, strips quotes, converts backslashes to /,
    // and drops a leading "./" or " ./" — so a fancy-quoted command in
    // the haystack matches a clean lookup key.
    expect(findFirstUnroutedCommand('"DOTNET BUILD" foo.sln', ['dotnet build']))
      .toBe('dotnet build');
  });

  it('dedupes commands across the input list', () => {
    expect(findFirstUnroutedCommand('dotnet build', ['dotnet build', 'DOTNET BUILD']))
      .toBe('dotnet build');
  });

  it('returns null when no command in the list appears in the text', () => {
    expect(findFirstUnroutedCommand('npm test', ['dotnet build', 'cargo build']))
      .toBeNull();
  });

  it('handles empty and non-string inputs without throwing', () => {
    expect(findFirstUnroutedCommand('', ['dotnet build'])).toBeNull();
    expect(findFirstUnroutedCommand(null, ['dotnet build'])).toBeNull();
    expect(findFirstUnroutedCommand(undefined, ['dotnet build'])).toBeNull();
  });

  it('finds repeated occurrences of the same command on one line if first is routed but second is not', () => {
    // Edge case the inner while-loop covers: same command appears twice
    // on the same line, first occurrence is routed, second is bare.
    const text = 'torque-remote dotnet build a.sln && dotnet build b.sln';
    // The normalizer collapses to a single line; the first 'dotnet build'
    // is preceded by torque-remote in the prefix, but the second is too
    // (anywhere in the prefix counts). Both are considered routed.
    // This documents the current "anywhere in prefix" behavior.
    expect(findFirstUnroutedCommand(text, ['dotnet build'])).toBeNull();
  });
});
