'use strict';

const fs = require('fs');
const path = require('path');

describe('codegraph plugin registration', () => {
  it('is listed in DEFAULT_PLUGIN_NAMES in server/index.js', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'index.js'), 'utf8');
    expect(src).toMatch(/DEFAULT_PLUGIN_NAMES[\s\S]*'codegraph'/);
  });
});
