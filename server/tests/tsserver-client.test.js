/**
 * Unit Tests: utils/tsserver-client.js
 *
 * Tests the Content-Length frame parser, session lifecycle, and API surface.
 * Integration tests against a real tsserver are gated by TypeScript availability.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const {
  ContentLengthFrameParser,
  TsserverSession,
  _sessions: sessions,
  init,
  getDiagnostics,
  getQuickInfo,
  getDefinition,
    getCachedDiagnostics,
  getSessionStatus,
  shutdownAll,
} = require('../utils/tsserver-client');

// ─── ContentLengthFrameParser ──────────────────────────────────────────

describe('ContentLengthFrameParser', () => {
  it('parses a single complete message', () => {
    const parser = new ContentLengthFrameParser();
    const body = JSON.stringify({ type: 'response', seq: 1, success: true });
    const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    const messages = parser.feed(frame);
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('response');
    expect(messages[0].seq).toBe(1);
  });

  it('parses multiple messages in one chunk', () => {
    const parser = new ContentLengthFrameParser();
    const body1 = JSON.stringify({ type: 'response', seq: 1 });
    const body2 = JSON.stringify({ type: 'event', event: 'syntaxDiag' });
    const frame1 = `Content-Length: ${Buffer.byteLength(body1)}\r\n\r\n${body1}`;
    const frame2 = `Content-Length: ${Buffer.byteLength(body2)}\r\n\r\n${body2}`;
    const messages = parser.feed(frame1 + frame2);
    expect(messages).toHaveLength(2);
    expect(messages[0].seq).toBe(1);
    expect(messages[1].event).toBe('syntaxDiag');
  });

  it('handles split messages across multiple feeds', () => {
    const parser = new ContentLengthFrameParser();
    const body = JSON.stringify({ type: 'response', seq: 42 });
    const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;

    // Split in the middle
    const mid = Math.floor(frame.length / 2);
    const part1 = frame.slice(0, mid);
    const part2 = frame.slice(mid);

    const msgs1 = parser.feed(part1);
    expect(msgs1).toHaveLength(0);

    const msgs2 = parser.feed(part2);
    expect(msgs2).toHaveLength(1);
    expect(msgs2[0].seq).toBe(42);
  });

  it('handles split in header', () => {
    const parser = new ContentLengthFrameParser();
    const body = JSON.stringify({ ok: true });
    const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;

    // Split inside the header
    const msgs1 = parser.feed('Content-Len');
    expect(msgs1).toHaveLength(0);

    const msgs2 = parser.feed(frame.slice(11));
    expect(msgs2).toHaveLength(1);
    expect(msgs2[0].ok).toBe(true);
  });

  it('skips malformed headers', () => {
    const parser = new ContentLengthFrameParser();
    // Malformed header (no Content-Length)
    const malformed = `Bad-Header: 10\r\n\r\n{"bad":true}`;
    const body = JSON.stringify({ good: true });
    const good = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;

    const messages = parser.feed(malformed + good);
    // Should skip the malformed one and parse the good one
    expect(messages.some(m => m.good === true)).toBe(true);
  });

  it('skips malformed JSON body', () => {
    const parser = new ContentLengthFrameParser();
    const badBody = '{not valid json';
    const frame = `Content-Length: ${Buffer.byteLength(badBody)}\r\n\r\n${badBody}`;
    const messages = parser.feed(frame);
    expect(messages).toHaveLength(0);
  });

  it('reset clears state', () => {
    const parser = new ContentLengthFrameParser();
    parser.feed('Content-Length: 100\r\n\r\npartial');
    parser.reset();
    expect(parser.buffer.length).toBe(0);
    expect(parser.contentLength).toBe(-1);
  });

  it('handles unicode content correctly', () => {
    const parser = new ContentLengthFrameParser();
    const body = JSON.stringify({ text: 'héllo wörld 日本語' });
    // Content-Length is byte length, not char length
    const byteLen = Buffer.byteLength(body);
    const frame = `Content-Length: ${byteLen}\r\n\r\n${body}`;
    const messages = parser.feed(frame);
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe('héllo wörld 日本語');
  });
});

// ─── TsserverSession ───────────────────────────────────────────────────

describe('TsserverSession', () => {
  it('constructs with correct defaults', () => {
    const session = new TsserverSession('/tmp/test-project');
    expect(session.workingDir).toBe('/tmp/test-project');
    expect(session.process).toBeNull();
    expect(session.seq).toBe(0);
    expect(session.restartCount).toBe(0);
    expect(session._dead).toBe(false);
    expect(session.openFiles.size).toBe(0);
    expect(session.diagnosticCache.size).toBe(0);
  });

  it('sendRequest rejects when process is null', async () => {
    const session = new TsserverSession('/tmp/test-project');
    await expect(session.sendRequest('open', {})).rejects.toThrow('tsserver not running');
  });

  it('sendRequest rejects when session is dead', async () => {
    const session = new TsserverSession('/tmp/test-project');
    session._dead = true;
    await expect(session.sendRequest('open', {})).rejects.toThrow('tsserver not running');
  });

  it('kill marks session as dead and clears state', () => {
    const session = new TsserverSession('/tmp/test-project');
    session.openFiles.add('foo.ts');
    session.diagnosticCache.set('foo.ts', []);
    session.kill();
    expect(session._dead).toBe(true);
    expect(session.openFiles.size).toBe(0);
    expect(session.diagnosticCache.size).toBe(0);
  });

  it('_handleEvent caches diagnostics', () => {
    const session = new TsserverSession('/tmp/test-project');
    session._handleEvent({
      type: 'event',
      event: 'semanticDiag',
      body: {
        file: '/tmp/test-project/foo.ts',
        diagnostics: [
          { start: { line: 1, offset: 5 }, code: 2304, text: "Cannot find name 'x'" }
        ]
      }
    });

    const cached = session.diagnosticCache.get('/tmp/test-project/foo.ts');
    expect(cached).toHaveLength(1);
    expect(cached[0].code).toBe(2304);
  });

  it('_handleEvent deduplicates diagnostics', () => {
    const session = new TsserverSession('/tmp/test-project');
    const diag = { start: { line: 1, offset: 5 }, code: 2304, text: "Cannot find name 'x'" };

    session._handleEvent({
      type: 'event',
      event: 'semanticDiag',
      body: { file: 'foo.ts', diagnostics: [diag] }
    });
    session._handleEvent({
      type: 'event',
      event: 'syntaxDiag',
      body: { file: 'foo.ts', diagnostics: [diag] }
    });

    const cached = session.diagnosticCache.get('foo.ts');
    expect(cached).toHaveLength(1);
  });

  it('_dispatchMessage resolves pending requests', () => {
    const session = new TsserverSession('/tmp/test-project');
    let resolved = null;

    const timer = vi.fn();
    session.pending.set(1, {
      resolve: (val) => { resolved = val; },
      reject: () => {},
      timer,
    });

    session._dispatchMessage({
      type: 'response',
      request_seq: 1,
      success: true,
      body: { displayString: 'number' }
    });

    expect(resolved).toEqual({ displayString: 'number' });
    expect(session.pending.size).toBe(0);
  });

  it('_dispatchMessage rejects failed requests', () => {
    const session = new TsserverSession('/tmp/test-project');
    let rejected = null;

    const timer = vi.fn();
    session.pending.set(1, {
      resolve: () => {},
      reject: (err) => { rejected = err; },
      timer,
    });

    session._dispatchMessage({
      type: 'response',
      request_seq: 1,
      success: false,
      message: 'file not found'
    });

    expect(rejected).toBeInstanceOf(Error);
    expect(rejected.message).toBe('file not found');
  });
});

// ─── Module-level API (with mocked db) ─────────────────────────────────

describe('tsserver-client API', () => {
  beforeEach(() => {
    shutdownAll();
    sessions.clear();
  });

  afterAll(() => {
    shutdownAll();
  });

  it('getCachedDiagnostics returns null when disabled', () => {
    init({ db: { getConfig: () => '0' }, logger: { info() {}, debug() {}, child: () => ({ info() {}, debug() {}, warn() {}, error() {} }) } });
    expect(getCachedDiagnostics('/foo.ts')).toBeNull();
  });

  it('getCachedDiagnostics returns null when no sessions', () => {
    init({ db: { getConfig: (k) => k === 'tsserver_enabled' ? '1' : null }, logger: { info() {}, debug() {}, child: () => ({ info() {}, debug() {}, warn() {}, error() {} }) } });
    expect(getCachedDiagnostics('/foo.ts')).toBeNull();
  });

  it('getSessionStatus returns empty array when no sessions', () => {
    const status = getSessionStatus();
    expect(status).toEqual([]);
  });

  it('shutdownAll clears all sessions', () => {
    const session = new TsserverSession('/tmp/project');
    sessions.set('/tmp/project', session);
    expect(sessions.size).toBe(1);
    shutdownAll();
    expect(sessions.size).toBe(0);
  });
});

// ─── Integration tests (real tsserver) ──────────────────────────────────

// Integration tests require a real tsserver which may be slow to spawn.
// Set TSSERVER_INTEGRATION=1 to run these, otherwise they're skipped.
const RUN_INTEGRATION = process.env.TSSERVER_INTEGRATION === '1';

describe.skipIf(!RUN_INTEGRATION)('tsserver integration', () => {
  let testDir;

  beforeAll(() => {
    testDir = path.join(os.tmpdir(), `torque-vtest-tsserver-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });

    // Create a minimal TS project
    fs.writeFileSync(path.join(testDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { target: 'es2020', module: 'commonjs', strict: true },
      include: ['*.ts']
    }));

    fs.writeFileSync(path.join(testDir, 'test.ts'), `
export interface Foo {
  bar: string;
  baz: number;
}

export function greet(name: string): string {
  return "hello " + name;
}

const x: Foo = { bar: "a", baz: 1 };
`);

    // Init with enabled config
    init({
      db: { getConfig: (k) => k === 'tsserver_enabled' ? '1' : null },
      logger: { info() {}, debug() {}, warn() {}, error() {}, child: () => ({ info() {}, debug() {}, warn() {}, error() {} }) },
    });
  });

  afterAll(() => {
    shutdownAll();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('getQuickInfo returns type for a known symbol', async () => {
    const filePath = path.join(testDir, 'test.ts');
    // Line 11: "const x: Foo = ...", offset 7 = "x"
    const info = await getQuickInfo(testDir, filePath, 11, 7);
    expect(info).toBeTruthy();
    expect(info.displayString).toContain('Foo');
  }, 30000);

  it('getDefinition returns location for a symbol', async () => {
    const filePath = path.join(testDir, 'test.ts');
    // Line 11: "const x: Foo = ...", offset 10 = "F" (of Foo)
    const defs = await getDefinition(testDir, filePath, 11, 10);
    expect(defs.length).toBeGreaterThan(0);
    expect(defs[0].file).toContain('test.ts');
  }, 30000);

  it('getDiagnostics returns errors for bad code', async () => {
    // Warm up tsserver by running a quickinfo query first (triggers project load)
    const testFile = path.join(testDir, 'test.ts');
    await getQuickInfo(testDir, testFile, 2, 1);

    const badFile = path.join(testDir, 'bad.ts');
    fs.writeFileSync(badFile, `
const x: number = "not a number";
const y = unknownFunc();
`);

    const results = await getDiagnostics(testDir, [badFile], 15000);
    expect(results.length).toBeGreaterThan(0);
    const totalDiags = results.reduce((sum, r) => sum + r.diagnostics.length, 0);
    expect(totalDiags).toBeGreaterThan(0);
  }, 45000);

  it('getSessionStatus shows active session after queries', () => {
    const status = getSessionStatus();
    if (status.length > 0) {
      expect(status[0].workingDir).toBeTruthy();
      expect(typeof status[0].alive).toBe('boolean');
      expect(typeof status[0].openFiles).toBe('number');
    }
  });
});
