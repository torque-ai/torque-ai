'use strict';

const logger = require('../logger').child({ component: 'condition-eval' });

const MAX_EXPRESSION_LENGTH = 10240;
const WORD_OPERATORS = new Set(['contains', 'matches']);
const OPERATORS = ['contains', 'matches', '!=', '>=', '<=', '==', '=', '>', '<'];

function resolveValue(path, ctx) {
  if (!path) return undefined;

  if (path.startsWith('context.')) {
    let current = ctx?.context;
    for (const part of path.slice('context.'.length).split('.')) {
      if (current == null) return undefined;
      current = current[part];
    }
    return current;
  }

  if (!path.includes('.')) {
    return ctx?.[path];
  }

  let current = ctx;
  for (const part of path.split('.')) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

function isTruthy(value) {
  if (value == null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.toLowerCase().trim();
    return !(normalized === '' || normalized === '0' || normalized === 'false' || normalized === 'no');
  }
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function stripQuotes(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function compareValues(left, operator, rightRaw) {
  const right = stripQuotes(rightRaw);

  switch (operator) {
    case '=':
    case '==':
      return String(left) === String(right);
    case '!=':
      return String(left) !== String(right);
    case '>':
      return Number(left) > Number(right);
    case '<':
      return Number(left) < Number(right);
    case '>=':
      return Number(left) >= Number(right);
    case '<=':
      return Number(left) <= Number(right);
    case 'contains':
      if (Array.isArray(left)) return left.map(String).includes(String(right));
      return typeof left === 'string' && left.includes(String(right));
    case 'matches':
      try {
        return new RegExp(String(right)).test(String(left));
      } catch {
        return false;
      }
    default:
      return false;
  }
}

function scanExpression(expr, visitor) {
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let i = 0; i < expr.length; i++) {
    const char = expr[i];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === '(') {
      depth++;
      continue;
    }

    if (char === ')') {
      depth--;
      if (depth < 0) throw new Error('Unbalanced parentheses');
      continue;
    }

    visitor({ index: i, depth });
  }

  if (quote) throw new Error('Unterminated string literal');
  if (depth !== 0) throw new Error('Unbalanced parentheses');
}

function stripOuterParens(expr) {
  let trimmed = expr.trim();

  while (trimmed.startsWith('(') && trimmed.endsWith(')')) {
    let depth = 0;
    let quote = null;
    let escaped = false;
    let outerClosesAt = -1;

    for (let i = 0; i < trimmed.length; i++) {
      const char = trimmed[i];

      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === quote) {
          quote = null;
        }
        continue;
      }

      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }

      if (char === '(') {
        depth++;
      } else if (char === ')') {
        depth--;
        if (depth < 0) throw new Error('Unbalanced parentheses');
        if (depth === 0) {
          outerClosesAt = i;
          break;
        }
      }
    }

    if (quote) throw new Error('Unterminated string literal');
    if (outerClosesAt !== trimmed.length - 1) break;
    trimmed = trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

function splitTopLevel(expr, separator) {
  const parts = [];
  let start = 0;

  scanExpression(expr, ({ index, depth }) => {
    if (depth !== 0) return;
    if (expr.slice(index, index + separator.length) !== separator) return;

    parts.push(expr.slice(start, index));
    start = index + separator.length;
  });

  if (start === 0) return [expr];
  parts.push(expr.slice(start));
  return parts;
}

function splitTopLevelWord(expr, word) {
  const parts = [];
  let start = 0;
  const lowerExpr = expr.toLowerCase();
  const lowerWord = word.toLowerCase();

  scanExpression(expr, ({ index, depth }) => {
    if (depth !== 0) return;
    if (lowerExpr.slice(index, index + lowerWord.length) !== lowerWord) return;

    const before = expr[index - 1];
    const after = expr[index + lowerWord.length];
    const beforeBoundary = before == null || /[\s(]/.test(before);
    const afterBoundary = after == null || /[\s)]/.test(after);
    if (!beforeBoundary || !afterBoundary) return;

    parts.push(expr.slice(start, index));
    start = index + lowerWord.length;
  });

  if (start === 0) return [expr];
  parts.push(expr.slice(start));
  return parts;
}

function splitAnyTopLevel(expr, separators) {
  for (const separator of separators) {
    const parts = /^[A-Za-z]+$/.test(separator)
      ? splitTopLevelWord(expr, separator)
      : splitTopLevel(expr, separator);
    if (parts.length > 1) return parts;
  }
  return [expr];
}

function findTopLevelOperator(expr) {
  let result = null;

  scanExpression(expr, ({ index, depth }) => {
    if (result || depth !== 0) return;

    for (const operator of OPERATORS) {
      if (WORD_OPERATORS.has(operator)) {
        const candidate = expr.slice(index, index + operator.length).toLowerCase();
        if (candidate !== operator) continue;

        const before = expr[index - 1];
        const after = expr[index + operator.length];
        if (!before || !after || !/\s/.test(before) || !/\s/.test(after)) continue;

        result = { operator, index, length: operator.length };
        return;
      }

      if (expr.slice(index, index + operator.length) === operator) {
        result = { operator, index, length: operator.length };
        return;
      }
    }
  });

  return result;
}

function evalMethodCall(expr, ctx) {
  const match = expr.match(/^([A-Za-z_][\w.]*)\.(contains|matches)\((.*)\)$/);
  if (!match) return null;

  const left = resolveValue(match[1], ctx);
  const right = match[3].trim();
  if (!right) return false;
  return compareValues(left, match[2], right);
}

function evalAtom(expr, ctx) {
  const trimmed = stripOuterParens(expr.trim());
  if (!trimmed) return true;

  const methodResult = evalMethodCall(trimmed, ctx);
  if (methodResult !== null) return methodResult;

  const operatorMatch = findTopLevelOperator(trimmed);
  if (operatorMatch) {
    const leftPath = trimmed.slice(0, operatorMatch.index).trim();
    const rightRaw = trimmed.slice(operatorMatch.index + operatorMatch.length).trim();
    if (!leftPath || !rightRaw) return false;
    return compareValues(resolveValue(leftPath, ctx), operatorMatch.operator, rightRaw);
  }

  return isTruthy(resolveValue(trimmed, ctx));
}

function assertNonEmptyParts(parts) {
  if (parts.some((part) => part.trim() === '')) {
    throw new Error('Missing expression segment');
  }
}

function evalExpr(expr, ctx) {
  const trimmed = stripOuterParens(expr.trim());
  if (!trimmed) return true;

  const orParts = splitAnyTopLevel(trimmed, ['||', 'OR']);
  if (orParts.length > 1) {
    assertNonEmptyParts(orParts);
    return orParts.some((part) => evalExpr(part, ctx));
  }

  const andParts = splitAnyTopLevel(trimmed, ['&&', 'AND']);
  if (andParts.length > 1) {
    assertNonEmptyParts(andParts);
    return andParts.every((part) => evalExpr(part, ctx));
  }

  if (trimmed.startsWith('!')) {
    const rest = trimmed.slice(1).trim();
    if (!rest) return false;
    return !evalExpr(rest, ctx);
  }

  if (/^NOT\s+/i.test(trimmed)) {
    return !evalExpr(trimmed.replace(/^NOT\s+/i, ''), ctx);
  }

  return evalAtom(trimmed, ctx);
}

/**
 * Evaluate a condition expression against a context.
 * Returns false on parse errors so workflow dependency handling stays resilient.
 */
function evaluateCondition(expr, ctx = {}) {
  if (expr == null) return true;
  if (typeof expr !== 'string') return false;
  if (expr.trim() === '') return true;

  if (expr.length > MAX_EXPRESSION_LENGTH) {
    logger.info(`[condition-eval] Failed to evaluate expression: length ${expr.length} exceeds ${MAX_EXPRESSION_LENGTH}`);
    return false;
  }

  try {
    return Boolean(evalExpr(expr, ctx || {}));
  } catch (err) {
    logger.info(`[condition-eval] Failed to evaluate "${expr}": ${err.message}`);
    return false;
  }
}

module.exports = { evaluateCondition };
