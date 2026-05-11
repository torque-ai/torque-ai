'use strict';

function resolveDbHandle(candidate) {
  if (!candidate) {
    return null;
  }
  if (typeof candidate.prepare === 'function') {
    return candidate;
  }
  if (typeof candidate.getDbInstance === 'function') {
    return candidate.getDbInstance();
  }
  if (typeof candidate.getDb === 'function') {
    return candidate.getDb();
  }
  return null;
}

function resolveContainerDbHandle() {
  try {
    const { defaultContainer } = require('../container');
    if (!defaultContainer) {
      return null;
    }

    if (typeof defaultContainer.peek === 'function') {
      const peeked = resolveDbHandle(defaultContainer.peek('db'));
      if (peeked) {
        return peeked;
      }
    }

    if (
      typeof defaultContainer.has === 'function'
      && defaultContainer.has('db')
      && typeof defaultContainer.get === 'function'
    ) {
      return resolveDbHandle(defaultContainer.get('db'));
    }
  } catch {
    // Let the caller surface its service-specific "active database" error.
  }
  return null;
}

module.exports = {
  resolveDbHandle,
  resolveContainerDbHandle,
};
