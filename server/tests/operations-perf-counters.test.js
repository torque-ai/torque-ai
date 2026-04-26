'use strict';

// Force a fresh require for each test to avoid state bleed
function freshCounters() {
  delete require.cache[require.resolve('../operations-perf-counters')];
  return require('../operations-perf-counters');
}

test('increment increases the named counter', () => {
  const c = freshCounters();
  c.increment('listTasksParsed');
  c.increment('listTasksParsed');
  const snap = c.getSnapshot();
  expect(snap.listTasksParsed).toBe(2);
});

test('getSnapshot(reset=true) resets counters to zero', () => {
  const c = freshCounters();
  c.increment('listTasksRaw');
  c.getSnapshot(true);
  const snap = c.getSnapshot();
  expect(snap.listTasksRaw).toBe(0);
});

test('increment with unknown key is a no-op (no crash)', () => {
  const c = freshCounters();
  expect(() => c.increment('unknownKey')).not.toThrow();
});

test('snapshot includes all expected keys', () => {
  const c = freshCounters();
  const snap = c.getSnapshot();
  expect(snap).toHaveProperty('listTasksParsed');
  expect(snap).toHaveProperty('listTasksRaw');
  expect(snap).toHaveProperty('capabilitySetBuilt');
  expect(snap).toHaveProperty('pragmaCostBudgets');
  expect(snap).toHaveProperty('pragmaPackRegistry');
});
