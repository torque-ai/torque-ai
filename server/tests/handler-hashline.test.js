const path = require('path');
const os = require('os');
const fs = require('fs');

const TEMPLATE_BUF = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');

let templateBuffer;
let db;
let handleToolCall;
let tempDir;
let tempFilePath;

function getText(result) {
  return result?.content?.[0]?.text || '';
}

beforeAll(() => {
  templateBuffer = fs.readFileSync(TEMPLATE_BUF);
  db = require('../database');
  db.resetForTest(templateBuffer);
  handleToolCall = require('../tools').handleToolCall;
  tempDir = path.join(os.tmpdir(), 'torque-hashline-handler-tests');
  fs.mkdirSync(tempDir, { recursive: true });
});

beforeEach(() => {
  db.resetForTest(templateBuffer);
  tempFilePath = path.join(
    tempDir,
    `hashline-handler-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`
  );
  fs.writeFileSync(tempFilePath, '');
});

afterAll(() => {
  try {
    db.close();
  } catch {
    // ignore
  }
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('hashline handlers via handleToolCall', () => {
  describe('hashline_read', () => {
    it('reads a file with line:hash annotations', async () => {
      fs.writeFileSync(tempFilePath, 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
      const result = await handleToolCall('hashline_read', { file_path: tempFilePath });

      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toMatch(/1:[a-f0-9]{2}\tconst a = 1;/);
      expect(text).toMatch(/2:[a-f0-9]{2}\tconst b = 2;/);
      expect(text).toMatch(/3:[a-f0-9]{2}\tconst c = 3;/);
    });

    it('supports offset and limit', async () => {
      fs.writeFileSync(tempFilePath, 'line1\nline2\nline3\nline4\nline5\n');
      const result = await handleToolCall('hashline_read', { file_path: tempFilePath, offset: 2, limit: 2 });

      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('line2');
      expect(text).toContain('line3');
      expect(text).not.toContain('line1');
      expect(text).not.toContain('line4');
    });

    it('returns deterministic hashes for same content', async () => {
      fs.writeFileSync(tempFilePath, 'hello world\n');
      const r1 = await handleToolCall('hashline_read', { file_path: tempFilePath });
      const r2 = await handleToolCall('hashline_read', { file_path: tempFilePath });

      expect(getText(r1)).toEqual(getText(r2));
    });

    it('produces different hashes for different content', async () => {
      fs.writeFileSync(tempFilePath, 'aaa\nbbb\n');
      const result = await handleToolCall('hashline_read', { file_path: tempFilePath });

      const text = getText(result);
      const hashes = text.match(/:[a-f0-9]{2}\t/g);
      expect(hashes).toHaveLength(3); // 2 content lines + empty trailing
      expect(hashes[0]).not.toEqual(hashes[1]);
    });

    it('rejects missing file_path', async () => {
      const result = await handleToolCall('hashline_read', {});
      expect(result.isError).toBe(true);
    });

    it('rejects nonexistent file', async () => {
      const result = await handleToolCall('hashline_read', { file_path: '/nonexistent/file.ts' });
      expect(result.isError).toBe(true);
    });

    it('shows total line count in header', async () => {
      fs.writeFileSync(tempFilePath, 'a\nb\nc\nd\ne\n');
      const result = await handleToolCall('hashline_read', { file_path: tempFilePath });

      const text = getText(result);
      expect(text).toContain('6 lines');
    });
  });

  describe('hashline_edit', () => {
    it('replaces a single line by hash reference', async () => {
      fs.writeFileSync(tempFilePath, 'const x = 1;\nconst y = 2;\nconst z = 3;\n');
      const readResult = await handleToolCall('hashline_read', { file_path: tempFilePath });

      const text = getText(readResult);
      const match = text.match(/2:([a-f0-9]{2})\tconst y = 2;/);
      expect(match).toBeTruthy();
      const hash = match[1];

      const editResult = await handleToolCall('hashline_edit', {
        file_path: tempFilePath,
        edits: [{ start_line: 2, start_hash: hash, new_content: 'const y = 42;' }],
      });

      expect(editResult.isError).toBeFalsy();

      const content = fs.readFileSync(tempFilePath, 'utf8');
      expect(content).toContain('const y = 42;');
      expect(content).toContain('const x = 1;');
      expect(content).toContain('const z = 3;');
    });

    it('replaces a range of lines', async () => {
      fs.writeFileSync(tempFilePath, 'line1\nline2\nline3\nline4\nline5\n');
      const readResult = await handleToolCall('hashline_read', { file_path: tempFilePath });

      const text = getText(readResult);
      const startMatch = text.match(/2:([a-f0-9]{2})\tline2/);
      const endMatch = text.match(/4:([a-f0-9]{2})\tline4/);
      expect(startMatch).toBeTruthy();
      expect(endMatch).toBeTruthy();

      const editResult = await handleToolCall('hashline_edit', {
        file_path: tempFilePath,
        edits: [{
          start_line: 2,
          start_hash: startMatch[1],
          end_line: 4,
          end_hash: endMatch[1],
          new_content: 'replaced_a\nreplaced_b',
        }],
      });

      expect(editResult.isError).toBeFalsy();
      const content = fs.readFileSync(tempFilePath, 'utf8');
      expect(content).toBe('line1\nreplaced_a\nreplaced_b\nline5\n');
    });

    it('deletes lines with empty new_content', async () => {
      fs.writeFileSync(tempFilePath, 'keep\ndelete_me\nkeep_too\n');
      const readResult = await handleToolCall('hashline_read', { file_path: tempFilePath });

      const text = getText(readResult);
      const match = text.match(/2:([a-f0-9]{2})\tdelete_me/);
      expect(match).toBeTruthy();

      const editResult = await handleToolCall('hashline_edit', {
        file_path: tempFilePath,
        edits: [{ start_line: 2, start_hash: match[1], new_content: '' }],
      });

      expect(editResult.isError).toBeFalsy();
      const content = fs.readFileSync(tempFilePath, 'utf8');
      expect(content).toBe('keep\nkeep_too\n');
    });

    it('applies multiple edits bottom-to-top', async () => {
      fs.writeFileSync(tempFilePath, 'a\nb\nc\nd\ne\n');
      const readResult = await handleToolCall('hashline_read', { file_path: tempFilePath });

      const text = getText(readResult);
      const hashB = text.match(/2:([a-f0-9]{2})\tb/)[1];
      const hashD = text.match(/4:([a-f0-9]{2})\td/)[1];

      const editResult = await handleToolCall('hashline_edit', {
        file_path: tempFilePath,
        edits: [
          { start_line: 2, start_hash: hashB, new_content: 'B' },
          { start_line: 4, start_hash: hashD, new_content: 'D' },
        ],
      });

      expect(editResult.isError).toBeFalsy();
      const content = fs.readFileSync(tempFilePath, 'utf8');
      expect(content).toBe('a\nB\nc\nD\ne\n');
    });

    it('rejects stale hashes', async () => {
      fs.writeFileSync(tempFilePath, 'original\n');
      await handleToolCall('hashline_read', { file_path: tempFilePath });
      fs.writeFileSync(tempFilePath, 'modified\n');

      const editResult = await handleToolCall('hashline_edit', {
        file_path: tempFilePath,
        edits: [{ start_line: 1, start_hash: 'xx', new_content: 'new' }],
      });

      expect(editResult.isError).toBe(true);
      expect(getText(editResult).toLowerCase()).toContain('stale hash');
    });

    it('rejects overlapping edits', async () => {
      fs.writeFileSync(tempFilePath, 'a\nb\nc\nd\n');
      const readResult = await handleToolCall('hashline_read', { file_path: tempFilePath });

      const text = getText(readResult);
      const hashA = text.match(/1:([a-f0-9]{2})\ta/)[1];
      const hashB = text.match(/2:([a-f0-9]{2})\tb/)[1];
      const hashC = text.match(/3:([a-f0-9]{2})\tc/)[1];

      const editResult = await handleToolCall('hashline_edit', {
        file_path: tempFilePath,
        edits: [
          { start_line: 1, start_hash: hashA, end_line: 2, end_hash: hashB, new_content: 'AB' },
          { start_line: 2, start_hash: hashB, end_line: 3, end_hash: hashC, new_content: 'BC' },
        ],
      });

      expect(editResult.isError).toBe(true);
      expect(getText(editResult).toLowerCase()).toContain('overlapping');
    });

    it('rejects missing required params', async () => {
      const result = await handleToolCall('hashline_edit', {});
      expect(result.isError).toBe(true);
    });

    it('rejects empty edits array', async () => {
      fs.writeFileSync(tempFilePath, 'content\n');
      const result = await handleToolCall('hashline_edit', { file_path: tempFilePath, edits: [] });

      expect(result.isError).toBe(true);
    });

    it('rejects out-of-range line numbers', async () => {
      fs.writeFileSync(tempFilePath, 'only one line\n');
      await handleToolCall('hashline_read', { file_path: tempFilePath });

      const result = await handleToolCall('hashline_edit', {
        file_path: tempFilePath,
        edits: [{ start_line: 99, start_hash: 'ff', new_content: 'nope' }],
      });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('out of range');
    });

    it('returns fresh hashes after edit for verification', async () => {
      fs.writeFileSync(tempFilePath, 'old_content\n');
      const readResult = await handleToolCall('hashline_read', { file_path: tempFilePath });

      const hash = getText(readResult).match(/1:([a-f0-9]{2})\told_content/)[1];
      const editResult = await handleToolCall('hashline_edit', {
        file_path: tempFilePath,
        edits: [{ start_line: 1, start_hash: hash, new_content: 'new_content' }],
      });

      expect(editResult.isError).toBeFalsy();
      const editText = getText(editResult);
      expect(editText).toMatch(/1:[a-f0-9]{2}\tnew_content/);
    });
  });
});
