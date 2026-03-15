/**
 * EventEmitter-based spawn mock for CLI provider E2E tests.
 * Provides a controllable mock child process with stdin/stdout/stderr streams.
 */

const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

/**
 * Create a mock child process that mimics the spawn() return value.
 * @returns {{ child: object, simulateSuccess: function, simulateFailure: function }}
 */
function createMockChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.pid = Math.floor(Math.random() * 100000) + 10000;
  child.killed = false;
  child.kill = function (signal) {
    child.killed = true;
    child.emit('exit', null, signal || 'SIGTERM');
    child.emit('close', 1, signal || 'SIGTERM');
  };

  return child;
}

/**
 * Simulate a successful CLI execution.
 * @param {object} child - Mock child from createMockChild
 * @param {string} output - Stdout output to emit
 * @param {number} delay - Optional delay before close (ms)
 */
function simulateSuccess(child, output = '', delay = 10) {
  setTimeout(() => {
    if (output) child.stdout.write(output);
    child.stdout.end();
    child.stderr.end();
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
  }, delay);
}

/**
 * Simulate a failed CLI execution.
 * @param {object} child - Mock child from createMockChild
 * @param {string} stdout - Stdout output
 * @param {string} stderr - Stderr output
 * @param {number} exitCode - Exit code (default 1)
 * @param {number} delay - Optional delay before close (ms)
 */
function simulateFailure(child, stdout = '', stderr = 'Error occurred', exitCode = 1, delay = 10) {
  setTimeout(() => {
    if (stdout) child.stdout.write(stdout);
    if (stderr) child.stderr.write(stderr);
    child.stdout.end();
    child.stderr.end();
    child.emit('exit', exitCode, null);
    child.emit('close', exitCode, null);
  }, delay);
}

module.exports = { createMockChild, simulateSuccess, simulateFailure };
