/**
 * Crash auto-restart + observability regressions for server/index.js.
 *
 * Background: prior to 2026-05-06 the uncaughtException handler logged
 * the error message + stack via debugLog → logger.debug, which is filtered
 * out of torque.log at default log level. Operators saw only
 * "gracefulShutdown received signal: uncaughtException" with no diagnostic
 * detail. Worse, the handler did NOT set process._torqueRestartPending,
 * so the spawn-successor block at the end of performShutdown() was
 * skipped — the server simply died on every uncaught exception with no
 * auto-restart. Three crashes in a single operator session today, each
 * requiring a manual restart, which the user surfaced as "the torque
 * server never restarts."
 *
 * Static-source assertions (rather than running the actual handlers) keep
 * the test fast and avoid hooking process-level error events. The handler
 * registration runs once at module load and is global to the process, so
 * unit-running it would require child-process isolation.
 */

const fs = require('fs');
const path = require('path');

const SERVER_INDEX = path.resolve(__dirname, '..', 'index.js');

/**
 * Extract a `process.on(eventName, ...)` handler body using brace
 * counting so we don't get tripped up by nested try/catch blocks (which
 * was the early bug — `indexOf('});', start)` returned the first inner
 * `});` from a nested try/catch, clipping the body before the
 * restart-arming logic).
 */
function extractProcessOnBody(source, eventName) {
  const start = source.indexOf(`process.on('${eventName}'`);
  if (start === -1) return '';
  // Walk forward to the first `{` (handler body open).
  let i = source.indexOf('{', start);
  if (i === -1) return '';
  let depth = 1;
  i++;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  // i now points just past the closing `}` of the handler arrow function;
  // the `process.on(...)` call closes with `);` shortly after. Slice
  // from start to i is the handler body inclusive.
  return source.slice(start, i);
}

describe('crash auto-restart + observability', () => {
  let source = '';

  beforeAll(() => {
    source = fs.readFileSync(SERVER_INDEX, 'utf8');
  });

  describe('uncaughtException handler', () => {
    it('logs error message + stack via logger.error (visible in torque.log)', () => {
      // The previous code used only debugLog() which goes to logger.debug
      // and is filtered out at default level. The fix calls logger.error
      // with the error fields BEFORE the recoverable check.
      const handlerBody = extractProcessOnBody(source, 'uncaughtException');
      expect(handlerBody).not.toBe('');
      expect(handlerBody).toContain("logger.error('Uncaught exception");
      expect(handlerBody).toContain('error_message:');
      expect(handlerBody).toContain('stack:');
    });

    it('arms process._torqueRestartPending before gracefulShutdown for fatal errors', () => {
      // The spawn-successor block at the end of performShutdown() reads
      // process._torqueRestartPending. If we don't set it, the server
      // exits without spawning a successor — the bug the user hit.
      const handlerBody = extractProcessOnBody(source, 'uncaughtException');
      const flagIdx = handlerBody.indexOf('process._torqueRestartPending = true');
      const shutdownIdx = handlerBody.indexOf("gracefulShutdown('uncaughtException')");
      expect(flagIdx).toBeGreaterThan(-1);
      expect(shutdownIdx).toBeGreaterThan(-1);
      expect(flagIdx).toBeLessThan(shutdownIdx);
    });

    it('respects TORQUE_NO_RESTART_ON_CRASH escape hatch for diagnostic sessions', () => {
      // Operators investigating crash root cause may want the body to
      // remain instead of auto-restarting. Set the env var to suppress.
      const handlerBody = extractProcessOnBody(source, 'uncaughtException');
      expect(handlerBody).toContain('TORQUE_NO_RESTART_ON_CRASH');
    });

    it('does NOT arm restart for recoverable errors (network/transition)', () => {
      // Recoverable errors return early — the restart-arm block must
      // sit AFTER the early-return so it never fires for those.
      const handlerBody = extractProcessOnBody(source, 'uncaughtException');
      const recoverableReturnIdx = handlerBody.indexOf('return; // Don');
      const flagIdx = handlerBody.indexOf('process._torqueRestartPending = true');
      expect(recoverableReturnIdx).toBeGreaterThan(-1);
      expect(flagIdx).toBeGreaterThan(-1);
      expect(recoverableReturnIdx).toBeLessThan(flagIdx);
    });
  });

  describe('unhandledRejection burst handler', () => {
    it('logs individual rejections via logger.warn (visible in torque.log)', () => {
      const handlerBody = extractProcessOnBody(source, 'unhandledRejection');
      expect(handlerBody).not.toBe('');
      expect(handlerBody).toContain("logger.warn('Unhandled promise rejection'");
    });

    it('arms process._torqueRestartPending on burst threshold', () => {
      const handlerBody = extractProcessOnBody(source, 'unhandledRejection');

      // The burst path should also set the flag before gracefulShutdown.
      const burstShutdownIdx = handlerBody.indexOf("gracefulShutdown('unhandled-rejection-burst')");
      expect(burstShutdownIdx).toBeGreaterThan(-1);

      // Look for the flag-set within ~600 chars before the burst shutdown
      // call (the if-block guarding it is small).
      const beforeShutdown = handlerBody.slice(Math.max(0, burstShutdownIdx - 600), burstShutdownIdx);
      expect(beforeShutdown).toContain('process._torqueRestartPending = true');
    });
  });

  describe('performShutdown spawn block', () => {
    it('still gates spawnRestartSuccessor on process._torqueRestartPending', () => {
      // This is the contract our handler-side fix relies on. Regression
      // guard: if the gate is renamed or the spawn block is removed,
      // crash-auto-restart breaks silently.
      const spawnBlock = /if \(process\._torqueRestartPending\)\s*\{[\s\S]*?spawnRestartSuccessor/;
      expect(source).toMatch(spawnBlock);
    });
  });
});
