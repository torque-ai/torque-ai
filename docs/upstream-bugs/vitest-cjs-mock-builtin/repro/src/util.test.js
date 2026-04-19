'use strict';

const _config = { name: '' };

// Goal: intercept execFileSync so util.js reads _config.name instead of the
// real `git config user.name`. Under vitest 4.1.4 CJS, this mock registers
// but does NOT intercept require('child_process') — the actual test output
// shows `Received: "<real git user>"` on tests 2 and 3.
vi.mock('child_process', () => ({
  execFileSync: (cmd, args) => {
    if (cmd === 'git' && Array.isArray(args) && args[1] === 'user.name') {
      return _config.name + '\n';
    }
    return '';
  },
}));

function load() {
  delete require.cache[require.resolve('./util')];
  return require('./util');
}

describe('vi.mock child_process in CJS', () => {
  it('test 1 — trivial (passes regardless of mock)', () => {
    expect(1).toBe(1);
  });

  it('test 2 — mock intercepts; user should be Alice', () => {
    _config.name = 'Alice';
    const m = load();
    expect(m.user).toBe('Alice');
  });

  it('test 3 — mock intercepts; user should be Bob', () => {
    _config.name = 'Bob';
    const m = load();
    expect(m.user).toBe('Bob');
  });
});
