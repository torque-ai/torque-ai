'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const Module = require('module');

const { dbMock, taskManagerMock, loggerMock, loggerModuleMock } = vi.hoisted(() => ({
  dbMock: {
    getTask: vi.fn(),
    getArtifactConfig: vi.fn(),
    storeArtifact: vi.fn(),
    listArtifacts: vi.fn(),
    getArtifact: vi.fn(),
    deleteArtifact: vi.fn(),
    setArtifactConfig: vi.fn(),
  },
  taskManagerMock: {
    noop: vi.fn(),
  },
  loggerMock: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  loggerModuleMock: {
    child: vi.fn(),
  },
}));

// require.cache manipulation is used here only for the handler modules and the
// current sub-module boundaries they import. The artifacts handler now binds to
// db/task-metadata.js, and shared.requireTask resolves through db/task-core.js.
// Replacing those cache entries keeps the handler on the mocked path.
let handlers;
let shared;
const taskMetadataModulePath = require.resolve('../db/task-metadata');
const taskCoreModulePath = require.resolve('../db/task-core');
const taskManagerModulePath = require.resolve('../task-manager');
const loggerModulePath = require.resolve('../logger');
const artifactsHandlerPath = require.resolve('../handlers/advanced/artifacts');
const sharedHandlerPath = require.resolve('../handlers/shared');
const originalModules = new Map();

const tempDirs = [];

function getText(result) {
  return result?.content?.[0]?.text || '';
}

function expectError(result, code, snippet) {
  expect(result.isError).toBe(true);
  expect(result.error_code).toBe(code);
  if (snippet) {
    expect(getText(result)).toContain(snippet);
  }
}

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-adv-artifact-handlers-'));
  tempDirs.push(dir);
  return dir;
}

function writeTempFile(dir, fileName, content) {
  const filePath = path.join(dir, fileName);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

function cleanupTempDirs() {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup.
    }
  }
}

function resetMocks() {
  for (const fn of Object.values(dbMock)) {
    if (typeof fn?.mockReset === 'function') {
      fn.mockReset();
    }
  }

  for (const fn of Object.values(taskManagerMock)) {
    if (typeof fn?.mockReset === 'function') {
      fn.mockReset();
    }
  }

  for (const fn of Object.values(loggerMock)) {
    if (typeof fn?.mockReset === 'function') {
      fn.mockReset();
    }
  }

  loggerModuleMock.child.mockReset();
  loggerModuleMock.child.mockReturnValue(loggerMock);
}

function makeArtifact(overrides = {}) {
  return {
    id: 'artifact-12345678',
    task_id: 'task-12345678',
    name: 'artifact.txt',
    file_path: path.join(os.tmpdir(), 'artifact.txt'),
    mime_type: 'text/plain',
    size_bytes: 1024,
    checksum: 'abc123def456',
    created_at: '2026-03-12T12:00:00.000Z',
    expires_at: '2026-04-12T12:00:00.000Z',
    metadata: null,
    ...overrides,
  };
}

describe('advanced artifact handlers', () => {
  beforeAll(() => {
    resetMocks();
    for (const [modulePath, exportsValue] of [
      [taskMetadataModulePath, {
        getArtifactConfig: dbMock.getArtifactConfig,
        storeArtifact: dbMock.storeArtifact,
        listArtifacts: dbMock.listArtifacts,
        getArtifact: dbMock.getArtifact,
        deleteArtifact: dbMock.deleteArtifact,
        setArtifactConfig: dbMock.setArtifactConfig,
      }],
      [taskCoreModulePath, {
        getTask: dbMock.getTask,
      }],
      [taskManagerModulePath, taskManagerMock],
      [loggerModulePath, loggerModuleMock],
    ]) {
      originalModules.set(modulePath, require.cache[modulePath]);
      require.cache[modulePath] = {
        id: modulePath,
        filename: modulePath,
        loaded: true,
        exports: exportsValue,
        children: [],
        paths: [],
      };
    }
    delete require.cache[artifactsHandlerPath];
    delete require.cache[sharedHandlerPath];
    handlers = require('../handlers/advanced/artifacts');
    shared = require('../handlers/shared');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    resetMocks();

    dbMock.getArtifactConfig.mockReturnValue({
      storage_path: makeTempDir(),
      max_size_mb: '10',
      retention_days: '30',
      max_per_task: '5',
    });

    dbMock.storeArtifact.mockImplementation((artifact) => ({
      ...artifact,
      name: artifact.name || path.basename(artifact.file_path),
      created_at: '2026-03-12T12:00:00.000Z',
      expires_at: '2026-04-12T12:00:00.000Z',
    }));

    dbMock.listArtifacts.mockReturnValue([]);
    dbMock.getArtifact.mockReturnValue(null);
    dbMock.deleteArtifact.mockReturnValue(undefined);
    dbMock.setArtifactConfig.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanupTempDirs();
  });

  afterAll(() => {
    delete require.cache[artifactsHandlerPath];
    delete require.cache[sharedHandlerPath];
    for (const modulePath of [taskMetadataModulePath, taskCoreModulePath, taskManagerModulePath, loggerModulePath]) {
      const original = originalModules.get(modulePath);
      if (original) {
        require.cache[modulePath] = original;
      } else {
        delete require.cache[modulePath];
      }
    }
  });

  describe('handleStoreArtifact', () => {
    it('returns INVALID_PARAM when args is not an object', () => {
      const result = handlers.handleStoreArtifact(null);

      expectError(result, shared.ErrorCodes.INVALID_PARAM.code, 'Arguments object is required');
    });

    it('returns INVALID_PARAM for unsafe artifact names', () => {
      const result = handlers.handleStoreArtifact({
        task_id: 'task-1',
        name: 'bad<name>.txt',
        file_path: 'artifact.txt',
      });

      expectError(result, shared.ErrorCodes.INVALID_PARAM.code, 'invalid characters');
    });

    it('returns INVALID_PARAM when metadata nesting is too deep', () => {
      let metadata = { leaf: true };
      for (let i = 0; i < 12; i += 1) {
        metadata = { child: metadata };
      }

      const result = handlers.handleStoreArtifact({
        task_id: 'task-1',
        name: 'artifact.txt',
        file_path: 'artifact.txt',
        metadata,
      });

      expectError(result, shared.ErrorCodes.INVALID_PARAM.code, 'Invalid metadata');
    });

    it('returns MISSING_REQUIRED_PARAM when file_path is missing', () => {
      const result = handlers.handleStoreArtifact({
        task_id: 'task-1',
        name: 'artifact.txt',
      });

      expectError(result, shared.ErrorCodes.MISSING_REQUIRED_PARAM.code, 'file_path is required');
    });

    it('returns PATH_TRAVERSAL when file_path is unsafe', () => {
      const result = handlers.handleStoreArtifact({
        task_id: 'task-1',
        name: 'artifact.txt',
        file_path: '../secret.txt',
      });

      expectError(result, shared.ErrorCodes.PATH_TRAVERSAL.code, 'path traversal not allowed');
    });

    it('returns TASK_NOT_FOUND when the task does not exist', () => {
      dbMock.getTask.mockReturnValue(null);

      const result = handlers.handleStoreArtifact({
        task_id: 'task-missing',
        name: 'artifact.txt',
        file_path: 'artifact.txt',
      });

      expect(dbMock.getTask).toHaveBeenCalledWith('task-missing');
      expectError(result, shared.ErrorCodes.TASK_NOT_FOUND.code, 'Task not found: task-missing');
    });

    it('returns INVALID_PARAM when the source path is not a regular file', () => {
      dbMock.getTask.mockReturnValue({ id: 'task-1' });
      const closeSync = vi.spyOn(fs, 'closeSync').mockReturnValue(undefined);
      vi.spyOn(fs, 'openSync').mockReturnValue(42);
      vi.spyOn(fs, 'fstatSync').mockReturnValue({
        isFile: () => false,
        size: 16,
      });

      const result = handlers.handleStoreArtifact({
        task_id: 'task-1',
        name: 'artifact.txt',
        file_path: 'artifact.txt',
      });

      expect(closeSync).toHaveBeenCalledWith(42);
      expectError(result, shared.ErrorCodes.INVALID_PARAM.code, 'Not a regular file');
    });

    it('returns INVALID_PARAM when the source file exceeds the configured max size', () => {
      dbMock.getTask.mockReturnValue({ id: 'task-1' });
      dbMock.getArtifactConfig.mockReturnValue({
        storage_path: makeTempDir(),
        max_size_mb: '1',
      });
      const closeSync = vi.spyOn(fs, 'closeSync').mockReturnValue(undefined);
      vi.spyOn(fs, 'openSync').mockReturnValue(7);
      vi.spyOn(fs, 'fstatSync').mockReturnValue({
        isFile: () => true,
        size: 2 * 1024 * 1024,
      });

      const result = handlers.handleStoreArtifact({
        task_id: 'task-1',
        name: 'artifact.txt',
        file_path: 'artifact.txt',
      });

      expect(closeSync).toHaveBeenCalledWith(7);
      expectError(result, shared.ErrorCodes.INVALID_PARAM.code, 'maximum size of 1MB');
    });

    it('returns OPERATION_FAILED when the artifact directory cannot be created', () => {
      dbMock.getTask.mockReturnValue({ id: 'task-1' });
      dbMock.getArtifactConfig.mockReturnValue({
        storage_path: path.join(makeTempDir(), 'storage-root'),
        max_size_mb: '10',
      });
      const closeSync = vi.spyOn(fs, 'closeSync').mockReturnValue(undefined);
      vi.spyOn(fs, 'openSync').mockReturnValue(99);
      vi.spyOn(fs, 'fstatSync').mockReturnValue({
        isFile: () => true,
        size: 24,
      });
      vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {
        throw new Error('mkdir failed');
      });

      const result = handlers.handleStoreArtifact({
        task_id: 'task-1',
        name: 'artifact.txt',
        file_path: 'artifact.txt',
      });

      expect(closeSync).toHaveBeenCalledWith(99);
      expectError(result, shared.ErrorCodes.OPERATION_FAILED.code, 'Cannot create artifact directory: mkdir failed');
    });

    it('returns OPERATION_FAILED and logs cleanup noise when copying fails before the destination exists', () => {
      const sourceDir = makeTempDir();
      const storageDir = makeTempDir();
      const sourcePath = writeTempFile(sourceDir, 'artifact.txt', 'content');

      dbMock.getTask.mockReturnValue({ id: 'task-1' });
      dbMock.getArtifactConfig.mockReturnValue({
        storage_path: storageDir,
        max_size_mb: '10',
      });
      vi.spyOn(fs, 'readSync').mockImplementation(() => {
        throw new Error('copy failed');
      });

      const result = handlers.handleStoreArtifact({
        task_id: 'task-1',
        name: 'artifact.txt',
        file_path: sourcePath,
      });

      expect(loggerMock.debug).toHaveBeenCalled();
      expectError(result, shared.ErrorCodes.OPERATION_FAILED.code, 'Error copying file: copy failed');
    });

    it('rejects blocked artifact types and removes the copied file', () => {
      const sourceDir = makeTempDir();
      const storageDir = makeTempDir();
      const sourcePath = writeTempFile(sourceDir, 'payload.exe', 'MZ');

      dbMock.getTask.mockReturnValue({ id: 'task-1' });
      dbMock.getArtifactConfig.mockReturnValue({
        storage_path: storageDir,
        max_size_mb: '10',
      });

      const result = handlers.handleStoreArtifact({
        task_id: 'task-1',
        name: 'payload.exe',
        file_path: sourcePath,
      });

      const taskDir = path.join(storageDir, 'task-1');
      const storedFiles = fs.existsSync(taskDir) ? fs.readdirSync(taskDir) : [];

      expect(dbMock.storeArtifact).not.toHaveBeenCalled();
      expect(storedFiles).toHaveLength(0);
      expectError(result, shared.ErrorCodes.INVALID_PARAM.code, 'Artifact rejected');
    });

    it('cleans up the stored file when the database insert fails', () => {
      const sourceDir = makeTempDir();
      const storageDir = makeTempDir();
      const sourcePath = writeTempFile(sourceDir, 'db-fail.txt', 'payload');

      dbMock.getTask.mockReturnValue({ id: 'task-42' });
      dbMock.getArtifactConfig.mockReturnValue({
        storage_path: storageDir,
        max_size_mb: '10',
      });
      dbMock.storeArtifact.mockImplementation(() => {
        throw new Error('insert failed');
      });

      const result = handlers.handleStoreArtifact({
        task_id: 'task-42',
        name: 'db-fail.txt',
        file_path: sourcePath,
      });

      const taskDir = path.join(storageDir, 'task-42');
      const storedFiles = fs.existsSync(taskDir) ? fs.readdirSync(taskDir) : [];

      expect(storedFiles).toHaveLength(0);
      expectError(result, shared.ErrorCodes.OPERATION_FAILED.code, 'Error storing artifact: insert failed');
    });

    it('stores a text artifact, computes a checksum, and includes metadata', () => {
      const sourceDir = makeTempDir();
      const storageDir = makeTempDir();
      const sourcePath = writeTempFile(sourceDir, 'notes.txt', 'alpha\nbeta\n');

      dbMock.getTask.mockReturnValue({ id: 'task-1' });
      dbMock.getArtifactConfig.mockReturnValue({
        storage_path: storageDir,
        max_size_mb: '10',
      });

      const result = handlers.handleStoreArtifact({
        task_id: 'task-1',
        name: 'notes.txt',
        file_path: sourcePath,
        metadata: { source: 'unit-test' },
      });

      const storedArtifact = dbMock.storeArtifact.mock.calls[0][0];

      expect(result.isError).toBeFalsy();
      expect(storedArtifact).toEqual(expect.objectContaining({
        task_id: 'task-1',
        name: 'notes.txt',
        mime_type: 'text/plain',
        metadata: { source: 'unit-test' },
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }));
      expect(fs.existsSync(storedArtifact.file_path)).toBe(true);
      expect(getText(result)).toContain('Artifact Stored');
      expect(getText(result)).toContain('Type:** text/plain');
      expect(getText(result)).toContain('Checksum:**');
    });

    it('falls back to application/octet-stream and strips non-simple extensions', () => {
      const sourceDir = makeTempDir();
      const storageDir = makeTempDir();
      const sourcePath = writeTempFile(sourceDir, 'payload.superlongextension', 'binary-ish');

      dbMock.getTask.mockReturnValue({ id: 'task-2' });
      dbMock.getArtifactConfig.mockReturnValue({
        storage_path: storageDir,
        max_size_mb: '10',
      });

      const result = handlers.handleStoreArtifact({
        task_id: 'task-2',
        name: 'payload.superlongextension',
        file_path: sourcePath,
      });

      const storedArtifact = dbMock.storeArtifact.mock.calls[0][0];

      expect(result.isError).toBeFalsy();
      expect(storedArtifact.mime_type).toBe('application/octet-stream');
      expect(path.extname(storedArtifact.file_path)).toBe('');
    });
  });

  describe('handleListArtifacts', () => {
    it('returns MISSING_REQUIRED_PARAM when task_id is missing', () => {
      const result = handlers.handleListArtifacts({});

      expectError(result, shared.ErrorCodes.MISSING_REQUIRED_PARAM.code, 'task_id is required');
    });

    it('renders an empty state when the task has no artifacts', () => {
      dbMock.listArtifacts.mockReturnValue([]);

      const result = handlers.handleListArtifacts({ task_id: 'task-empty' });

      expect(dbMock.listArtifacts).toHaveBeenCalledWith('task-empty');
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('No artifacts found for this task.');
    });

    it('renders a table with artifact rows and totals', () => {
      dbMock.listArtifacts.mockReturnValue([
        makeArtifact({
          id: 'a1',
          name: 'notes.txt',
          size_bytes: 2048,
          mime_type: 'text/plain',
          created_at: '2026-03-12T00:00:00.000Z',
        }),
        makeArtifact({
          id: 'a2',
          name: 'report.json',
          size_bytes: 1024,
          mime_type: 'application/json',
          created_at: '2026-03-13T00:00:00.000Z',
        }),
      ]);

      const result = handlers.handleListArtifacts({ task_id: 'task-abcdef123456' });
      const text = getText(result);

      expect(result.isError).toBeFalsy();
      expect(text).toContain('Artifacts for Task task-abc');
      expect(text).toContain('| notes.txt | 2.0 KB | text/plain |');
      expect(text).toContain('| report.json | 1.0 KB | application/json |');
      expect(text).toContain('**Total:** 2 artifacts');
    });
  });

  describe('handleGetArtifact', () => {
    it('returns INVALID_PARAM when args is not an object', () => {
      const result = handlers.handleGetArtifact(null);

      expectError(result, shared.ErrorCodes.INVALID_PARAM.code, 'Arguments object is required');
    });

    it('returns RESOURCE_NOT_FOUND when the artifact cannot be resolved', () => {
      dbMock.getArtifact.mockReturnValue(null);

      const result = handlers.handleGetArtifact({ artifact_id: 'missing-artifact' });

      expectError(result, shared.ErrorCodes.RESOURCE_NOT_FOUND.code, 'Artifact not found');
    });

    it('renders artifact details when looked up by artifact_id', () => {
      dbMock.getArtifact.mockReturnValue(makeArtifact({
        id: 'art-1',
        task_id: 'task-1',
        name: 'notes.txt',
        file_path: 'C:/artifacts/notes.txt',
      }));

      const result = handlers.handleGetArtifact({ artifact_id: 'art-1' });
      const text = getText(result);

      expect(result.isError).toBeFalsy();
      expect(text).toContain('## Artifact: notes.txt');
      expect(text).toContain('**ID:** art-1');
      expect(text).toContain('**Task:** task-1');
      expect(text).toContain('**Path:** C:/artifacts/notes.txt');
    });

    it('looks up by task_id and name, then includes metadata and truncated text content', () => {
      const dir = makeTempDir();
      const longContent = 'x'.repeat(5100);
      const filePath = writeTempFile(dir, 'big.txt', longContent);

      dbMock.listArtifacts.mockReturnValue([
        makeArtifact({
          id: 'art-2',
          task_id: 'task-2',
          name: 'big.txt',
          file_path: filePath,
          size_bytes: longContent.length,
          metadata: { kind: 'log' },
        }),
      ]);

      const result = handlers.handleGetArtifact({
        task_id: 'task-2',
        name: 'big.txt',
        include_content: true,
      });
      const text = getText(result);

      expect(result.isError).toBeFalsy();
      expect(text).toContain('### Metadata');
      expect(text).toContain('"kind": "log"');
      expect(text).toContain('### Content');
      expect(text).toContain('truncated, 5100 total characters');
    });

    it('skips the content block for non-text artifacts even when include_content is true', () => {
      dbMock.getArtifact.mockReturnValue(makeArtifact({
        id: 'art-3',
        name: 'report.json',
        mime_type: 'application/json',
      }));

      const result = handlers.handleGetArtifact({
        artifact_id: 'art-3',
        include_content: true,
      });

      expect(result.isError).toBeFalsy();
      expect(getText(result)).not.toContain('### Content');
    });

    it('includes a readable message when text content cannot be read', () => {
      dbMock.getArtifact.mockReturnValue(makeArtifact({
        id: 'art-4',
        name: 'broken.txt',
        file_path: 'C:/missing/broken.txt',
      }));
      vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => {
        throw new Error('disk failure');
      });

      const result = handlers.handleGetArtifact({
        artifact_id: 'art-4',
        include_content: true,
      });

      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Could not read content: disk failure');
    });
  });

  describe('handleDeleteArtifact', () => {
    it('returns MISSING_REQUIRED_PARAM when artifact_id is missing', () => {
      const result = handlers.handleDeleteArtifact({});

      expectError(result, shared.ErrorCodes.MISSING_REQUIRED_PARAM.code, 'artifact_id is required');
    });

    it('returns RESOURCE_NOT_FOUND when the artifact does not exist', () => {
      dbMock.getArtifact.mockReturnValue(null);

      const result = handlers.handleDeleteArtifact({ artifact_id: 'missing-artifact' });

      expectError(result, shared.ErrorCodes.RESOURCE_NOT_FOUND.code, 'Artifact not found: missing-artifact');
    });

    it('deletes the file and database record when the artifact exists', () => {
      const dir = makeTempDir();
      const filePath = writeTempFile(dir, 'delete-me.txt', 'payload');
      dbMock.getArtifact.mockReturnValue(makeArtifact({
        id: 'art-5',
        name: 'delete-me.txt',
        file_path: filePath,
      }));

      const result = handlers.handleDeleteArtifact({ artifact_id: 'art-5' });

      expect(dbMock.deleteArtifact).toHaveBeenCalledWith('art-5');
      expect(fs.existsSync(filePath)).toBe(false);
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Artifact deleted: delete-me.txt');
    });

    it('continues deleting the database record when file removal throws', () => {
      dbMock.getArtifact.mockReturnValue(makeArtifact({
        id: 'art-6',
        name: 'artifact.txt',
        file_path: 'C:/locked/artifact.txt',
      }));
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {
        throw new Error('permission denied');
      });

      const result = handlers.handleDeleteArtifact({ artifact_id: 'art-6' });

      expect(dbMock.deleteArtifact).toHaveBeenCalledWith('art-6');
      expect(loggerMock.debug).toHaveBeenCalled();
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Artifact deleted: artifact.txt');
    });
  });

  describe('handleConfigureArtifactStorage', () => {
    it('returns INVALID_PARAM when args is not an object', () => {
      const result = handlers.handleConfigureArtifactStorage(null);

      expectError(result, shared.ErrorCodes.INVALID_PARAM.code, 'Arguments object is required');
    });

    it('rejects non-positive max_size_mb values', () => {
      const result = handlers.handleConfigureArtifactStorage({ max_size_mb: 0 });

      expectError(result, shared.ErrorCodes.INVALID_PARAM.code, 'max_size_mb must be a positive number');
    });

    it('rejects retention_days values below 1', () => {
      const result = handlers.handleConfigureArtifactStorage({ retention_days: 0 });

      expectError(result, shared.ErrorCodes.INVALID_PARAM.code, 'retention_days must be at least 1');
    });

    it('rejects max_per_task values below 1', () => {
      const result = handlers.handleConfigureArtifactStorage({ max_per_task: 0 });

      expectError(result, shared.ErrorCodes.INVALID_PARAM.code, 'max_per_task must be at least 1');
    });

    it('renders current settings without an Updated section when nothing changes', () => {
      dbMock.getArtifactConfig.mockReturnValue({
        storage_path: '/data/artifacts',
        max_size_mb: '25',
        retention_days: '30',
        max_per_task: '5',
      });

      const result = handlers.handleConfigureArtifactStorage({});
      const text = getText(result);

      expect(result.isError).toBeFalsy();
      expect(text).toContain('Current Settings');
      expect(text).not.toContain('**Updated:**');
      expect(text).toContain('| Storage Path | /data/artifacts |');
    });

    it('updates multiple settings and renders the refreshed configuration', () => {
      dbMock.getArtifactConfig.mockReturnValue({
        storage_path: '/var/artifacts',
        max_size_mb: '25',
        retention_days: '45',
        max_per_task: '8',
      });

      const result = handlers.handleConfigureArtifactStorage({
        storage_path: '/var/artifacts',
        max_size_mb: 25,
        retention_days: 45,
        max_per_task: 8,
      });
      const text = getText(result);

      expect(dbMock.setArtifactConfig).toHaveBeenCalledWith('storage_path', '/var/artifacts');
      expect(dbMock.setArtifactConfig).toHaveBeenCalledWith('max_size_mb', '25');
      expect(dbMock.setArtifactConfig).toHaveBeenCalledWith('retention_days', '45');
      expect(dbMock.setArtifactConfig).toHaveBeenCalledWith('max_per_task', '8');
      expect(result.isError).toBeFalsy();
      expect(text).toContain('max_size_mb = 25');
      expect(text).toContain('retention_days = 45');
      expect(text).toContain('| Max per Task | 8 |');
    });
  });

  describe('handleExportArtifacts', () => {
    it('returns MISSING_REQUIRED_PARAM when task_id is missing', async () => {
      const result = await handlers.handleExportArtifacts({});

      expectError(result, shared.ErrorCodes.MISSING_REQUIRED_PARAM.code, 'task_id is required');
    });

    it('returns INVALID_PARAM when output_path contains path traversal', async () => {
      const result = await handlers.handleExportArtifacts({
        task_id: 'task-1',
        output_path: path.resolve(os.tmpdir(), '..', 'escape.zip'),
      });

      expectError(result, shared.ErrorCodes.INVALID_PARAM.code, 'output_path contains path traversal');
    });

    it('returns RESOURCE_NOT_FOUND when the task has no artifacts', async () => {
      dbMock.listArtifacts.mockReturnValue([]);

      const result = await handlers.handleExportArtifacts({ task_id: 'task-empty' });

      expect(dbMock.listArtifacts).toHaveBeenCalledWith('task-empty');
      expectError(result, shared.ErrorCodes.RESOURCE_NOT_FOUND.code, 'No artifacts found for this task');
    });

    it('exports artifacts to a zip file and lists the archive contents', async () => {
      const sourceDir = makeTempDir();
      const outputDir = makeTempDir();
      const artifactOne = writeTempFile(sourceDir, 'notes.txt', 'alpha');
      const artifactTwo = writeTempFile(sourceDir, 'report.log', 'beta');
      const outputPath = path.join(outputDir, 'task-artifacts.zip');
      const output = new EventEmitter();
      const archivedFiles = [];
      const originalLoad = Module._load;

      vi.spyOn(Module, '_load').mockImplementation((request, parent, isMain) => {
        if (request === 'archiver') {
          return () => {
            const archive = new EventEmitter();
            archive.abort = vi.fn();
            archive.pipe = vi.fn();
            archive.file = vi.fn((filePath, options) => {
              archivedFiles.push({ filePath, options });
            });
            archive.finalize = vi.fn(() => {
              fs.writeFileSync(outputPath, 'zip-bytes');
              output.emit('close');
            });
            return archive;
          };
        }

        return originalLoad.call(Module, request, parent, isMain);
      });
      vi.spyOn(fs, 'createWriteStream').mockReturnValue(output);

      dbMock.listArtifacts.mockReturnValue([
        makeArtifact({ id: 'art-1', name: 'notes.txt', file_path: artifactOne }),
        makeArtifact({ id: 'art-2', name: 'report.log', file_path: artifactTwo }),
      ]);

      const result = await handlers.handleExportArtifacts({
        task_id: 'task-12345678',
        output_path: outputPath,
      });
      const text = getText(result);

      expect(result.isError).toBeFalsy();
      expect(fs.existsSync(outputPath)).toBe(true);
      expect(fs.statSync(outputPath).size).toBeGreaterThan(0);
      expect(archivedFiles).toEqual([
        { filePath: artifactOne, options: { name: 'notes.txt' } },
        { filePath: artifactTwo, options: { name: 'report.log' } },
      ]);
      expect(text).toContain('Artifacts Exported');
      expect(text).toContain(`**Output:** ${outputPath}`);
      expect(text).toContain('**Artifacts:** 2');
      expect(text).toContain('- notes.txt');
      expect(text).toContain('- report.log');
    });

    it('returns INTERNAL_ERROR when an unexpected exception escapes setup', async () => {
      dbMock.listArtifacts.mockImplementation(() => {
        throw new Error('db offline');
      });

      const result = await handlers.handleExportArtifacts({ task_id: 'task-1' });

      expectError(result, shared.ErrorCodes.INTERNAL_ERROR.code, 'db offline');
    });
  });
});
