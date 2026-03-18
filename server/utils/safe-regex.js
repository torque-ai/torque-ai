'use strict';

function isSafeRegex(pattern, maxLength = 200) {
  if (typeof pattern !== 'string' || pattern.length > maxLength) return false;
  // Reject patterns with nested quantifiers (common ReDoS source)
  if (/(\+|\*|\{)\s*(\+|\*|\{)/.test(pattern)) return false;
  try { new RegExp(pattern); return true; } catch { return false; }
}

function safeRegexTest(pattern, input, timeoutMs = 100) {
  if (!isSafeRegex(pattern)) return false;
  try {
    const regex = new RegExp(pattern, 'i');
    return regex.test(input);
  } catch { return false; }
}

module.exports = { isSafeRegex, safeRegexTest };
