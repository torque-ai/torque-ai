'use strict';
const fs = require('fs');
const path = require('path');

describe('auto-recovery REST route', () => {
  it('factory-routes.js registers /projects/:id/recovery_history', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'routes', 'factory-routes.js'), 'utf8');
    expect(src).toMatch(/recovery_history/);
  });
});
