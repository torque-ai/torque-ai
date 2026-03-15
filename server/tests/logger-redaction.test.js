const fs = require('fs');
const os = require('os');
const path = require('path');
const { Logger } = require('../logger');

let tempDir;
let logger;

function readLog(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function parseSingleLineJson(content) {
  return JSON.parse(content.trim());
}

function flushLogger(instance) {
  return new Promise((resolve) => {
    if (!instance || !instance._stream) {
      resolve();
      return;
    }

    const stream = instance._stream;
    instance._stream = null;
    stream.end(resolve);
  });
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-logger-redaction-'));
  logger = new Logger({
    level: 'debug',
    logDir: tempDir,
    logFile: 'torque.log',
    maxSize: 1024 * 1024,
    maxFiles: 5,
  });
});

afterEach(async () => {
  await flushLogger(logger);
  fs.rmSync(tempDir, { recursive: true, force: true });
  logger = null;
  tempDir = null;
});

describe('Logger redaction', () => {
  it('redacts API key values', async () => {
    logger.info('api key test', { value: 'api_key=sk-abcdef123456' });
    await flushLogger(logger);

    const content = readLog(path.join(tempDir, 'torque.log'));
    expect(content).toContain('api_key=[REDACTED]');
    expect(content).not.toContain('sk-abcdef123456');
  });

  it('redacts Bearer tokens', async () => {
    const tokenValue = 'abcdefghijklmnopqrstuvwxyz1234567890';
    logger.warn('auth header', { header: `Bearer ${tokenValue}` });
    await flushLogger(logger);

    const content = readLog(path.join(tempDir, 'torque.log'));
    expect(content).toContain('Bearer [REDACTED]');
    expect(content).not.toContain(tokenValue);
  });

  it('redacts environment variable assignments', async () => {
    logger.error('env secret', { env: 'OPENAI_API_KEY=sk-abc123def456ghi789jkl' });
    await flushLogger(logger);

    const content = readLog(path.join(tempDir, 'torque.log'));
    expect(content).toContain('OPENAI_API_KEY=[REDACTED]');
    expect(content).not.toContain('sk-abc123def456ghi789jkl');
  });

  it('does not modify normal log messages', async () => {
    logger.info('normal message', { status: 'ok', detail: 'worker completed task 42' });
    await flushLogger(logger);

    const entry = parseSingleLineJson(readLog(path.join(tempDir, 'torque.log')));
    expect(entry.message).toBe('normal message');
    expect(entry.status).toBe('ok');
    expect(entry.detail).toBe('worker completed task 42');
  });

  it('still writes and rotates log files', async () => {
    logger = new Logger({
      level: 'debug',
      logDir: tempDir,
      logFile: 'torque.log',
      maxSize: 1,
      maxFiles: 3,
    });

    const bearerToken = 'abcdefghijklmnopqrstuvwxyz1234567890';
    logger.info('first entry', { header: `Bearer ${bearerToken}` });
    await flushLogger(logger);

    logger.info('second entry', { detail: 'rotation should produce torque.log.1' });
    await flushLogger(logger);

    const currentPath = path.join(tempDir, 'torque.log');
    const rotatedPath = path.join(tempDir, 'torque.log.1');

    expect(fs.existsSync(currentPath)).toBe(true);
    expect(fs.existsSync(rotatedPath)).toBe(true);

    const current = readLog(currentPath);
    const rotated = readLog(rotatedPath);

    expect(() => parseSingleLineJson(current)).not.toThrow();
    expect(() => parseSingleLineJson(rotated)).not.toThrow();
    expect(rotated).toContain('Bearer [REDACTED]');
    expect(rotated).not.toContain(bearerToken);
  });
});
