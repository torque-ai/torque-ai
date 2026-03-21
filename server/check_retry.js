'use strict';
process.chdir(__dirname);
const {setupTestDb, safeTool, getText, teardownTestDb} = require('./tests/vitest-setup');
const s = setupTestDb('t');
const db = s.db;

async function run() {
  const qr = await safeTool('queue_task', { task: 'Retry adaptation test' });
  const text = getText(qr);
  const match = text.match(/ID:\s*([a-f0-9-]{36})/i) || text.match(/([a-f0-9-]{36})/);
  const taskId = match ? match[1] : null;
  console.log('taskId:', taskId);

  db.updateTaskStatus(taskId, 'running');
  db.updateTaskStatus(taskId, 'failed', { error_output: 'OOM killed', exit_code: 137 });

  const result = await safeTool('retry_with_adaptation', { task_id: taskId });
  console.log('isError:', result.isError);
  console.log('text:', getText(result));
  teardownTestDb();
}
run().catch(e => { console.error(e.message, e.stack); teardownTestDb(); });
