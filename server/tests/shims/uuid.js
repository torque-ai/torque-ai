'use strict';

const { randomUUID } = require('crypto');

function v4() {
  return randomUUID();
}

module.exports = {
  v4,
  default: { v4 },
  NIL: '00000000-0000-0000-0000-000000000000',
};
