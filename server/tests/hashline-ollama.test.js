'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { setupTestDb, teardownTestDb } = require('./vitest-setup');

// Import the functions under test
const {
  parseHashlineEdits,
  applyHashlineEdits,
  computeLineHash,
  HASHLINE_OLLAMA_SYSTEM_PROMPT
} = require('../task-manager');

describe('Hashline-Ollama Provider', () => {
  let tempDir;

  beforeAll(() => {
    setupTestDb('hashline-ollama');
    tempDir = path.join(os.tmpdir(), `torque-hashline-ollama-test-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterAll(() => {
    teardownTestDb();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ─── HASHLINE_OLLAMA_SYSTEM_PROMPT ──────────────────────────────────────

  describe('HASHLINE_OLLAMA_SYSTEM_PROMPT', () => {
    it('is a non-empty string', () => {
      expect(typeof HASHLINE_OLLAMA_SYSTEM_PROMPT).toBe('string');
      expect(HASHLINE_OLLAMA_SYSTEM_PROMPT.length).toBeGreaterThan(100);
    });

    it('contains HASHLINE_EDIT instructions', () => {
      expect(HASHLINE_OLLAMA_SYSTEM_PROMPT).toContain('HASHLINE_EDIT');
      expect(HASHLINE_OLLAMA_SYSTEM_PROMPT).toContain('REPLACE');
      expect(HASHLINE_OLLAMA_SYSTEM_PROMPT).toContain('DELETE');
      expect(HASHLINE_OLLAMA_SYSTEM_PROMPT).toContain('INSERT_BEFORE');
    });
  });

  // ─── parseHashlineEdits ─────────────────────────────────────────────────

  describe('parseHashlineEdits', () => {
    it('parses a single REPLACE block', () => {
      const output = `HASHLINE_EDIT src/utils.ts
REPLACE L005:a3 TO L007:f1
  function greet(name: string): string {
    return \`Hello, \${name}!\`;
  }
END_REPLACE`;

      const { edits, parseErrors } = parseHashlineEdits(output);
      expect(parseErrors).toHaveLength(0);
      expect(edits).toHaveLength(1);
      expect(edits[0].type).toBe('replace');
      expect(edits[0].filePath).toBe('src/utils.ts');
      expect(edits[0].startLine).toBe(5);
      expect(edits[0].startHash).toBe('a3');
      expect(edits[0].endLine).toBe(7);
      expect(edits[0].endHash).toBe('f1');
      expect(edits[0].newContent).toContain('function greet');
    });

    it('parses a single DELETE block', () => {
      const output = `HASHLINE_EDIT src/old.ts
DELETE L010:8f TO L015:a5
END_DELETE`;

      const { edits, parseErrors } = parseHashlineEdits(output);
      expect(parseErrors).toHaveLength(0);
      expect(edits).toHaveLength(1);
      expect(edits[0].type).toBe('delete');
      expect(edits[0].startLine).toBe(10);
      expect(edits[0].startHash).toBe('8f');
      expect(edits[0].endLine).toBe(15);
      expect(edits[0].endHash).toBe('a5');
      expect(edits[0].newContent).toBe('');
    });

    it('parses a single INSERT_BEFORE block', () => {
      const output = `HASHLINE_EDIT src/main.ts
INSERT_BEFORE L001:b2
import { Logger } from './logger';
END_INSERT`;

      const { edits, parseErrors } = parseHashlineEdits(output);
      expect(parseErrors).toHaveLength(0);
      expect(edits).toHaveLength(1);
      expect(edits[0].type).toBe('insert_before');
      expect(edits[0].startLine).toBe(1);
      expect(edits[0].startHash).toBe('b2');
      expect(edits[0].endLine).toBeUndefined();
      expect(edits[0].newContent).toContain("import { Logger }");
    });

    it('parses multiple blocks in one output', () => {
      const output = `HASHLINE_EDIT src/a.ts
REPLACE L001:aa TO L002:bb
const x = 1;
const y = 2;
END_REPLACE

HASHLINE_EDIT src/b.ts
DELETE L005:cc TO L006:dd
END_DELETE`;

      const { edits, parseErrors } = parseHashlineEdits(output);
      expect(parseErrors).toHaveLength(0);
      expect(edits).toHaveLength(2);
      expect(edits[0].filePath).toBe('src/a.ts');
      expect(edits[0].type).toBe('replace');
      expect(edits[1].filePath).toBe('src/b.ts');
      expect(edits[1].type).toBe('delete');
    });

    it('ignores explanatory text around blocks', () => {
      const output = `Sure, I'll modify that function for you.

HASHLINE_EDIT src/utils.ts
REPLACE L003:ab TO L003:ab
const fixed = true;
END_REPLACE

That should fix the issue!`;

      const { edits, parseErrors } = parseHashlineEdits(output);
      expect(parseErrors).toHaveLength(0);
      expect(edits).toHaveLength(1);
      expect(edits[0].newContent).toBe('const fixed = true;');
    });

    it('strips markdown code fences', () => {
      const output = "```\nHASHLINE_EDIT src/a.ts\nREPLACE L001:ab TO L001:ab\nconst x = 1;\nEND_REPLACE\n```";

      const { edits, parseErrors } = parseHashlineEdits(output);
      expect(parseErrors).toHaveLength(0);
      expect(edits).toHaveLength(1);
    });

    it('returns parseErrors for malformed blocks', () => {
      const output = `HASHLINE_EDIT src/a.ts
UNKNOWN_OP L001:ab TO L002:cd`;

      const { edits, parseErrors } = parseHashlineEdits(output);
      expect(edits).toHaveLength(0);
      expect(parseErrors.length).toBeGreaterThan(0);
      expect(parseErrors[0]).toContain('Unknown operation');
    });

    it('returns empty for no-edit output', () => {
      const output = 'The code looks good, no changes needed.';
      const { edits, parseErrors } = parseHashlineEdits(output);
      expect(edits).toHaveLength(0);
      expect(parseErrors).toHaveLength(0);
    });

    it('handles single-line REPLACE (start == end)', () => {
      const output = `HASHLINE_EDIT src/a.ts
REPLACE L005:ab TO L005:ab
const updated = true;
END_REPLACE`;

      const { edits } = parseHashlineEdits(output);
      expect(edits).toHaveLength(1);
      expect(edits[0].startLine).toBe(5);
      expect(edits[0].endLine).toBe(5);
    });

    it('preserves indentation in new content', () => {
      const output = `HASHLINE_EDIT src/a.ts
REPLACE L001:ab TO L002:cd
    if (true) {
      console.log('indented');
    }
END_REPLACE`;

      const { edits } = parseHashlineEdits(output);
      expect(edits).toHaveLength(1);
      expect(edits[0].newContent).toContain('    if (true) {');
      expect(edits[0].newContent).toContain("      console.log('indented');");
    });

    it('handles null/undefined/empty input', () => {
      expect(parseHashlineEdits(null).edits).toHaveLength(0);
      expect(parseHashlineEdits(undefined).edits).toHaveLength(0);
      expect(parseHashlineEdits('').edits).toHaveLength(0);
    });

    // ─── Fix 1: Trailing colons in line references (qwen2.5-coder style) ──

    it('handles trailing colons in REPLACE line refs', () => {
      const output = `HASHLINE_EDIT src/types.ts
REPLACE L001:ab: TO L003:cd:
/** Updated comment */
export enum Status {
END_REPLACE`;
      const { edits, parseErrors } = parseHashlineEdits(output);
      expect(parseErrors).toHaveLength(0);
      expect(edits).toHaveLength(1);
      expect(edits[0].type).toBe('replace');
      expect(edits[0].startHash).toBe('ab');
      expect(edits[0].endHash).toBe('cd');
    });

    it('handles trailing colons in INSERT_BEFORE line refs', () => {
      const output = `HASHLINE_EDIT src/types.ts
INSERT_BEFORE L001:ab:
/** A JSDoc comment */
END_INSERT`;
      const { edits, parseErrors } = parseHashlineEdits(output);
      expect(parseErrors).toHaveLength(0);
      expect(edits).toHaveLength(1);
      expect(edits[0].type).toBe('insert_before');
      expect(edits[0].startHash).toBe('ab');
    });

    it('handles trailing colons in DELETE line refs', () => {
      const output = `HASHLINE_EDIT src/types.ts
DELETE L005:ef: TO L008:12:
END_DELETE`;
      const { edits, parseErrors } = parseHashlineEdits(output);
      expect(parseErrors).toHaveLength(0);
      expect(edits).toHaveLength(1);
      expect(edits[0].type).toBe('delete');
      expect(edits[0].startHash).toBe('ef');
      expect(edits[0].endHash).toBe('12');
    });

    // ─── Fix 2: JSON-formatted edit blocks (deepseek-coder-v2 style) ─────

    it('parses JSON-formatted REPLACE blocks', () => {
      const output = `Here are the changes:
${JSON.stringify([{
  file_path: "src/types/voting.ts",
  blocks: [{
    type: "REPLACE",
    start: "L001:58",
    end: "L006:bf",
    content: ["/** Status enum */", "export enum ProposalStatus {", "  Open = \"Open\",", "}"]
  }]
}])}`;
      const { edits, parseErrors } = parseHashlineEdits(output);
      expect(edits).toHaveLength(1);
      expect(edits[0].type).toBe('replace');
      expect(edits[0].filePath).toBe('src/types/voting.ts');
      expect(edits[0].startLine).toBe(1);
      expect(edits[0].startHash).toBe('58');
      expect(edits[0].endLine).toBe(6);
      expect(edits[0].endHash).toBe('bf');
      expect(edits[0].newContent).toContain('/** Status enum */');
      expect(parseErrors.some(e => e.includes('[JSON fallback]'))).toBe(true);
    });

    it('parses JSON-formatted INSERT blocks', () => {
      const output = JSON.stringify([{
        file_path: "src/types.ts",
        blocks: [
          { type: "INSERT_BEFORE", start: "L001:ab", content: ["/** Comment */"] },
          { type: "INSERT", start: "L010:cd", content: ["/** Another */"] }
        ]
      }]);
      const { edits } = parseHashlineEdits(output);
      expect(edits).toHaveLength(2);
      expect(edits[0].type).toBe('insert_before');
      expect(edits[1].type).toBe('insert_before');
    });

    it('parses JSON single-object format (not wrapped in array)', () => {
      const output = JSON.stringify({
        file_path: "src/a.ts",
        blocks: [{ type: "REPLACE", start: "L005:aa", end: "L005:aa", content: ["const x = 1;"] }]
      });
      const { edits } = parseHashlineEdits(output);
      expect(edits).toHaveLength(1);
      expect(edits[0].startLine).toBe(5);
    });

    it('ignores invalid JSON gracefully', () => {
      const output = 'Not JSON { broken [';
      const { edits } = parseHashlineEdits(output);
      expect(edits).toHaveLength(0);
    });

    // ─── Fix 3: Full file rewrite in code fence (deepseek-r1 style) ───────

    it('detects full file rewrite in ts code fence', () => {
      const fileContent = `export enum Status {\n  Active = "active",\n  Inactive = "inactive",\n}\n\nexport interface User {\n  id: string;\n  name: string;\n  status: Status;\n  createdAt: number;\n  updatedAt: number;\n}`;
      const output = `I'll add JSDoc comments.\n\n\`\`\`ts\n${fileContent}\n\`\`\``;
      const { edits, fullFileContent } = parseHashlineEdits(output);
      expect(edits).toHaveLength(0);
      expect(fullFileContent).not.toBeNull();
      expect(fullFileContent).toContain('export enum Status');
      expect(fullFileContent).toContain('export interface User');
    });

    it('does not treat short code fence as full rewrite', () => {
      const output = `Here's the fix:\n\n\`\`\`ts\nconst x = 1;\nconst y = 2;\n\`\`\``;
      const { edits, fullFileContent } = parseHashlineEdits(output);
      expect(edits).toHaveLength(0);
      expect(fullFileContent).toBeNull();
    });

    it('does not trigger full rewrite when HASHLINE_EDIT blocks are found', () => {
      const output = `\`\`\`ts\nexport enum Foo { A = "a" }\nexport enum Bar { B = "b" }\nexport interface X { a: string }\nexport interface Y { b: string }\nexport interface Z { c: string }\nexport interface W { d: string }\nexport interface V { e: string }\nexport interface U { f: string }\nexport interface T { g: string }\nexport interface S { h: string }\n\`\`\`\n\nHASHLINE_EDIT src/a.ts\nINSERT_BEFORE L001:ab\n/** comment */\nEND_INSERT`;
      const { edits, fullFileContent } = parseHashlineEdits(output);
      expect(edits).toHaveLength(1);
      expect(fullFileContent).toBeNull();
    });

    it('returns fullFileContent as null when no code fence present', () => {
      const output = 'Just some text explanation, no code.';
      const { fullFileContent } = parseHashlineEdits(output);
      expect(fullFileContent).toBeNull();
    });
  });

  // ─── applyHashlineEdits ─────────────────────────────────────────────────

  describe('applyHashlineEdits', () => {
    function createTempFile(name, content) {
      const filePath = path.join(tempDir, name);
      fs.writeFileSync(filePath, content, 'utf8');
      return filePath;
    }

    function readTempFile(filePath) {
      return fs.readFileSync(filePath, 'utf8');
    }

    it('applies a single-line replacement', () => {
      const content = 'line one\nline two\nline three\n';
      const filePath = createTempFile('replace-single.txt', content);
      const hash2 = computeLineHash('line two');

      const result = applyHashlineEdits(filePath, [{
        type: 'replace',
        filePath,
        startLine: 2, startHash: hash2,
        endLine: 2, endHash: hash2,
        newContent: 'line TWO replaced'
      }]);

      expect(result.success).toBe(true);
      expect(result.linesRemoved).toBe(1);
      expect(result.linesAdded).toBe(1);
      expect(readTempFile(filePath)).toContain('line TWO replaced');
      expect(readTempFile(filePath)).toContain('line one');
      expect(readTempFile(filePath)).toContain('line three');
    });

    it('applies a multi-line range replacement', () => {
      const content = 'alpha\nbeta\ngamma\ndelta\nepsilon\n';
      const filePath = createTempFile('replace-multi.txt', content);
      const hash2 = computeLineHash('beta');
      const hash4 = computeLineHash('delta');

      const result = applyHashlineEdits(filePath, [{
        type: 'replace',
        filePath,
        startLine: 2, startHash: hash2,
        endLine: 4, endHash: hash4,
        newContent: 'REPLACED_LINE_1\nREPLACED_LINE_2'
      }]);

      expect(result.success).toBe(true);
      expect(result.linesRemoved).toBe(3);
      expect(result.linesAdded).toBe(2);
      const updated = readTempFile(filePath);
      expect(updated).toContain('alpha');
      expect(updated).toContain('REPLACED_LINE_1');
      expect(updated).toContain('REPLACED_LINE_2');
      expect(updated).toContain('epsilon');
      expect(updated).not.toContain('beta');
      expect(updated).not.toContain('gamma');
    });

    it('applies a deletion (removes lines)', () => {
      const content = 'keep1\ndelete1\ndelete2\nkeep2\n';
      const filePath = createTempFile('delete.txt', content);
      const hash2 = computeLineHash('delete1');
      const hash3 = computeLineHash('delete2');

      const result = applyHashlineEdits(filePath, [{
        type: 'delete',
        filePath,
        startLine: 2, startHash: hash2,
        endLine: 3, endHash: hash3,
        newContent: ''
      }]);

      expect(result.success).toBe(true);
      expect(result.linesRemoved).toBe(2);
      expect(result.linesAdded).toBe(0);
      const updated = readTempFile(filePath);
      expect(updated).toContain('keep1');
      expect(updated).toContain('keep2');
      expect(updated).not.toContain('delete1');
      expect(updated).not.toContain('delete2');
    });

    it('applies insert_before (adds lines without removing)', () => {
      const content = 'first\nsecond\nthird\n';
      const filePath = createTempFile('insert.txt', content);
      const hash2 = computeLineHash('second');

      const result = applyHashlineEdits(filePath, [{
        type: 'insert_before',
        filePath,
        startLine: 2, startHash: hash2,
        newContent: 'inserted_a\ninserted_b'
      }]);

      expect(result.success).toBe(true);
      expect(result.linesRemoved).toBe(0);
      expect(result.linesAdded).toBe(2);
      const lines = readTempFile(filePath).split('\n');
      expect(lines[0]).toBe('first');
      expect(lines[1]).toBe('inserted_a');
      expect(lines[2]).toBe('inserted_b');
      expect(lines[3]).toBe('second');
      expect(lines[4]).toBe('third');
    });

    it('applies multiple non-overlapping edits', () => {
      const content = 'line1\nline2\nline3\nline4\nline5\n';
      const filePath = createTempFile('multi-edit.txt', content);
      const hash2 = computeLineHash('line2');
      const hash4 = computeLineHash('line4');

      const result = applyHashlineEdits(filePath, [
        {
          type: 'replace',
          filePath,
          startLine: 2, startHash: hash2,
          endLine: 2, endHash: hash2,
          newContent: 'LINE_TWO'
        },
        {
          type: 'replace',
          filePath,
          startLine: 4, startHash: hash4,
          endLine: 4, endHash: hash4,
          newContent: 'LINE_FOUR'
        }
      ]);

      expect(result.success).toBe(true);
      const updated = readTempFile(filePath);
      expect(updated).toContain('LINE_TWO');
      expect(updated).toContain('LINE_FOUR');
      expect(updated).toContain('line1');
      expect(updated).toContain('line3');
      expect(updated).toContain('line5');
    });

    it('falls back to the cited line when the hash is stale', () => {
      const content = 'correct line\n';
      const filePath = createTempFile('stale-hash.txt', content);

      const result = applyHashlineEdits(filePath, [{
        type: 'replace',
        filePath,
        startLine: 1, startHash: 'zz',  // wrong hash
        endLine: 1, endHash: 'zz',
        newContent: 'updated'
      }]);

      expect(result.success).toBe(true);
      expect(result.fuzzyFixups).toBeGreaterThanOrEqual(1);
      expect(readTempFile(filePath)).toBe('updated\n');
    });

    it('rejects out-of-range line numbers', () => {
      const content = 'only line\n';
      const filePath = createTempFile('range.txt', content);
      const hash = computeLineHash('only line');

      const result = applyHashlineEdits(filePath, [{
        type: 'replace',
        filePath,
        startLine: 5, startHash: hash,
        endLine: 5, endHash: hash,
        newContent: 'nope'
      }]);

      expect(result.success).toBe(false);
      expect(result.error).toContain('out of range');
    });

    it('auto-merges abutting REPLACE edits that share a boundary line', () => {
      const content = 'a\nb\nc\nd\ne\n';
      const filePath = createTempFile('abutting.txt', content);
      const hashB = computeLineHash('b');
      const hashC = computeLineHash('c');
      const hashD = computeLineHash('d');

      const result = applyHashlineEdits(filePath, [
        {
          type: 'replace', filePath,
          startLine: 2, startHash: hashB,
          endLine: 3, endHash: hashC,
          newContent: 'new_bc'
        },
        {
          type: 'replace', filePath,
          startLine: 3, startHash: hashC,
          endLine: 4, endHash: hashD,
          newContent: 'new_cd'
        }
      ]);

      expect(result.success).toBe(true);
      const lines = fs.readFileSync(filePath, 'utf8').split('\n');
      // Lines 2-4 merged into one REPLACE with combined content
      expect(lines[0]).toBe('a');
      expect(lines[1]).toBe('new_bc');
      expect(lines[2]).toBe('new_cd');
      expect(lines[3]).toBe('e');
    });

    it('rejects truly overlapping edits (not just abutting)', () => {
      const content = 'a\nb\nc\nd\ne\nf\n';
      const filePath = createTempFile('overlap.txt', content);
      const hashB = computeLineHash('b');
      const hashD = computeLineHash('d');
      const _hashE = computeLineHash('e');
      const hashF = computeLineHash('f');

      const result = applyHashlineEdits(filePath, [
        {
          type: 'replace', filePath,
          startLine: 2, startHash: hashB,
          endLine: 4, endHash: hashD,
          newContent: 'new1'
        },
        {
          type: 'replace', filePath,
          startLine: 4, startHash: hashD,
          endLine: 6, endHash: hashF,
          newContent: 'new2'
        }
      ]);

      // These abut at line 4, so they should auto-merge
      expect(result.success).toBe(true);
    });

    it('rejects deeply overlapping edits', () => {
      const content = 'a\nb\nc\nd\ne\nf\n';
      const filePath = createTempFile('deep-overlap.txt', content);
      const hashB = computeLineHash('b');
      const hashC = computeLineHash('c');
      const _hashE = computeLineHash('e');
      const hashF = computeLineHash('f');

      const result = applyHashlineEdits(filePath, [
        {
          type: 'replace', filePath,
          startLine: 2, startHash: hashB,
          endLine: 5, endHash: computeLineHash('e'),
          newContent: 'new1'
        },
        {
          type: 'replace', filePath,
          startLine: 3, startHash: hashC,
          endLine: 6, endHash: hashF,
          newContent: 'new2'
        }
      ]);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Overlapping');
    });

    it('writes to disk correctly', () => {
      const content = 'original content\nline two\n';
      const filePath = createTempFile('disk-write.txt', content);
      const hash1 = computeLineHash('original content');

      applyHashlineEdits(filePath, [{
        type: 'replace', filePath,
        startLine: 1, startHash: hash1,
        endLine: 1, endHash: hash1,
        newContent: 'modified content'
      }]);

      // Verify the file was actually written
      const onDisk = fs.readFileSync(filePath, 'utf8');
      expect(onDisk).toBe('modified content\nline two\n');
    });

    it('returns success with zero counts for empty edits array', () => {
      const filePath = createTempFile('empty-edits.txt', 'content\n');
      const result = applyHashlineEdits(filePath, []);
      expect(result.success).toBe(true);
      expect(result.linesRemoved).toBe(0);
      expect(result.linesAdded).toBe(0);
    });
  });

  // ─── Smart Routing → hashline-ollama ────────────────────────────────────

  describe('smart routing upgrade to hashline-ollama', () => {
    const db = require('../database');

    it('classifies targeted file edits as simple', () => {
      const complexity = db.determineTaskComplexity(
        'Add a JSDoc comment to getCreditAdvantage in src/systems/CreditBureauSystem.ts'
      );
      expect(['simple', 'normal']).toContain(complexity);
    });

    it('classifies multi-file refactors as complex', () => {
      const complexity = db.determineTaskComplexity(
        'Refactor the authentication system and wire it into the middleware'
      );
      expect(complexity).toBe('complex');
    });

    it('classifies add-comment tasks as simple or normal', () => {
      const complexity = db.determineTaskComplexity(
        'Add JSDoc comment to the getData method in src/utils.ts'
      );
      // Both simple and normal are eligible for hashline-ollama upgrade
      expect(['simple', 'normal']).toContain(complexity);
    });

    it('classifies rename tasks as simple', () => {
      const complexity = db.determineTaskComplexity(
        'Rename the fetchData function in src/api.ts to loadData'
      );
      expect(complexity).toBe('simple');
    });

    it('classifies implement-system tasks as complex', () => {
      const complexity = db.determineTaskComplexity(
        'Implement the notification system with email and SMS support'
      );
      expect(complexity).toBe('complex');
    });

    it('classifies fix-typo with file ref as simple', () => {
      const complexity = db.determineTaskComplexity(
        'Fix the typo in src/utils.ts'
      );
      expect(complexity).toBe('simple');
    });

    it('classifies add-test tasks as normal', () => {
      const complexity = db.determineTaskComplexity(
        'Write a unit test for the calculateTotal function in src/billing.ts'
      );
      expect(complexity).toBe('normal');
    });
  });
});
