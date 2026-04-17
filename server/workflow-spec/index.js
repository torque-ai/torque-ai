'use strict';

const { parseSpec, parseSpecString } = require('./parse');
const { WORKFLOW_SPEC_SCHEMA } = require('./schema');
const { resolveExtends } = require('./extends');

module.exports = {
  parseSpec,
  parseSpecString,
  resolveExtends,
  WORKFLOW_SPEC_SCHEMA,
};
