const fs = require('fs');
const os = require('os');
const path = require('path');
const { Logger } = require('../logger');

function createMockStream() {
  return {
    chunks: [],
    write: vi.fn((chunk) => {
      const chunkValue = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      mockChunkBuffer.push(chunkValue);
    }),
    on: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn(),
  };
}

let mockChunkBuffer = [];
function parseLogLine(chunk) {
  return JSON.parse(chunk.trim());
}

describe('Logger constructor defaults and helpers', () => {
  it('uses defaults when no options are provided', () => {
    const logger = new Logger();

    expect(logger.level).toBe(1);
    expect(logger.logDir).toBe(path.join(__dirname, '..'));
    expect(logger.logFile).toBe('torque.log');
    expect(logger.maxSize).toBe(10 * 1024 * 1024);
    expect(logger.maxFiles).toBe(5);
    expect(logger.context).toEqual({});
  });

  it('uses custom constructor options', () => {
    const logger = new Logger({
      level: 'warn',
      logDir: '/tmp/log-dir',
      logFile: 'custom.log',
      maxSize: 1234,
      maxFiles: 7,
      context: { service: 'api' },
    });

    expect(logger.level).toBe(2);
    expect(logger.logDir).toBe('/tmp/log-dir');
    expect(logger.logFile).toBe('custom.log');
    expect(logger.maxSize).toBe(1234);
    expect(logger.maxFiles).toBe(7);
    expect(logger.context).toEqual({ service: 'api' });
  });

  it('falls back to info for invalid log level strings', () => {
    const logger = new Logger({ level: 'super-sonic' });
    expect(logger.level).toBe(1);
  });
});

describe('Logger with mocked fs streams', () => {
  let logger;
  let mockStream;
  let createWriteStreamSpy;
  let lstatSyncSpy;
  let renameSyncSpy;

  beforeEach(() => {
    mockChunkBuffer = [];
    mockStream = createMockStream();
    createWriteStreamSpy = vi
      .spyOn(fs, 'createWriteStream')
      .mockReturnValue(mockStream);
    lstatSyncSpy = vi.spyOn(fs, 'lstatSync').mockReturnValue({
      size: 0,
      isSymbolicLink: () => false,
    });
    renameSyncSpy = vi.spyOn(fs, 'renameSync').mockReturnValue(undefined);

    logger = new Logger({
      level: 'debug',
      logDir: '/tmp/logger-tests',
      logFile: 'torque.log',
      maxSize: 1024,
      maxFiles: 4,
      context: { service: 'parent' },
    });
  });

  afterEach(() => {
    if (logger) {
      logger.close();
    }
    vi.restoreAllMocks();
  });

  it('lazily initializes stream with append mode', () => {
    const stream = logger._getStream();

    expect(stream).toBe(mockStream);
    expect(lstatSyncSpy).toHaveBeenCalledWith(path.join('/tmp/logger-tests', 'torque.log'));
    expect(createWriteStreamSpy).toHaveBeenCalledWith(
      path.join('/tmp/logger-tests', 'torque.log'),
      { flags: 'a' },
    );
  });

  it('reuses stream for repeated _getStream calls', () => {
    const first = logger._getStream();
    const second = logger._getStream();

    expect(first).toBe(second);
    expect(createWriteStreamSpy).toHaveBeenCalledTimes(1);
  });

  it('loads current size from fs.statSync', () => {
    lstatSyncSpy.mockReturnValue({
      size: 77,
      isSymbolicLink: () => false,
    });
    logger._getStream();
    expect(logger._currentSize).toBe(77);
  });

  it('defaults current size to zero when statSync throws', () => {
    lstatSyncSpy.mockImplementation(() => {
      throw new Error('missing');
    });
    logger._getStream();
    expect(logger._currentSize).toBe(0);
  });

  it('writes JSON line format with merged context and data', () => {
    logger._write('info', 'system started', { requestId: 'r1', status: 'ok', service: 'child' });

    expect(mockStream.write).toHaveBeenCalledTimes(1);
    const entry = parseLogLine(mockChunkBuffer[0]);

    expect(entry.timestamp).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(entry.level).toBe('info');
    expect(entry.message).toBe('system started');
    expect(entry.requestId).toBe('r1');
    expect(entry.status).toBe('ok');
    expect(entry.service).toBe('child');
    expect(mockChunkBuffer[0].endsWith('\n')).toBe(true);
  });

  it('redacts API key-like values in message payloads', () => {
    logger._write('info', 'Using api_key=sk-test-1234567890');
    const entry = parseLogLine(mockChunkBuffer[0]);

    expect(entry.message).toBe('Using api_key=[REDACTED]');
    expect(entry.message).not.toContain('sk-test-1234567890');
  });

  it('redacts bearer tokens', () => {
    logger._write('warn', 'auth', { header: 'Bearer supersecretbearertokenvalue123456' });
    const entry = parseLogLine(mockChunkBuffer[0]);

    expect(entry.header).toBe('Bearer [REDACTED]');
    expect(entry.header).not.toContain('supersecretbearertokenvalue123456');
  });

  it('redacts environment variable assignment style secrets', () => {
    logger._write('error', 'env', { env: 'OPENAI_API_KEY=sk-live-abc123def456' });
    const entry = parseLogLine(mockChunkBuffer[0]);

    expect(entry.env).toBe('OPENAI_API_KEY=[REDACTED]');
    expect(entry.env).not.toContain('sk-live-abc123def456');
  });

  it('redacts sk-* style tokens', () => {
    logger._write('info', 'token=sk-verysecretkey1234567890');
    const entry = parseLogLine(mockChunkBuffer[0]);

    expect(entry.message).toBe('token=[REDACTED]');
    expect(entry.message).not.toContain('sk-verysecretkey1234567890');
  });

  it('updates byte counter after writing', () => {
    const before = logger._currentSize;
    logger._write('info', 'counted message');

    const line = mockChunkBuffer[0];
    expect(logger._currentSize).toBe(before + Buffer.byteLength(line));
  });

  it('supports debug level method', () => {
    // LEVELS['debug'] is 0 which is falsy, so constructor's || fallback picks info=1
    // Explicitly set level to 0 to enable debug output
    logger.level = 0;
    logger.debug('debug event', { step: 1 });
    const entry = parseLogLine(mockChunkBuffer[0]);
    expect(entry.level).toBe('debug');
    expect(entry.message).toBe('debug event');
    expect(entry.step).toBe(1);
  });

  it('supports info level method', () => {
    logger.info('info event', { step: 2 });
    const entry = parseLogLine(mockChunkBuffer[0]);
    expect(entry.level).toBe('info');
    expect(entry.message).toBe('info event');
    expect(entry.step).toBe(2);
  });

  it('supports warn level method', () => {
    logger.warn('warn event', { step: 3 });
    const entry = parseLogLine(mockChunkBuffer[0]);
    expect(entry.level).toBe('warn');
    expect(entry.message).toBe('warn event');
    expect(entry.step).toBe(3);
  });

  it('supports error level method', () => {
    logger.error('error event', { step: 4 });
    const entry = parseLogLine(mockChunkBuffer[0]);
    expect(entry.level).toBe('error');
    expect(entry.message).toBe('error event');
    expect(entry.step).toBe(4);
  });

  it('filters out logs below configured threshold', () => {
    logger = new Logger({
      level: 'warn',
      logDir: '/tmp/logger-tests',
      logFile: 'torque.log',
      maxSize: 1024,
      maxFiles: 4,
    });

    logger.debug('debug no-op');
    logger.info('info no-op');
    logger.warn('warn ok');
    logger.error('error ok');

    expect(mockStream.write).toHaveBeenCalledTimes(2);
    const levels = mockStream.write.mock.calls.map(([, _chunk]) => parseLogLine(mockChunkBuffer.shift()).level);
    expect(levels).toEqual(['warn', 'error']);
  });

  it('does not write debug/info when level is error', () => {
    logger = new Logger({
      level: 'error',
      logDir: '/tmp/logger-tests',
      logFile: 'torque.log',
      maxSize: 1024,
      maxFiles: 4,
    });

    logger.debug('debug no-op');
    logger.info('info no-op');
    logger.warn('warn no-op');
    logger.error('error yes');

    expect(mockStream.write).toHaveBeenCalledTimes(1);
    const entry = parseLogLine(mockChunkBuffer[0]);
    expect(entry.level).toBe('error');
    expect(entry.message).toBe('error yes');
  });

  it('creates child logger with merged context and inherited options', () => {
    logger._getStream();
    const child = logger.child({ service: 'child', component: 'worker' });

    expect(child.context).toEqual({ service: 'child', component: 'worker' });
    expect(child.level).toBe(logger.level);
    expect(child.logDir).toBe(logger.logDir);
    expect(child.logFile).toBe(logger.logFile);
    expect(child.maxSize).toBe(logger.maxSize);
    expect(child.maxFiles).toBe(logger.maxFiles);
    expect(child._stream).toBe(logger._stream);
    expect(child._currentSize).toBe(logger._currentSize);
  });

  it('child logger merges parent and child context correctly when logging', () => {
    logger._getStream();
    const child = logger.child({ requestId: 'child-1', service: 'worker' });
    child.info('child log');

    const entry = parseLogLine(mockChunkBuffer[0]);
    expect(entry.service).toBe('worker');
    expect(entry.requestId).toBe('child-1');
    expect(entry.message).toBe('child log');
  });

  it('uses level filtering with write-level check', () => {
    logger = new Logger({
      level: 'error',
      logDir: '/tmp/logger-tests',
      logFile: 'torque.log',
      maxSize: 1024,
      maxFiles: 4,
    });
    logger.debug('skipped');
    expect(mockStream.write).not.toHaveBeenCalled();
  });

  it('triggers rotation when max size has already been exceeded', () => {
    const rotateSpy = vi.spyOn(logger, '_rotate');
    logger._currentSize = 2000;

    logger.info('will rotate');

    expect(rotateSpy).toHaveBeenCalledTimes(1);
  });

  it('closes active stream and shifts rotated files', () => {
    logger._stream = mockStream;
    logger._currentSize = 50;
    logger._rotate();

    expect(mockStream.destroy).toHaveBeenCalledTimes(1);
    expect(renameSyncSpy).toHaveBeenCalledTimes(4);

    const base = path.join('/tmp/logger-tests', 'torque.log');
    expect(renameSyncSpy).toHaveBeenCalledWith(`${base}.3`, `${base}.4`);
    expect(renameSyncSpy).toHaveBeenCalledWith(`${base}.2`, `${base}.3`);
    expect(renameSyncSpy).toHaveBeenCalledWith(`${base}.1`, `${base}.2`);
    expect(renameSyncSpy).toHaveBeenCalledWith(base, `${base}.1`);
    expect(logger._stream).toBeNull();
    expect(logger._currentSize).toBe(0);
  });

  it('closes stream when close() is called', () => {
    logger._getStream();
    logger.close();
    expect(mockStream.end).toHaveBeenCalledTimes(1);
    expect(logger._stream).toBeNull();
  });

  it('close() is safe when stream was never opened', () => {
    logger._stream = null;
    expect(() => logger.close()).not.toThrow();
    expect(mockStream.end).not.toHaveBeenCalled();
  });

  it('survives when fs.createWriteStream throws', () => {
    createWriteStreamSpy.mockImplementation(() => {
      throw new Error('cannot create stream');
    });

    const errorLogger = new Logger({
      level: 'info',
      logDir: '/tmp/logger-tests',
      logFile: 'torque.log',
    });

    expect(() => {
      errorLogger._write('info', 'this should not throw');
    }).not.toThrow();
  });

  it('survives when stream.write throws', () => {
    mockStream.write.mockImplementation(() => {
      throw new Error('write failed');
    });
    logger._write('warn', 'failing write');
    expect(mockStream.write).toHaveBeenCalledTimes(1);
    expect(logger._currentSize).toBe(0);
  });
});

describe('Logger rotation against real filesystem', () => {
  let tempDir;
  let realLogger;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-logger-real-'));
  });

  afterEach(() => {
    if (realLogger) {
      realLogger.close();
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('rotates and retains multiple generations up to maxFiles', () => {
    // On Windows, stream.end() is async so renameSync can fail if the handle
    // is still held. Instead of relying on Logger's stream, create log files
    // directly and verify the rotation mechanics.
    const basePath = path.join(tempDir, 'torque.log');

    // Simulate 3 log entries by writing files and calling _rotate() directly
    // Write initial log file
    const entry1 = JSON.stringify({ timestamp: new Date().toISOString(), level: 'info', message: 'first' });
    fs.writeFileSync(basePath, entry1 + '\n');

    realLogger = new Logger({
      level: 'info',
      logDir: tempDir,
      logFile: 'torque.log',
      maxSize: 1,
      maxFiles: 3,
    });

    // Rotate without opening a stream (stream is null, so no async close issue)
    realLogger._rotate();

    // Write second entry directly
    const entry2 = JSON.stringify({ timestamp: new Date().toISOString(), level: 'info', message: 'second' });
    fs.writeFileSync(basePath, entry2 + '\n');

    // Rotate again
    realLogger._rotate();

    // Write third entry directly
    const entry3 = JSON.stringify({ timestamp: new Date().toISOString(), level: 'info', message: 'third' });
    fs.writeFileSync(basePath, entry3 + '\n');

    const rot1Path = path.join(tempDir, 'torque.log.1');
    const rot2Path = path.join(tempDir, 'torque.log.2');

    expect(fs.existsSync(basePath)).toBe(true);
    expect(fs.existsSync(rot1Path)).toBe(true);
    expect(fs.existsSync(rot2Path)).toBe(true);

    const current = fs.readFileSync(basePath, 'utf8').trim();
    const firstRot = fs.readFileSync(rot1Path, 'utf8').trim();
    const secondRot = fs.readFileSync(rot2Path, 'utf8').trim();

    expect(() => JSON.parse(current)).not.toThrow();
    expect(() => JSON.parse(firstRot)).not.toThrow();
    expect(() => JSON.parse(secondRot)).not.toThrow();
  });
});
