'use strict';

/**
 * Legacy compatibility alias.
 *
 * Runtime startup code should import `./runtime-store` directly. This
 * `database.js` entrypoint exists only for modules that have not finished the
 * DI/runtime-store migration yet.
 */
module.exports = require('./runtime-store');
