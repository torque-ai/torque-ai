'use strict';

const { describe, it, expect } = require('vitest');
const { RuleTester } = require('eslint');
const rule = require('../eslint-rules/no-prepare-in-loop');

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2020,
    sourceType: 'commonjs',
  },
});

describe('torque/no-prepare-in-loop', () => {
  it('reports prepare inside for...of', () => {
    expect(() => tester.run('no-prepare-in-loop', rule, {
      valid: [],
      invalid: [{
        code: `for (const t of tables) { db.prepare('DELETE FROM ' + t).run(id); }`,
        errors: [{ messageId: 'prepareInLoop' }],
      }],
    })).not.toThrow();
  });

  it('reports prepare inside .map callback', () => {
    expect(() => tester.run('no-prepare-in-loop', rule, {
      valid: [],
      invalid: [{
        code: `tables.map(t => db.prepare('SELECT * FROM ' + t).all());`,
        errors: [{ messageId: 'prepareInLoop' }],
      }],
    })).not.toThrow();
  });

  it('allows prepare outside loops', () => {
    expect(() => tester.run('no-prepare-in-loop', rule, {
      valid: [{
        code: `const stmt = db.prepare('SELECT * FROM tasks'); stmt.all();`,
      }],
      invalid: [],
    })).not.toThrow();
  });

  it('allows suppression with long reason', () => {
    expect(() => tester.run('no-prepare-in-loop', rule, {
      valid: [{
        code: `for (const t of tables) {
  // eslint-disable-next-line torque/no-prepare-in-loop -- dynamic table name prevents module-level hoist
  db.prepare('SELECT * FROM ' + t).all();
}`,
      }],
      invalid: [],
    })).not.toThrow();
  });

  it('reports suppression with short reason', () => {
    expect(() => tester.run('no-prepare-in-loop', rule, {
      valid: [],
      invalid: [{
        code: `for (const t of tables) {
  // eslint-disable-next-line torque/no-prepare-in-loop -- ok
  db.prepare('SELECT * FROM ' + t).all();
}`,
        errors: [{ messageId: 'shortDisableReason' }],
      }],
    })).not.toThrow();
  });
});
