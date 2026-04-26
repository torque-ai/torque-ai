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
    // prepare inside a loop but with a long disable-comment reason
    {
      code: `for (const t of tables) {
  // eslint-disable-next-line no-prepare-in-loop -- dynamic table name prevents module-level hoist
  db.prepare('SELECT * FROM ' + t).all();
}`,
    },
  ],
  invalid: [
    // prepare inside for...of
    {
      code: `for (const t of tables) { db.prepare('DELETE FROM ' + t).run(id); }`,
      errors: [{ messageId: 'prepareInLoop' }],
    },
    // prepare inside .map callback
    {
      code: `tables.map(t => db.prepare('SELECT * FROM ' + t).all());`,
      errors: [{ messageId: 'prepareInLoop' }],
    },
    // prepare inside loop with a short disable-comment reason
    {
      code: `for (const t of tables) {
  // eslint-disable-next-line no-prepare-in-loop -- ok
  db.prepare('SELECT * FROM ' + t).all();
}`,
      errors: [{ messageId: 'shortDisableReason' }],
    },
  ],
});
