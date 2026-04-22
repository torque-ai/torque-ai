'use strict';

const { parseSpec, parseSpecString } = require('./parse');
const { discoverSpecs } = require('./discover');
const { WORKFLOW_SPEC_SCHEMA } = require('./schema');

module.exports = {
  parseSpec,
  parseSpecString,
  discoverSpecs,
  WORKFLOW_SPEC_SCHEMA,
};
