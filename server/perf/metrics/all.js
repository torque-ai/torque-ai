'use strict';

require('../metrics').register(require('./queue-scheduler-tick'));
require('../metrics').register(require('./task-core-create'));
require('../metrics').register(require('./governance-evaluate'));
require('../metrics').register(require('./handler-project-stats'));
require('../metrics').register(require('./mcp-task-info'));
require('../metrics').register(require('./sse-dispatch'));
