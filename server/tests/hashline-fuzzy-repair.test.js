'use strict';

/**
 * Unit Tests: fuzzy repair with multiple SEARCH/REPLACE blocks
 *
 * Specifically exercises the reverse-order splice fix: when two blocks are
 * applied and the first (by line number) changes the line count, the second
 * block's index must not be shifted by the earlier splice.
 */

const fs = require('fs');

describe('attemptFuzzySearchRepair — multi-block index stability', () => {
  let hashlineVerify;
  let mockLineSimilarity;

  beforeEach(() => {
    hashlineVerify = require('../validation/hashline-verify');

    // Return perfect similarity so every block matches wherever it is tried,
    // but we control which line it "best" matches by returning 1.0 only for
    // the real location (via the mock implementation below).
    mockLineSimilarity = vi.fn().mockReturnValue(1.0);

    hashlineVerify.init({
      computeLineHash: vi.fn((_line) => '00'),
      getFileChangesForValidation: vi.fn().mockReturnValue([]),
      lineSimilarity: mockLineSimilarity,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * File layout (0-indexed):
   *   Line 0: "alpha"
   *   Line 1: "bravo"          ← BLOCK A searches for this (1 line → 2 lines in replace)
   *   Line 2: "charlie"
   *   Line 3: "delta"          ← BLOCK B searches for this
   *   Line 4: "echo"
   *
   * Block A: replace "bravo" with "bravo-1\nbravo-2" (adds 1 line — shifts indices below it by +1)
   * Block B: replace "delta" with "delta-new"
   *
   * After correct (reverse-order) application:
   *   Apply block B first (line 3): "delta" → "delta-new"
   *   Apply block A next (line 1):  "bravo" → "bravo-1\nbravo-2"
   *
   * Expected final file:
   *   "alpha\nbravo-1\nbravo-2\ncharlie\ndelta-new\necho"
   */
  it('applies two blocks correctly when the first adds lines', () => {
    const fileContent = 'alpha\nbravo\ncharlie\ndelta\necho';

    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(fileContent);
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

    // lineSimilarity returns 1.0 when the search line matches the file line
    // exactly, and 0.0 otherwise — mimics real content matching.
    mockLineSimilarity.mockImplementation((searchLine, fileLine) =>
      searchLine === fileLine ? 1.0 : 0.0
    );

    const output = `FAILED to apply edit to src/app.ts
<<<<<<< SEARCH
bravo
=======
bravo-1
bravo-2
>>>>>>> REPLACE
<<<<<<< SEARCH
delta
=======
delta-new
>>>>>>> REPLACE`;

    const result = hashlineVerify.attemptFuzzySearchRepair('task-multi', output, '/project');

    expect(result.repaired).toBe(true);
    expect(result.file).toBe('src/app.ts');

    const writtenContent = writeSpy.mock.calls[0][1];
    const writtenLines = writtenContent.split('\n');

    expect(writtenLines).toEqual(['alpha', 'bravo-1', 'bravo-2', 'charlie', 'delta-new', 'echo']);
  });

  /**
   * Same scenario but the first block (by line position) *removes* a line
   * (replace is shorter than search).
   *
   * File layout:
   *   Line 0: "alpha"
   *   Line 1: "bravo"
   *   Line 2: "charlie"        ← BLOCK A: "charlie\ndelta" → "cd" (removes 1 line)
   *   Line 3: "delta"
   *   Line 4: "echo"           ← BLOCK B: "echo" → "echo-new"
   *
   * Reverse order: apply block B (line 4) first, then block A (line 2).
   * Expected: "alpha\nbravo\ncd\necho-new"
   */
  it('applies two blocks correctly when the first removes lines', () => {
    const fileContent = 'alpha\nbravo\ncharlie\ndelta\necho';

    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(fileContent);
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

    mockLineSimilarity.mockImplementation((searchLine, fileLine) =>
      searchLine === fileLine ? 1.0 : 0.0
    );

    const output = `FAILED to apply edit to src/app.ts
<<<<<<< SEARCH
charlie
delta
=======
cd
>>>>>>> REPLACE
<<<<<<< SEARCH
echo
=======
echo-new
>>>>>>> REPLACE`;

    const result = hashlineVerify.attemptFuzzySearchRepair('task-remove', output, '/project');

    expect(result.repaired).toBe(true);

    const writtenContent = writeSpy.mock.calls[0][1];
    const writtenLines = writtenContent.split('\n');

    expect(writtenLines).toEqual(['alpha', 'bravo', 'cd', 'echo-new']);
  });
});
