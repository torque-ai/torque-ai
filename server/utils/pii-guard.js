'use strict';

const os = require('os');

const SYSTEM_HOSTNAME = os.hostname();

function escapeRegexLiteral(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const BUILTIN_CATEGORIES = {
  user_paths: {
    patterns: [
      { regex: /C:\\Users\\(?!<user>)([^\\\s]+)/g, replacement: 'C:\\Users\\<user>' },
      { regex: /\/home\/(?!<user>)([^/\s]+)/g, replacement: '/home/<user> },
      { regex: /\/Users\/(?!<user>)([^/\s]+)/g, replacement: '/Users/<user> },
    ],
  },
  private_ips: {
    patterns: [
      { regex: /192\.168\.\d+\.(\d+)/g, replacement: '192.0.2.$1' },
      { regex: /\b10\.\d+\.\d+\.(\d+)\b/g, replacement: '10.0.0.$1' },
      { regex: /\b172\.(1[6-9]|2\d|3[01])\.\d+\.(\d+)\b/g, replacement: '172.16.0.$2' },
    ],
  },
  emails: {
    patterns: [
      {
        regex: /\b(?!noreply@)[a-zA-Z0-9._%+-]+@(?!example\.com\b)(?!test\.com\b)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g,
        replacement: 'user@example.com',
      },
    ],
  },
  hostnames: {
    patterns: [],
  },
};

if (SYSTEM_HOSTNAME && SYSTEM_HOSTNAME.length > 2) {
  BUILTIN_CATEGORIES.hostnames.patterns.push({
    regex: new RegExp(escapeRegexLiteral(SYSTEM_HOSTNAME), 'gi'),
    replacement: 'example-host',
  });
}

function scanAndReplace(text, options = {}) {
  if (!text || typeof text !== 'string') {
    return { clean: true, sanitized: '', findings: [] };
  }

  const { builtinOverrides = {}, customPatterns = [] } = options;
  const findings = [];
  let sanitized = text;

  for (const [category, config] of Object.entries(BUILTIN_CATEGORIES)) {
    if (builtinOverrides[category] === false) continue;

    for (const { regex, replacement } of config.patterns) {
      regex.lastIndex = 0;
      let match;
      const regexCopy = new RegExp(regex.source, regex.flags);
      while ((match = regexCopy.exec(sanitized)) !== null) {
        const line = sanitized.substring(0, match.index).split('\n').length;
        findings.push({ category, match: match[0], line });
      }
      regex.lastIndex = 0;
      sanitized = sanitized.replace(regex, replacement);
    }
  }

  for (const custom of customPatterns) {
    let customRegex;
    if (custom.regex) {
      customRegex = new RegExp(custom.pattern, 'g');
    } else {
      customRegex = new RegExp(escapeRegexLiteral(custom.pattern), 'g');
    }

    let match;
    const findRegex = new RegExp(customRegex.source, customRegex.flags);
    while ((match = findRegex.exec(sanitized)) !== null) {
      const line = sanitized.substring(0, match.index).split('\n').length;
      findings.push({ category: 'custom', match: match[0], line });
    }
    sanitized = sanitized.replace(customRegex, custom.replacement);
  }

  return { clean: findings.length === 0, sanitized, findings };
}

module.exports = { scanAndReplace, BUILTIN_CATEGORIES, SYSTEM_HOSTNAME };