'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Tail } = require('../utils/file-tail');

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-tail-'));
  return path.join(dir, name);
}

function waitFor(predicate, timeoutMs = 2000, stepMs = 25) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const loop = () => {
      try {
        if (predicate()) return resolve();
      } catch (err) { return reject(err); }
      if (Date.now() - start >= timeoutMs) {
        return reject(new Error('waitFor timed out'));
      }
      setTimeout(loop, stepMs);
    };
    loop();
  });
}

describe('Tail', () => {
  it('emits chunks for new bytes appended after start', async () => {
    const file = tmpFile('basic.log');
    fs.writeFileSync(file, ''); // create empty
    const t = new Tail(file, { pollIntervalMs: 25 });
    const chunks = [];
    t.on('chunk', (text, offset) => chunks.push({ text, offset }));
    t.start();
    try {
      fs.appendFileSync(file, 'hello ');
      fs.appendFileSync(file, 'world');
      await waitFor(() => chunks.length >= 1);
      // Combined text is 'hello world' in some chunking. Order preserved.
      const combined = chunks.map((c) => c.text).join('');
      expect(combined).toBe('hello world');
      // Offsets are monotonically non-decreasing and end at file size.
      const finalOffset = chunks[chunks.length - 1].offset;
      expect(finalOffset).toBe(fs.statSync(file).size);
      expect(t.getOffset()).toBe(finalOffset);
    } finally {
      t.stop();
    }
  });

  it('resumes from startOffset, skipping already-consumed bytes', async () => {
    const file = tmpFile('resume.log');
    fs.writeFileSync(file, 'aaaaBBB');
    // Resume at offset 4 — we already "consumed" the 'aaaa' prefix.
    const t = new Tail(file, { startOffset: 4, pollIntervalMs: 25 });
    const chunks = [];
    t.on('chunk', (text) => chunks.push(text));
    t.start();
    try {
      await waitFor(() => chunks.length >= 1);
      expect(chunks.join('')).toBe('BBB');
    } finally {
      t.stop();
    }
  });

  it('handles file truncation by resetting to offset 0', async () => {
    const file = tmpFile('truncate.log');
    fs.writeFileSync(file, 'a longer first line');
    const t = new Tail(file, { pollIntervalMs: 25 });
    const chunks = [];
    t.on('chunk', (text) => chunks.push(text));
    t.start();
    try {
      await waitFor(() => chunks.join('').includes('a longer first line'));
      // Truncate to a size strictly smaller than the previous read
      // offset. The tailer's next stat() sees stat.size < this.offset
      // and resets to 0, then reads the full new contents from the
      // start.
      fs.truncateSync(file, 0);
      fs.writeFileSync(file, 'short');
      await waitFor(() => chunks.join('').endsWith('short'), 1500);
      expect(chunks.join('')).toBe('a longer first lineshort');
    } finally {
      t.stop();
    }
  });

  it('waits silently when the file does not exist yet (startup race)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-tail-startup-'));
    const file = path.join(dir, 'late.log');
    const t = new Tail(file, { pollIntervalMs: 25 });
    const errors = [];
    const chunks = [];
    t.on('error', (err) => errors.push(err));
    t.on('chunk', (text) => chunks.push(text));
    t.start();
    try {
      // 100 ms with no file in place — no errors should fire.
      await new Promise((r) => setTimeout(r, 100));
      expect(errors).toHaveLength(0);
      // Now create the file. Tailer should pick it up.
      fs.writeFileSync(file, 'late content');
      await waitFor(() => chunks.length >= 1);
      expect(chunks.join('')).toBe('late content');
    } finally {
      t.stop();
    }
  });

  it('emits error and stops when the file is deleted after being seen', async () => {
    const file = tmpFile('delete.log');
    fs.writeFileSync(file, 'first');
    const t = new Tail(file, { pollIntervalMs: 25 });
    const chunks = [];
    const errors = [];
    t.on('chunk', (text) => chunks.push(text));
    t.on('error', (err) => errors.push(err));
    t.start();
    try {
      await waitFor(() => chunks.length >= 1);
      fs.unlinkSync(file);
      await waitFor(() => errors.length >= 1, 1000);
      expect(errors[0].code).toBe('ENOENT');
    } finally {
      t.stop();
    }
  });

  it('rejects an empty filePath', () => {
    expect(() => new Tail('')).toThrow(/non-empty filePath/);
    expect(() => new Tail(null)).toThrow(/non-empty filePath/);
  });

  it('honors a custom poll interval', async () => {
    const file = tmpFile('cadence.log');
    fs.writeFileSync(file, '');
    const t = new Tail(file, { pollIntervalMs: 200 });
    const chunks = [];
    t.on('chunk', (text) => chunks.push(text));
    t.start();
    try {
      // Fire-and-forget setImmediate poll runs first; we should see
      // the initial empty-file poll within ~50 ms but no chunks until
      // the writer appends.
      await new Promise((r) => setTimeout(r, 50));
      expect(chunks).toHaveLength(0);
      fs.appendFileSync(file, 'x');
      // The next poll fires at +200 ms after start.
      await waitFor(() => chunks.length >= 1, 600);
      expect(chunks.join('')).toBe('x');
    } finally {
      t.stop();
    }
  });
});
