'use strict';

const { RuleTester } = require('eslint');
const rule = require('./no-imperative-init');

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'commonjs',
  },
});

tester.run('no-imperative-init', rule, {
  valid: [
    // Factory pattern — no init export, no underscore-let
    "function createThing({ db }) { return { run: () => db.q() }; }\nmodule.exports = { createThing };",

    // Module with init but no underscore-let (e.g. one-shot setup, no module state)
    "function init() { console.log('boot'); }\nmodule.exports = { init };",

    // Module with underscore-let but no init export (private helpers)
    "let _cache = null;\nfunction get() { return _cache; }\nmodule.exports = { get };",

    // Allowlisted file
    {
      code: "let _db = null;\nfunction init({ db }) { _db = db; }\nmodule.exports = { init };",
      options: [{ allowlist: ['legacy-module.js'] }],
      filename: '/srv/server/legacy-module.js',
    },
  ],
  invalid: [
    // Classic pattern: init + underscore-let
    {
      code: "let _db = null;\nfunction init({ db }) { _db = db; }\nmodule.exports = { init };",
      errors: [{ messageId: 'imperativeInit' }],
    },

    // module.exports.init = ... shape
    {
      code: "let _db = null;\nmodule.exports.init = function ({ db }) { _db = db; };",
      errors: [{ messageId: 'imperativeInit' }],
    },

    // Multiple underscore-lets and a longer init
    {
      code: [
        "let _db = null;",
        "let _logger = null;",
        "function init({ db, logger }) { _db = db; _logger = logger; }",
        "function doThing() { return _db.q(); }",
        "module.exports = { init, doThing };",
      ].join('\n'),
      errors: [{ messageId: 'imperativeInit' }],
    },
  ],
});

describe('no-imperative-init', () => {
  it('passes RuleTester suite', () => {
    expect(true).toBe(true);
  });
});
