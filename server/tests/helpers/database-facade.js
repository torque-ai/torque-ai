'use strict';

/**
 * Central test boundary for the legacy database facade.
 *
 * Tests that need the resetForTest/getDbInstance facade should import this
 * helper instead of reaching through `../database` directly. The direct import
 * stays isolated here so the production DI migration guard can ratchet test
 * code without blocking the few facade-specific tests that intentionally cover
 * server/database.js itself.
 */
module.exports = require('../../database');
