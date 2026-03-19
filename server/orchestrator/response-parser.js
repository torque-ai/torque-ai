'use strict';

function extractFromFence(text) {
  // The trailing \r?\n before the closing ``` is optional — some LLMs omit the
  // final newline, producing: ```json\n{...}``` with no newline before the fence.
  const fenceMatch = text.match(/```(?:json)?\s*\r?\n([\s\S]*?)(\r?\n)?```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      return null;
    }
  }
  return null;
}

function extractByBraceMatching(text, openChar, closeChar) {
  const start = text.indexOf(openChar);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let stringChar = null; // tracks whether we're inside " or '
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    // Track both double-quote and single-quote string delimiters so that braces
    // inside single-quoted strings (e.g. JS object values) are not miscounted.
    if ((ch === '"' || ch === "'") && (!inString || ch === stringChar)) {
      inString = !inString;
      stringChar = inString ? ch : null;
      continue;
    }
    if (inString) continue;
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  const fenced = extractFromFence(text);
  if (fenced && typeof fenced === 'object' && !Array.isArray(fenced)) return fenced;
  return extractByBraceMatching(text, '{', '}');
}

function extractJsonArray(text) {
  if (!text || typeof text !== 'string') return null;
  const fenced = extractFromFence(text);
  if (Array.isArray(fenced)) return fenced;
  const result = extractByBraceMatching(text, '[', ']');
  return Array.isArray(result) ? result : null;
}

module.exports = { extractJson, extractJsonArray };
