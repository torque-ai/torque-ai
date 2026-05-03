'use strict';

const WINDOWS_NATIVE_CRASH_EXIT_CODES = new Map([
  [3221225477, '0xC0000005 STATUS_ACCESS_VIOLATION'],
  [3221225725, '0xC00000FD STATUS_STACK_OVERFLOW'],
  [3221226505, '0xC0000409 STATUS_STACK_BUFFER_OVERRUN'],
]);

function normalizeExitCode(exitCode) {
  const code = Number(exitCode);
  return Number.isInteger(code) ? code : null;
}

function getWindowsNativeCrashExitReason(exitCode) {
  const code = normalizeExitCode(exitCode);
  if (code === null) return null;
  return WINDOWS_NATIVE_CRASH_EXIT_CODES.get(code) || null;
}

function isWindowsNativeCrashExitCode(exitCode) {
  return getWindowsNativeCrashExitReason(exitCode) !== null;
}

module.exports = {
  getWindowsNativeCrashExitReason,
  isWindowsNativeCrashExitCode,
};
