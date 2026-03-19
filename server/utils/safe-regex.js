'use strict';

const DANGEROUS_PATTERNS = [
  /(\+|\*|\{)\s*\)(\+|\*|\{)/,          // Nested quantifiers: (a+)+
  /(\+|\*|\{)\s*(\+|\*|\{)/,            // Adjacent quantifiers: a++
  /\([^)]*\|[^)]*\)\s*(\+|\*|\{)/,      // Alternation in quantified group: (a|a)+
];

function isSafeRegex(pattern, maxLength = 200) {
  if (typeof pattern !== 'string' || pattern.length > maxLength) return false;
  if (DANGEROUS_PATTERNS.some(dp => dp.test(pattern))) return false;
  try { new RegExp(pattern); return true; } catch { return false; }
}

function safeRegexTest(pattern, input, timeoutMs = 100) {
  if (!isSafeRegex(pattern)) return false;
  try {
    const regex = new RegExp(pattern, 'i');
    const safeInput = typeof input === 'string' ? input.slice(0, 10000) : '';
    return regex.test(safeInput);
  } catch { return false; }
}

module.exports = { isSafeRegex, safeRegexTest };
