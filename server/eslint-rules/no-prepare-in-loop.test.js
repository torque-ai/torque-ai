'use strict';

const { RuleTester } = require('eslint');
const rule = require('./no-prepare-in-loop');

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2020,
    sourceType: 'commonjs',
  },
});

tester.run('no-prepare-in-loop', rule, {
  valid: [
    // prepare outside any loop — allowed
    {
      code: `const stmt = db.prepare('SELECT * FROM tasks'); stmt.all();`,
    },
    // prepare outside any loop, chained
    {
      code: `const result = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);`,
    },
  ],
  invalid: [
    // prepare inside for...of
    {
      code: `for (const t of tables) { db.prepare('DELETE FROM ' + t).run(id); }`,
      errors: [{ messageId: 'prepareInLoop' }],
    },
    // prepare inside for statement
    {
      code: `for (let i = 0; i < n; i++) { db.prepare('SELECT ' + i).get(); }`,
      errors: [{ messageId: 'prepareInLoop' }],
    },
    // prepare inside .map callback
    {
      code: `tables.map(t => db.prepare('SELECT * FROM ' + t).all());`,
      errors: [{ messageId: 'prepareInLoop' }],
    },
    // prepare inside .forEach callback
    {
      code: `ids.forEach(id => { db.prepare('SELECT * FROM tasks WHERE id = ?').get(id); });`,
      errors: [{ messageId: 'prepareInLoop' }],
    },
  ],
});
