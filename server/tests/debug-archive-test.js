'use strict';
process.chdir(__dirname + '/..');
const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');
const { v4: uuidv4 } = require('uuid');

async function main() {
  const setup = setupTestDb('debug-archive');
  const db = setup.db;

  const taskId = uuidv4();
  db.createTask({ id: taskId, status: 'pending', task_description: 'test archive', timeout_minutes: 10 });
  db.updateTaskStatus(taskId, 'running', { started_at: new Date().toISOString() });
  db.updateTaskStatus(taskId, 'completed', {});

  const task = db.getTask(taskId);
  console.log('Task status:', task.status, 'id:', taskId);

  const result = await safeTool('archive_task', { task_id: taskId, reason: 'Test cleanup' });
  console.log('isError:', result.isError);
  console.log('content:', JSON.stringify(result.content?.slice(0, 1)));

  teardownTestDb();
}

main().catch(e => console.error('ERROR:', e.message, e.stack));
