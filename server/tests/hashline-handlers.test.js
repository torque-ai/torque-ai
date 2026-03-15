const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');
const path = require('path');
const os = require('os');
const fs = require('fs');

describe('Hashline Handlers', () => {
  let tempDir;

  beforeAll(() => {
    setupTestDb('hashline');
    tempDir = path.join(os.tmpdir(), `torque-hashline-test-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterAll(() => {
    teardownTestDb();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ─── hashline_read ──────────────────────────────────────────────────────

  describe('hashline_read', () => {
    it('reads a file with line:hash annotations', async () => {
      const filePath = path.join(tempDir, 'read-test.ts');
      fs.writeFileSync(filePath, 'const a = 1;\nconst b = 2;\nconst c = 3;\n');

      const result = await safeTool('hashline_read', { file_path: filePath });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      // Should contain line numbers and 2-char hashes
      expect(text).toMatch(/1:[a-f0-9]{2}\tconst a = 1;/);
      expect(text).toMatch(/2:[a-f0-9]{2}\tconst b = 2;/);
      expect(text).toMatch(/3:[a-f0-9]{2}\tconst c = 3;/);
    });

    it('supports offset and limit', async () => {
      const filePath = path.join(tempDir, 'offset-test.ts');
      fs.writeFileSync(filePath, 'line1\nline2\nline3\nline4\nline5\n');

      const result = await safeTool('hashline_read', {
        file_path: filePath,
        offset: 2,
        limit: 2,
      });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('line2');
      expect(text).toContain('line3');
      expect(text).not.toContain('line1');
      expect(text).not.toContain('line4');
    });

    it('returns deterministic hashes for same content', async () => {
      const filePath = path.join(tempDir, 'deterministic.ts');
      fs.writeFileSync(filePath, 'hello world\n');

      const r1 = await safeTool('hashline_read', { file_path: filePath });
      const r2 = await safeTool('hashline_read', { file_path: filePath });
      expect(getText(r1)).toEqual(getText(r2));
    });

    it('produces different hashes for different content', async () => {
      const filePath = path.join(tempDir, 'diff-hash.ts');
      fs.writeFileSync(filePath, 'aaa\nbbb\n');

      const result = await safeTool('hashline_read', { file_path: filePath });
      const text = getText(result);
      const hashes = text.match(/:[a-f0-9]{2}\t/g);
      expect(hashes).toHaveLength(3); // 2 content lines + empty trailing
      // aaa and bbb should have different hashes
      expect(hashes[0]).not.toEqual(hashes[1]);
    });

    it('rejects missing file_path', async () => {
      const result = await safeTool('hashline_read', {});
      expect(result.isError).toBe(true);
    });

    it('rejects nonexistent file', async () => {
      const result = await safeTool('hashline_read', { file_path: '/nonexistent/file.ts' });
      expect(result.isError).toBe(true);
    });

    it('shows total line count in header', async () => {
      const filePath = path.join(tempDir, 'linecount.ts');
      fs.writeFileSync(filePath, 'a\nb\nc\nd\ne\n');

      const result = await safeTool('hashline_read', { file_path: filePath });
      const text = getText(result);
      expect(text).toContain('6 lines');
    });
  });

  // ─── hashline_edit ──────────────────────────────────────────────────────

  describe('hashline_edit', () => {
    it('replaces a single line by hash reference', async () => {
      const filePath = path.join(tempDir, 'edit-single.ts');
      fs.writeFileSync(filePath, 'const x = 1;\nconst y = 2;\nconst z = 3;\n');

      // Read to get hashes
      const readResult = await safeTool('hashline_read', { file_path: filePath });
      const text = getText(readResult);
      // Extract line 2 hash
      const match = text.match(/2:([a-f0-9]{2})\tconst y = 2;/);
      expect(match).toBeTruthy();
      const hash = match[1];

      // Edit line 2
      const editResult = await safeTool('hashline_edit', {
        file_path: filePath,
        edits: [{ start_line: 2, start_hash: hash, new_content: 'const y = 42;' }],
      });
      expect(editResult.isError).toBeFalsy();

      // Verify file on disk
      const content = fs.readFileSync(filePath, 'utf8');
      expect(content).toContain('const y = 42;');
      expect(content).toContain('const x = 1;');
      expect(content).toContain('const z = 3;');
    });

    it('replaces a range of lines', async () => {
      const filePath = path.join(tempDir, 'edit-range.ts');
      fs.writeFileSync(filePath, 'line1\nline2\nline3\nline4\nline5\n');

      const readResult = await safeTool('hashline_read', { file_path: filePath });
      const text = getText(readResult);
      const startMatch = text.match(/2:([a-f0-9]{2})\tline2/);
      const endMatch = text.match(/4:([a-f0-9]{2})\tline4/);
      expect(startMatch).toBeTruthy();
      expect(endMatch).toBeTruthy();

      const editResult = await safeTool('hashline_edit', {
        file_path: filePath,
        edits: [{
          start_line: 2, start_hash: startMatch[1],
          end_line: 4, end_hash: endMatch[1],
          new_content: 'replaced_a\nreplaced_b',
        }],
      });
      expect(editResult.isError).toBeFalsy();

      const content = fs.readFileSync(filePath, 'utf8');
      expect(content).toBe('line1\nreplaced_a\nreplaced_b\nline5\n');
    });

    it('deletes lines with empty new_content', async () => {
      const filePath = path.join(tempDir, 'edit-delete.ts');
      fs.writeFileSync(filePath, 'keep\ndelete_me\nkeep_too\n');

      const readResult = await safeTool('hashline_read', { file_path: filePath });
      const text = getText(readResult);
      const match = text.match(/2:([a-f0-9]{2})\tdelete_me/);
      expect(match).toBeTruthy();

      const editResult = await safeTool('hashline_edit', {
        file_path: filePath,
        edits: [{ start_line: 2, start_hash: match[1], new_content: '' }],
      });
      expect(editResult.isError).toBeFalsy();

      const content = fs.readFileSync(filePath, 'utf8');
      expect(content).toBe('keep\nkeep_too\n');
    });

    it('applies multiple edits bottom-to-top', async () => {
      const filePath = path.join(tempDir, 'edit-multi.ts');
      fs.writeFileSync(filePath, 'a\nb\nc\nd\ne\n');

      const readResult = await safeTool('hashline_read', { file_path: filePath });
      const text = getText(readResult);
      const hashB = text.match(/2:([a-f0-9]{2})\tb/)[1];
      const hashD = text.match(/4:([a-f0-9]{2})\td/)[1];

      const editResult = await safeTool('hashline_edit', {
        file_path: filePath,
        edits: [
          { start_line: 2, start_hash: hashB, new_content: 'B' },
          { start_line: 4, start_hash: hashD, new_content: 'D' },
        ],
      });
      expect(editResult.isError).toBeFalsy();

      const content = fs.readFileSync(filePath, 'utf8');
      expect(content).toBe('a\nB\nc\nD\ne\n');
    });

    it('rejects stale hashes', async () => {
      const filePath = path.join(tempDir, 'stale-hash.ts');
      fs.writeFileSync(filePath, 'original\n');

      // Read to cache
      await safeTool('hashline_read', { file_path: filePath });

      // Modify file behind the cache's back
      fs.writeFileSync(filePath, 'modified\n');

      const editResult = await safeTool('hashline_edit', {
        file_path: filePath,
        edits: [{ start_line: 1, start_hash: 'xx', new_content: 'new' }],
      });
      expect(editResult.isError).toBe(true);
      expect(getText(editResult).toLowerCase()).toContain('stale hash');
    });

    it('rejects overlapping edits', async () => {
      const filePath = path.join(tempDir, 'overlap.ts');
      fs.writeFileSync(filePath, 'a\nb\nc\nd\n');

      const readResult = await safeTool('hashline_read', { file_path: filePath });
      const text = getText(readResult);
      const hashA = text.match(/1:([a-f0-9]{2})\ta/)[1];
      const hashB = text.match(/2:([a-f0-9]{2})\tb/)[1];
      const hashC = text.match(/3:([a-f0-9]{2})\tc/)[1];

      const editResult = await safeTool('hashline_edit', {
        file_path: filePath,
        edits: [
          { start_line: 1, start_hash: hashA, end_line: 2, end_hash: hashB, new_content: 'AB' },
          { start_line: 2, start_hash: hashB, end_line: 3, end_hash: hashC, new_content: 'BC' },
        ],
      });
      expect(editResult.isError).toBe(true);
      expect(getText(editResult).toLowerCase()).toContain('overlapping');
    });

    it('rejects missing required params', async () => {
      const result = await safeTool('hashline_edit', {});
      expect(result.isError).toBe(true);
    });

    it('rejects empty edits array', async () => {
      const filePath = path.join(tempDir, 'empty-edits.ts');
      fs.writeFileSync(filePath, 'content\n');

      const result = await safeTool('hashline_edit', { file_path: filePath, edits: [] });
      expect(result.isError).toBe(true);
    });

    it('rejects out-of-range line numbers', async () => {
      const filePath = path.join(tempDir, 'out-of-range.ts');
      fs.writeFileSync(filePath, 'only one line\n');

      await safeTool('hashline_read', { file_path: filePath });

      const result = await safeTool('hashline_edit', {
        file_path: filePath,
        edits: [{ start_line: 99, start_hash: 'ff', new_content: 'nope' }],
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('out of range');
    });

    it('returns fresh hashes after edit for verification', async () => {
      const filePath = path.join(tempDir, 'fresh-hashes.ts');
      fs.writeFileSync(filePath, 'old_content\n');

      const readResult = await safeTool('hashline_read', { file_path: filePath });
      const hash = getText(readResult).match(/1:([a-f0-9]{2})\told_content/)[1];

      const editResult = await safeTool('hashline_edit', {
        file_path: filePath,
        edits: [{ start_line: 1, start_hash: hash, new_content: 'new_content' }],
      });
      expect(editResult.isError).toBeFalsy();
      const editText = getText(editResult);
      // Should show new hash for the replaced content
      expect(editText).toMatch(/1:[a-f0-9]{2}\tnew_content/);
    });
  });
});
