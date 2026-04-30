'use strict';

function patternsOverlap(a, b) {
  const sourceA = a.source.toLowerCase();
  const sourceB = b.source.toLowerCase();
  if (sourceA === sourceB) return true;
  if (sourceA.includes(sourceB) || sourceB.includes(sourceA)) return true;
  return false;
}

function validateStrategyShape(strategy) {
  if (!strategy || typeof strategy !== 'object') {
    throw new Error('strategy must be an object');
  }
  if (typeof strategy.name !== 'string' || !strategy.name.trim()) {
    throw new Error('strategy.name is required (string)');
  }
  if (!Array.isArray(strategy.reasonPatterns) || strategy.reasonPatterns.length === 0) {
    throw new Error(`strategy.reasonPatterns is required (non-empty array of RegExp) for "${strategy.name}"`);
  }
  for (const p of strategy.reasonPatterns) {
    if (!(p instanceof RegExp)) {
      throw new Error(`strategy.reasonPatterns must contain RegExp instances (strategy "${strategy.name}")`);
    }
  }
  if (typeof strategy.replan !== 'function') {
    throw new Error(`strategy.replan(...) function is required for "${strategy.name}"`);
  }
}

function createRegistry() {
  const strategies = new Map();

  function register(strategy) {
    validateStrategyShape(strategy);
    if (strategies.has(strategy.name)) {
      throw new Error(`strategy "${strategy.name}" already registered`);
    }
    for (const existing of strategies.values()) {
      for (const newPat of strategy.reasonPatterns) {
        for (const existingPat of existing.reasonPatterns) {
          if (patternsOverlap(newPat, existingPat)) {
            throw new Error(
              `pattern overlap: "${strategy.name}" pattern ${newPat} overlaps "${existing.name}" pattern ${existingPat}`,
            );
          }
        }
      }
    }
    strategies.set(strategy.name, strategy);
  }

  function findByReason(reason) {
    if (typeof reason !== 'string' || !reason) return null;
    for (const strategy of strategies.values()) {
      if (strategy.reasonPatterns.some((p) => p.test(reason))) {
        return strategy;
      }
    }
    return null;
  }

  function list() {
    return Array.from(strategies.values());
  }

  function allReasonPatterns() {
    const out = [];
    for (const s of strategies.values()) {
      for (const p of s.reasonPatterns) out.push(p);
    }
    return out;
  }

  function clear() { strategies.clear(); }

  return { register, findByReason, list, allReasonPatterns, clear };
}

const defaultRegistry = createRegistry();

module.exports = {
  createRegistry,
  defaultRegistry,
};
