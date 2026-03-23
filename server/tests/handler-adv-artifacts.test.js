const fs = require('fs');
const os = require('os');
const path = require('path');
const taskCore = require('../db/task-core');
const taskMetadata = require('../db/task-metadata');
const logger = require('../logger');

function loadHandlers() {
  delete require.cache[require.resolve('../handlers/advanced/artifacts')];
  return require('../handlers/advanced/artifacts');
}

const handlers = new Proxy({}, {
  get(_target, prop) {
    return loadHandlers()[prop];
  },
});

function textOf(result) {
  return result?.content?.[0]?.text || '';
}

const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-adv-artifacts-'));
  tempDirs.push(dir);
  return dir;
}

function writeTempFile(dir, fileName, content) {
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, content);
  return filePath;
}

function cleanupTempDirs() {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  }
}

describe('handler:adv-artifacts', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanupTempDirs();
    vi.clearAllMocks();
  });

  describe('handleStoreArtifact', () => {
    it('returns INVALID_PARAM when args is not an object', () => {
      const result = handlers.handleStoreArtifact(null);

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(textOf(result)).toContain('Arguments object is required');
    });

    it('returns INVALID_PARAM for artifact names with unsafe characters', () => {
      const result = handlers.handleStoreArtifact({
        task_id: 'task-1',
        name: 'bad<name>.txt',
        file_path: '/tmp/file.txt'
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(textOf(result)).toContain('invalid characters');
    });

    it('returns MISSING_REQUIRED_PARAM when file_path is missing', () => {
      const result = handlers.handleStoreArtifact({
        task_id: 'task-1',
        name: 'artifact.txt'
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(textOf(result)).toContain('file_path is required');
    });

    it('returns TASK_NOT_FOUND when task does not exist', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue(null);

      const dir = makeTempDir();
      const filePath = writeTempFile(dir, 'artifact.txt', 'hello');

      const result = handlers.handleStoreArtifact({
        task_id: 'task-missing',
        name: 'artifact.txt',
        file_path: filePath
      });

      expect(taskCore.getTask).toHaveBeenCalledWith('task-missing');
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
    });

    it('returns RESOURCE_NOT_FOUND when source file does not exist', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue({ id: 'task-1' });
      vi.spyOn(taskMetadata, 'getArtifactConfig').mockReturnValue({
        max_size_mb: '10',
        storage_path: makeTempDir()
      });

      const result = handlers.handleStoreArtifact({
        task_id: 'task-1',
        name: 'missing.txt',
        file_path: path.join(makeTempDir(), 'missing.txt')
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('RESOURCE_NOT_FOUND');
      expect(textOf(result)).toContain('File not found');
    });

    it('returns INVALID_PARAM when source path is not a regular file', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue({ id: 'task-1' });
      vi.spyOn(taskMetadata, 'getArtifactConfig').mockReturnValue({
        max_size_mb: '10',
        storage_path: makeTempDir()
      });
      vi.spyOn(fs, 'openSync').mockReturnValue(42);
      vi.spyOn(fs, 'fstatSync').mockReturnValue({
        isFile: () => false,
        size: 10
      });
      const closeSpy = vi.spyOn(fs, 'closeSync').mockReturnValue(undefined);

      const result = handlers.handleStoreArtifact({
        task_id: 'task-1',
        name: 'fake.txt',
        file_path: '/tmp/fake.txt'
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(closeSpy).toHaveBeenCalledWith(42);
      expect(textOf(result)).toContain('Not a regular file');
    });

    it('returns INVALID_PARAM when file exceeds configured max size', () => {
      vi.spyOn(taskCore, 'getTask').mockReturnValue({ id: 'task-1' });
      vi.spyOn(taskMetadata, 'getArtifactConfig').mockReturnValue({
        max_size_mb: '1',
        storage_path: makeTempDir()
      });
      vi.spyOn(fs, 'openSync').mockReturnValue(7);
      vi.spyOn(fs, 'fstatSync').mockReturnValue({
        isFile: () => true,
        size: 2 * 1024 * 1024
      });
      const closeSpy = vi.spyOn(fs, 'closeSync').mockReturnValue(undefined);

      const result = handlers.handleStoreArtifact({
        task_id: 'task-1',
        name: 'big.txt',
        file_path: '/tmp/big.txt'
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(closeSpy).toHaveBeenCalledWith(7);
      expect(textOf(result)).toContain('exceeds maximum size');
    });

    it('stores text artifact with metadata and infers text/plain content type', () => {
      const sourceDir = makeTempDir();
      const storageDir = makeTempDir();
      const sourcePath = writeTempFile(sourceDir, 'notes.txt', 'alpha\nbeta\n');

      vi.spyOn(taskCore, 'getTask').mockReturnValue({ id: 'task-1' });
      vi.spyOn(taskMetadata, 'getArtifactConfig').mockReturnValue({
        max_size_mb: '10',
        storage_path: storageDir
      });
      const storeSpy = vi.spyOn(taskMetadata, 'storeArtifact').mockImplementation((artifact) => ({
        ...artifact,
        name: artifact.name || 'notes.txt',
        created_at: '2026-01-01T00:00:00.000Z',
        expires_at: '2026-12-31T00:00:00.000Z'
      }));

      const result = handlers.handleStoreArtifact({
        task_id: 'task-1',
        name: 'notes.txt',
        file_path: sourcePath,
        metadata: { source: 'unit-test' }
      });

      expect(result.isError).toBeFalsy();
      expect(storeSpy).toHaveBeenCalledWith(expect.objectContaining({
        task_id: 'task-1',
        name: 'notes.txt',
        mime_type: 'text/plain',
        metadata: { source: 'unit-test' },
        checksum: expect.any(String),
        file_path: expect.stringContaining(path.join(storageDir, 'task-1'))
      }));
      expect(textOf(result)).toContain('Artifact Stored');
      expect(textOf(result)).toContain('Type:** text/plain');
    });

    it('stores json artifact and infers application/json content type', () => {
      const sourceDir = makeTempDir();
      const storageDir = makeTempDir();
      const sourcePath = writeTempFile(sourceDir, 'result.json', '{"ok":true}');

      vi.spyOn(taskCore, 'getTask').mockReturnValue({ id: 'task-json' });
      vi.spyOn(taskMetadata, 'getArtifactConfig').mockReturnValue({
        max_size_mb: '10',
        storage_path: storageDir
      });
      const storeSpy = vi.spyOn(taskMetadata, 'storeArtifact').mockImplementation((artifact) => ({
        ...artifact,
        name: artifact.name || 'result.json',
        created_at: '2026-01-01T00:00:00.000Z',
        expires_at: '2026-12-31T00:00:00.000Z'
      }));

      const result = handlers.handleStoreArtifact({
        task_id: 'task-json',
        name: 'result.json',
        file_path: sourcePath
      });

      expect(result.isError).toBeFalsy();
      expect(storeSpy).toHaveBeenCalledWith(expect.objectContaining({
        mime_type: 'application/json'
      }));
    });

    it('rejects blocked artifact type and cleans up copied file', () => {
      const sourceDir = makeTempDir();
      const storageDir = makeTempDir();
      const sourcePath = writeTempFile(sourceDir, 'payload.exe', 'MZ-fake');

      vi.spyOn(taskCore, 'getTask').mockReturnValue({ id: 'task-1' });
      vi.spyOn(taskMetadata, 'getArtifactConfig').mockReturnValue({
        max_size_mb: '10',
        storage_path: storageDir
      });
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync');

      const result = handlers.handleStoreArtifact({
        task_id: 'task-1',
        name: 'payload.exe',
        file_path: sourcePath
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(textOf(result)).toContain('Artifact rejected');
      expect(unlinkSpy).toHaveBeenCalled();
    });

    it('cleans up orphaned file when database insert fails', () => {
      const sourceDir = makeTempDir();
      const storageDir = makeTempDir();
      const sourcePath = writeTempFile(sourceDir, 'db-fail.txt', 'artifact body');
      const taskId = 'task-42';

      vi.spyOn(taskCore, 'getTask').mockReturnValue({ id: taskId });
      vi.spyOn(taskMetadata, 'getArtifactConfig').mockReturnValue({
        max_size_mb: '10',
        storage_path: storageDir
      });
      vi.spyOn(taskMetadata, 'storeArtifact').mockImplementation(() => {
        throw new Error('insert failed');
      });

      const result = handlers.handleStoreArtifact({
        task_id: taskId,
        name: 'db-fail.txt',
        file_path: sourcePath
      });

      const taskDir = path.join(storageDir, taskId);
      const files = fs.existsSync(taskDir) ? fs.readdirSync(taskDir) : [];

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('OPERATION_FAILED');
      expect(textOf(result)).toContain('Error storing artifact');
      expect(files).toHaveLength(0);
    });
  });

  describe('handleListArtifacts', () => {
    it('returns MISSING_REQUIRED_PARAM when task_id is missing', () => {
      const result = handlers.handleListArtifacts({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(textOf(result)).toContain('task_id is required');
    });

    it('lists artifacts with table output and total count', () => {
      vi.spyOn(taskMetadata, 'listArtifacts').mockReturnValue([
        {
          id: 'a1',
          name: 'notes.txt',
          size_bytes: 2048,
          mime_type: 'text/plain',
          created_at: '2026-01-01T00:00:00.000Z'
        },
        {
          id: 'a2',
          name: 'result.json',
          size_bytes: 1024,
          mime_type: 'application/json',
          created_at: '2026-01-02T00:00:00.000Z'
        }
      ]);

      const result = handlers.handleListArtifacts({ task_id: 'task-abcdef123456' });

      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('Artifacts for Task task-abc');
      expect(textOf(result)).toContain('| notes.txt | 2.0 KB | text/plain |');
      expect(textOf(result)).toContain('| result.json | 1.0 KB | application/json |');
      expect(textOf(result)).toContain('**Total:** 2 artifacts');
    });
  });

  describe('handleGetArtifact', () => {
    it('returns INVALID_PARAM when args is not an object', () => {
      const result = handlers.handleGetArtifact(null);

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(textOf(result)).toContain('Arguments object is required');
    });

    it('returns RESOURCE_NOT_FOUND when artifact cannot be resolved', () => {
      vi.spyOn(taskMetadata, 'getArtifact').mockReturnValue(null);

      const result = handlers.handleGetArtifact({ artifact_id: 'missing-id' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('RESOURCE_NOT_FOUND');
      expect(textOf(result)).toContain('Artifact not found');
    });

    it('retrieves artifact by artifact_id', () => {
      vi.spyOn(taskMetadata, 'getArtifact').mockReturnValue({
        id: 'art-1',
        task_id: 'task-1',
        name: 'notes.txt',
        size_bytes: 1024,
        mime_type: 'text/plain',
        checksum: 'abcd1234',
        file_path: '/tmp/notes.txt',
        created_at: '2026-01-01T00:00:00.000Z',
        expires_at: '2026-12-31T00:00:00.000Z',
        metadata: null
      });

      const result = handlers.handleGetArtifact({ artifact_id: 'art-1' });

      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('## Artifact: notes.txt');
      expect(textOf(result)).toContain('**ID:** art-1');
      expect(textOf(result)).toContain('**Type:** text/plain');
    });

    it('supports lookup by task_id + name and includes metadata/content with truncation', () => {
      const dir = makeTempDir();
      const longContent = 'x'.repeat(5100);
      const filePath = writeTempFile(dir, 'big.txt', longContent);

      vi.spyOn(taskMetadata, 'listArtifacts').mockReturnValue([
        {
          id: 'art-2',
          task_id: 'task-2',
          name: 'big.txt',
          size_bytes: longContent.length,
          mime_type: 'text/plain',
          checksum: 'hash',
          file_path: filePath,
          created_at: '2026-01-01T00:00:00.000Z',
          expires_at: '2026-12-31T00:00:00.000Z',
          metadata: { kind: 'log' }
        }
      ]);

      const result = handlers.handleGetArtifact({
        task_id: 'task-2',
        name: 'big.txt',
        include_content: true
      });

      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('### Metadata');
      expect(textOf(result)).toContain('"kind": "log"');
      expect(textOf(result)).toContain('### Content');
      expect(textOf(result)).toContain('truncated, 5100 total characters');
    });

    it('returns readable error in output when content read fails', () => {
      vi.spyOn(taskMetadata, 'getArtifact').mockReturnValue({
        id: 'art-3',
        task_id: 'task-3',
        name: 'bad.txt',
        size_bytes: 32,
        mime_type: 'text/plain',
        checksum: 'hash',
        file_path: '/tmp/missing.txt',
        created_at: '2026-01-01T00:00:00.000Z',
        expires_at: '2026-12-31T00:00:00.000Z',
        metadata: null
      });
      vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => {
        throw new Error('disk failure');
      });

      const result = handlers.handleGetArtifact({
        artifact_id: 'art-3',
        include_content: true
      });

      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('Could not read content: disk failure');
    });
  });

  describe('handleDeleteArtifact', () => {
    it('returns MISSING_REQUIRED_PARAM when artifact_id is missing', () => {
      const result = handlers.handleDeleteArtifact({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(textOf(result)).toContain('artifact_id is required');
    });

    it('returns RESOURCE_NOT_FOUND when artifact does not exist', () => {
      vi.spyOn(taskMetadata, 'getArtifact').mockReturnValue(null);

      const result = handlers.handleDeleteArtifact({ artifact_id: 'nope' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('RESOURCE_NOT_FOUND');
      expect(textOf(result)).toContain('Artifact not found');
    });

    it('deletes database row even when filesystem deletion fails', () => {
      vi.spyOn(taskMetadata, 'getArtifact').mockReturnValue({
        id: 'art-1',
        name: 'artifact.txt',
        file_path: '/tmp/artifact.txt'
      });
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {
        throw new Error('permission denied');
      });
      const debugSpy = vi.spyOn(logger.constructor.prototype, 'debug').mockReturnValue(undefined);
      const deleteSpy = vi.spyOn(taskMetadata, 'deleteArtifact').mockReturnValue(undefined);

      const result = handlers.handleDeleteArtifact({ artifact_id: 'art-1' });

      expect(deleteSpy).toHaveBeenCalledWith('art-1');
      expect(debugSpy).toHaveBeenCalled();
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('Artifact deleted: artifact.txt');
    });
  });

  describe('handleConfigureArtifactStorage', () => {
    it('returns INVALID_PARAM when args is not an object', () => {
      const result = handlers.handleConfigureArtifactStorage(null);

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(textOf(result)).toContain('Arguments object is required');
    });

    it('updates configuration values and validates numeric inputs', () => {
      const setSpy = vi.spyOn(taskMetadata, 'setArtifactConfig').mockReturnValue(undefined);
      vi.spyOn(taskMetadata, 'getArtifactConfig').mockReturnValue({
        storage_path: '/data/artifacts',
        max_size_mb: '25',
        retention_days: '30',
        max_per_task: '5'
      });

      const result = handlers.handleConfigureArtifactStorage({
        storage_path: '/data/artifacts',
        max_size_mb: 25,
        retention_days: 30,
        max_per_task: 5
      });

      expect(setSpy).toHaveBeenCalledWith('storage_path', '/data/artifacts');
      expect(setSpy).toHaveBeenCalledWith('max_size_mb', '25');
      expect(setSpy).toHaveBeenCalledWith('retention_days', '30');
      expect(setSpy).toHaveBeenCalledWith('max_per_task', '5');
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('Artifact Storage Configuration');
      expect(textOf(result)).toContain('max_size_mb = 25');
      expect(textOf(result)).toContain('| Max per Task | 5 |');
    });
  });

  describe('handleExportArtifacts', () => {
    it('returns MISSING_REQUIRED_PARAM when task_id is missing', async () => {
      const result = await handlers.handleExportArtifacts({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(textOf(result)).toContain('task_id is required');
    });

    it('returns RESOURCE_NOT_FOUND when no artifacts exist for the task', async () => {
      vi.spyOn(taskMetadata, 'listArtifacts').mockReturnValue([]);

      const result = await handlers.handleExportArtifacts({ task_id: 'task-empty' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('RESOURCE_NOT_FOUND');
      expect(textOf(result)).toContain('No artifacts found for this task');
    });
  });
});
