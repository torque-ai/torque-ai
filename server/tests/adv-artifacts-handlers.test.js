const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');
const path = require('path');
const fs = require('fs');
const _os = require('os');
const crypto = require('crypto');

let db;
let testDir;

// Helper: create a task directly in the DB and return its ID
function createTaskDirect(description) {
  const id = crypto.randomUUID();
  db.createTask({
    id,
    task_description: description || 'artifact test task',
    working_directory: process.env.TORQUE_DATA_DIR,
    status: 'queued',
    priority: 0,
    project: null
  });
  return id;
}

// Helper: create a temporary file with content, return its path
function createTempFile(name, content) {
  const filePath = path.join(testDir, name);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

describe('Adv Artifacts Handlers', () => {
  beforeAll(() => {
    const setup = setupTestDb('adv-artifacts');
    db = setup.db;
    testDir = setup.testDir;
  });
  afterAll(() => { teardownTestDb(); });

  // ── store_artifact ──────────────────────────────────────────────────

  describe('store_artifact', () => {
    it('stores an artifact for a task', async () => {
      const taskId = createTaskDirect('store test');
      const filePath = createTempFile('test-artifact.txt', 'hello world');

      const result = await safeTool('store_artifact', {
        task_id: taskId,
        name: 'test-artifact.txt',
        file_path: filePath
      });
      const text = getText(result);
      expect(result.isError).toBeFalsy();
      expect(text).toContain('Artifact Stored');
      expect(text).toContain('test-artifact.txt');
      expect(text).toContain('Checksum');
    });

    it('stores an artifact with metadata', async () => {
      const taskId = createTaskDirect('metadata test');
      const filePath = createTempFile('meta-artifact.json', '{"key":"value"}');

      const result = await safeTool('store_artifact', {
        task_id: taskId,
        name: 'meta-artifact.json',
        file_path: filePath,
        metadata: { source: 'unit-test', version: 2 }
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Artifact Stored');
    });

    it('rejects missing file_path', async () => {
      const taskId = createTaskDirect('no file');
      const result = await safeTool('store_artifact', {
        task_id: taskId,
        name: 'test.txt'
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('file_path is required');
    });

    it('rejects non-existent file', async () => {
      const taskId = createTaskDirect('missing file');
      const result = await safeTool('store_artifact', {
        task_id: taskId,
        name: 'test.txt',
        file_path: path.join(testDir, 'does-not-exist.txt')
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('File not found');
    });

    it('rejects non-existent task', async () => {
      const filePath = createTempFile('orphan.txt', 'no task');
      const result = await safeTool('store_artifact', {
        task_id: '00000000-0000-0000-0000-000000000000',
        name: 'orphan.txt',
        file_path: filePath
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Task not found');
    });

    it('rejects artifact name with invalid characters', async () => {
      const taskId = createTaskDirect('bad name');
      const filePath = createTempFile('ok.txt', 'content');
      const result = await safeTool('store_artifact', {
        task_id: taskId,
        name: 'bad<name>.txt',
        file_path: filePath
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('invalid characters');
    });

    it('rejects artifact name exceeding 255 chars', async () => {
      const taskId = createTaskDirect('long name');
      const filePath = createTempFile('ok2.txt', 'content');
      const result = await safeTool('store_artifact', {
        task_id: taskId,
        name: 'a'.repeat(256),
        file_path: filePath
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('1-255 characters');
    });

    it('rejects empty artifact name', async () => {
      const taskId = createTaskDirect('empty name');
      const filePath = createTempFile('ok3.txt', 'content');
      const result = await safeTool('store_artifact', {
        task_id: taskId,
        name: '',
        file_path: filePath
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('1-255 characters');
    });

    it('rejects deeply nested metadata', async () => {
      const taskId = createTaskDirect('deep metadata');
      const filePath = createTempFile('ok4.txt', 'content');
      let nested = { a: 1 };
      for (let i = 0; i < 20; i++) {
        nested = { child: nested };
      }
      const result = await safeTool('store_artifact', {
        task_id: taskId,
        name: 'ok4.txt',
        file_path: filePath,
        metadata: nested
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Invalid metadata');
    });

    it('rejects path traversal attempts', async () => {
      const taskId = createTaskDirect('traversal');
      const result = await safeTool('store_artifact', {
        task_id: taskId,
        name: 'test.txt',
        file_path: '/tmp/../../../etc/passwd'
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('path traversal');
    });
  });

  // ── list_artifacts ──────────────────────────────────────────────────

  describe('list_artifacts', () => {
    it('lists artifacts for a task with stored artifacts', async () => {
      const taskId = createTaskDirect('list test');
      const filePath1 = createTempFile('list-a.txt', 'content a');
      const filePath2 = createTempFile('list-b.txt', 'content b');

      await safeTool('store_artifact', { task_id: taskId, name: 'list-a.txt', file_path: filePath1 });
      await safeTool('store_artifact', { task_id: taskId, name: 'list-b.txt', file_path: filePath2 });

      const result = await safeTool('list_artifacts', { task_id: taskId });
      const text = getText(result);
      expect(result.isError).toBeFalsy();
      expect(text).toContain('list-a.txt');
      expect(text).toContain('list-b.txt');
      expect(text).toContain('Total:** 2');
    });

    it('returns empty message when task has no artifacts', async () => {
      const taskId = createTaskDirect('empty list');
      const result = await safeTool('list_artifacts', { task_id: taskId });
      const text = getText(result);
      expect(result.isError).toBeFalsy();
      expect(text).toContain('No artifacts found');
    });
  });

  // ── get_artifact ────────────────────────────────────────────────────

  describe('get_artifact', () => {
    it('retrieves artifact by artifact_id', async () => {
      const taskId = createTaskDirect('get by id');
      const filePath = createTempFile('get-by-id.txt', 'get content');
      const storeResult = await safeTool('store_artifact', {
        task_id: taskId,
        name: 'get-by-id.txt',
        file_path: filePath
      });
      const storeText = getText(storeResult);
      const idMatch = storeText.match(/\*\*ID:\*\*\s+([a-f0-9-]{36})/);
      const artifactId = idMatch ? idMatch[1] : null;
      expect(artifactId).toBeTruthy();

      const result = await safeTool('get_artifact', { artifact_id: artifactId });
      const text = getText(result);
      expect(result.isError).toBeFalsy();
      expect(text).toContain('get-by-id.txt');
      expect(text).toContain(artifactId);
      expect(text).toContain('Checksum');
    });

    it('retrieves artifact by task_id + name', async () => {
      const taskId = createTaskDirect('get by name');
      const filePath = createTempFile('get-by-name.txt', 'name content');
      await safeTool('store_artifact', {
        task_id: taskId,
        name: 'get-by-name.txt',
        file_path: filePath
      });

      const result = await safeTool('get_artifact', { task_id: taskId, name: 'get-by-name.txt' });
      const text = getText(result);
      expect(result.isError).toBeFalsy();
      expect(text).toContain('get-by-name.txt');
    });

    it('returns error for non-existent artifact', async () => {
      const result = await safeTool('get_artifact', {
        artifact_id: '00000000-0000-0000-0000-000000000000'
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('not found');
    });

    it('returns error when no identifier provided', async () => {
      const result = await safeTool('get_artifact', {});
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('not found');
    });
  });

  // ── delete_artifact ─────────────────────────────────────────────────

  describe('delete_artifact', () => {
    it('deletes an existing artifact', async () => {
      const taskId = createTaskDirect('delete test');
      const filePath = createTempFile('delete-me.txt', 'delete content');
      const storeResult = await safeTool('store_artifact', {
        task_id: taskId,
        name: 'delete-me.txt',
        file_path: filePath
      });
      const storeText = getText(storeResult);
      const idMatch = storeText.match(/\*\*ID:\*\*\s+([a-f0-9-]{36})/);
      const artifactId = idMatch ? idMatch[1] : null;
      expect(artifactId).toBeTruthy();

      const result = await safeTool('delete_artifact', { artifact_id: artifactId });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('deleted');

      // Verify it's gone
      const getResult = await safeTool('get_artifact', { artifact_id: artifactId });
      expect(getResult.isError).toBe(true);
      expect(getText(getResult)).toContain('not found');
    });

    it('returns error for non-existent artifact', async () => {
      const result = await safeTool('delete_artifact', {
        artifact_id: '00000000-0000-0000-0000-000000000000'
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('not found');
    });
  });

  // ── configure_artifact_storage ──────────────────────────────────────

  describe('configure_artifact_storage', () => {
    it('shows current config without updates', async () => {
      const result = await safeTool('configure_artifact_storage', {});
      const text = getText(result);
      expect(result.isError).toBeFalsy();
      expect(text).toContain('Artifact Storage Configuration');
      expect(text).toContain('Current Settings');
    });

    it('updates max_size_mb', async () => {
      const result = await safeTool('configure_artifact_storage', { max_size_mb: 100 });
      const text = getText(result);
      expect(result.isError).toBeFalsy();
      expect(text).toContain('max_size_mb = 100');
      expect(text).toContain('100');
    });

    it('updates retention_days', async () => {
      const result = await safeTool('configure_artifact_storage', { retention_days: 60 });
      const text = getText(result);
      expect(result.isError).toBeFalsy();
      expect(text).toContain('retention_days = 60');
    });

    it('updates max_per_task', async () => {
      const result = await safeTool('configure_artifact_storage', { max_per_task: 50 });
      const text = getText(result);
      expect(result.isError).toBeFalsy();
      expect(text).toContain('max_per_task = 50');
    });

    it('updates storage_path', async () => {
      const newPath = path.join(testDir, 'custom-artifacts');
      const result = await safeTool('configure_artifact_storage', { storage_path: newPath });
      const text = getText(result);
      expect(result.isError).toBeFalsy();
      expect(text).toContain('storage_path');
      expect(text).toContain(newPath);
    });

    it('updates multiple settings at once', async () => {
      const result = await safeTool('configure_artifact_storage', {
        max_size_mb: 200,
        retention_days: 90,
        max_per_task: 30
      });
      const text = getText(result);
      expect(result.isError).toBeFalsy();
      expect(text).toContain('max_size_mb = 200');
      expect(text).toContain('retention_days = 90');
      expect(text).toContain('max_per_task = 30');
    });
  });

  // ── export_artifacts ────────────────────────────────────────────────

  describe('export_artifacts', () => {
    it('returns error when task has no artifacts', async () => {
      const taskId = createTaskDirect('export empty');
      const result = await safeTool('export_artifacts', { task_id: taskId });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('No artifacts found');
    });
  });
});
