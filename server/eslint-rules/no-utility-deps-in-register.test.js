'use strict';

const { RuleTester } = require('eslint');
const rule = require('./no-utility-deps-in-register');

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'commonjs',
  },
});

tester.run('no-utility-deps-in-register', rule, {
  valid: [
    // All deps are known services
    "container.register('myThing', ['db', 'eventBus', 'logger'], (deps) => {});",

    // Real services with capability-decomposition names
    "container.register('foo', ['db', 'taskCanceller', 'taskExecutor'], (deps) => {});",

    // Empty deps
    "container.register('foo', [], () => {});",

    // Non-register call sites — rule shouldn't fire
    "container.foo('bar', ['parseCommand']);",
    "registerSomething('parseCommand', 'sanitizeOutput');",

    // First arg not a string (still a register call but malformed) — silently skip
    "container.register(name, ['parseCommand'], factory);",

    // Allowlisted file
    {
      code: "container.register('foo', ['parseCommand'], () => {});",
      options: [{ allowlist: ['legacy-module.js'] }],
      filename: '/srv/server/legacy-module.js',
    },

    // Names that don't match utility/constant patterns — likely real services
    // (rule is intentionally heuristic; misses are acceptable, false positives are not)
    "container.register('foo', ['someCustomThing'], () => {});",
  ],
  invalid: [
    // Classic utility-function names
    {
      code: "container.register('cmd', ['db', 'parseCommand', 'sanitizeOutput'], (deps) => {});",
      errors: [
        { messageId: 'utilityDep', data: { name: 'parseCommand' } },
        { messageId: 'utilityDep', data: { name: 'sanitizeOutput' } },
      ],
    },

    // task-manager closures
    {
      code: "container.register('queue', ['db', 'attemptTaskStart', 'safeStartTask'], (deps) => {});",
      errors: [
        { messageId: 'utilityDep', data: { name: 'attemptTaskStart' } },
        { messageId: 'utilityDep', data: { name: 'safeStartTask' } },
      ],
    },

    // CONSTANT-shaped names
    {
      code: "container.register('streams', ['db', 'MAX_OUTPUT_BUFFER'], (deps) => {});",
      errors: [{ messageId: 'constantDep', data: { name: 'MAX_OUTPUT_BUFFER' } }],
    },

    // Mixed real services + utility (only utility flagged)
    {
      code: "container.register('mix', ['db', 'logger', 'computeLineHash'], (deps) => {});",
      errors: [{ messageId: 'utilityDep', data: { name: 'computeLineHash' } }],
    },

    // Verb-prefixed names commonly seen during the deferred-aggregator audit
    {
      code: "container.register('thing', ['handleFoo', 'runBar', 'evaluateBaz'], () => {});",
      errors: [
        { messageId: 'utilityDep', data: { name: 'handleFoo' } },
        { messageId: 'utilityDep', data: { name: 'runBar' } },
        { messageId: 'utilityDep', data: { name: 'evaluateBaz' } },
      ],
    },
  ],
});

console.log('no-utility-deps-in-register tests passed');
