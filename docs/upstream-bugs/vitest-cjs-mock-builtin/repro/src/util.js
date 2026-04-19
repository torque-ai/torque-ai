'use strict';

const { execFileSync } = require('child_process');

// Read git user.name at module load — this is the call we want to mock.
let user = '';
try {
  user = execFileSync('git', ['config', 'user.name'], { encoding: 'utf8' }).trim();
} catch {
  // git not configured or unavailable
}

module.exports = { user };
