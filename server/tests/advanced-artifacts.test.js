'use strict';

// require.cache manipulation is intentionally used here rather than vi.mock().
// The artifacts handler binds directly to db/task-metadata.js and handlers/shared
// when it loads. installMock() patches those current module boundaries so the
// tests never fall through to the real SQLite-backed implementations.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const EventEmitter = require('events');
const dataDir = require('../data-dir');

const realShared = require('../handlers/shared');

function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

let artifactConfig;

const mockDb = {
  storeArtifact: vi.fn(),
  listArtifacts: vi.fn(),
  getArtifact: vi.fn(),
  deleteArtifact: vi.fn(),
  getConfigValue: vi.fn(),
  setConfigValue: vi.fn(),
  getTask: vi.fn(),
  exportArtifacts: vi.fn(),
  getArtifactConfig: vi.fn(),
  setArtifactConfig: vi.fn(),
};

const archiverState = {
  failWith: null,
  instances: [],
};

class MockArchive extends EventEmitter {
  constructor(format, options) {
    super();
    this.format = format;
    this.options = options;
    this.files = [];
    this.output = null;
    this.aborted = false;
  }

  pipe(output) {
    this.output = output;
    return output;
  }

  file(filePath, options = {}) {
    this.files.push({
      file_path: filePath,
      name: options.name || path.basename(filePath),
    });
    return this;
  }

  finalize() {
    process.nextTick(() => {
      if (archiverState.failWith) {
        this.emit('error', new Error(archiverState.failWith));
        return;
      }

      if (!this.output) {
        this.emit('error', new Error('No output stream'));
        return;
      }

      for (const entry of this.files) {
        this.output.write(`${entry.name}\n`);
      }
      this.output.end();
    });
  }

  abort() {
    this.aborted = true;
    if (this.output && !this.output.destroyed) {
      this.output.destroy();
    }
  }
}

const mockArchiver = vi.fn((format, options) => {
  const archive = new MockArchive(format, options);
  archiverState.instances.push(archive);
  return archive;
});

function loadHandlers() {
  delete require.cache[require.resolve('../handlers/advanced/artifacts')];
  installMock('../db/task-metadata', {
    storeArtifact: mockDb.storeArtifact,
    listArtifacts: mockDb.listArtifacts,
    getArtifact: mockDb.getArtifact,
    deleteArtifact: mockDb.deleteArtifact,
    getArtifactConfig: mockDb.getArtifactConfig,
    setArtifactConfig: mockDb.setArtifactConfig,
  });
  installMock('../handlers/shared', {
    ...realShared,
    requireTask: vi.fn((taskId) => {
      const task = mockDb.getTask(taskId);
      return task
        ? { task, error: null }
        : { task: null, error: realShared.makeError(realShared.ErrorCodes.TASK_NOT_FOUND, `Task not found: ${taskId}`) };
    }),
  });
  return require('../handlers/advanced/artifacts');
}

function resetMockDefaults() {
  artifactConfig = {
    storage_path: '',
    max_size_mb: '50',
    retention_days: '30',
    max_per_task: '20',
  };

  archiverState.failWith = null;
  archiverState.instances = [];
  mockArchiver.mockClear();

  for (const fn of Object.values(mockDb)) {
    if (typeof fn?.mockReset === 'function') {
      fn.mockReset();
    }
  }

  mockDb.getTask.mockReturnValue({ id: 'task-1', status: 'completed' });
  mockDb.listArtifacts.mockReturnValue([]);
  mockDb.getArtifact.mockReturnValue(null);
  mockDb.deleteArtifact.mockReturnValue(true);
  mockDb.getArtifactConfig.mockImplementation(() => ({ ...artifactConfig }));
  mockDb.setArtifactConfig.mockImplementation((key, value) => {
    artifactConfig[key] = String(value);
  });
  mockDb.getConfigValue.mockImplementation((key) => artifactConfig[key] ?? null);
  mockDb.setConfigValue.mockImplementation((key, value) => {
    artifactConfig[key] = String(value);
  });
  mockDb.storeArtifact.mockImplementation((artifact) => ({
    ...artifact,
    created_at: '2026-03-11T10:00:00.000Z',
    expires_at: '2026-04-10T10:00:00.000Z',
  }));
  mockDb.exportArtifacts.mockReturnValue({ ok: true });
}

function installArchiverMock() {
  const originalLoad = Module._load;
  return vi.spyOn(Module, '_load').mockImplementation(function mockedLoad(request, parent, isMain) {
    if (request === 'archiver') {
      return mockArchiver;
    }
    return originalLoad.call(this, request, parent, isMain);
  });
}

function getText(result) {
  return result?.content?.[0]?.text || '';
}

describe('advanced/artifacts handlers', () => {
  let handlers;
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-adv-artifacts-'));
    dataDir.setDataDir(tempDir);
    resetMockDefaults();
    handlers = loadHandlers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    dataDir.setDataDir(null);
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete require.cache[require.resolve('../handlers/advanced/artifacts')];
  });

  describe('handleStoreArtifact', () => {
    it('returns INVALID_PARAM when the arguments object is missing', () => {
      const result = handlers.handleStoreArtifact();

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(getText(result)).toContain('Arguments object is required');
    });

    it('returns MISSING_REQUIRED_PARAM when file_path is missing', () => {
      const result = handlers.handleStoreArtifact({
        task_id: 'task-1',
        name: 'artifact.txt',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('file_path is required and must be a string');
      expect(mockDb.getTask).not.toHaveBeenCalled();
    });

    it('returns TASK_NOT_FOUND when the task does not exist', () => {
      const sourcePath = path.join(tempDir, 'source.txt');
      fs.writeFileSync(sourcePath, 'artifact body');
      mockDb.getTask.mockReturnValue(null);

      const result = handlers.handleStoreArtifact({
        task_id: 'task-missing',
        name: 'source.txt',
        file_path: sourcePath,
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('TASK_NOT_FOUND');
      expect(getText(result)).toContain('Task not found: task-missing');
      expect(mockDb.storeArtifact).not.toHaveBeenCalled();
    });

    it('copies the file into configured storage and persists the artifact record', () => {
      const sourceContent = 'artifact body\nsecond line';
      const sourcePath = path.join(tempDir, 'source.txt');
      const storagePath = path.join(tempDir, 'storage');
      fs.writeFileSync(sourcePath, sourceContent);
      artifactConfig.storage_path = storagePath;
      vi.spyOn(Date.prototype, 'toLocaleDateString').mockReturnValue('Apr 10, 2026');

      const result = handlers.handleStoreArtifact({
        task_id: 'task-1',
        name: 'source.txt',
        file_path: sourcePath,
        metadata: { scope: 'unit-test' },
      });

      const storedArtifact = mockDb.storeArtifact.mock.calls[0][0];
      const expectedChecksum = crypto.createHash('sha256').update(sourceContent).digest('hex');

      expect(mockDb.storeArtifact).toHaveBeenCalledWith(expect.objectContaining({
        id: expect.any(String),
        task_id: 'task-1',
        name: 'source.txt',
        mime_type: 'text/plain',
        size_bytes: Buffer.byteLength(sourceContent),
        checksum: expectedChecksum,
        metadata: { scope: 'unit-test' },
      }));
      expect(storedArtifact.file_path)
        .toBe(path.join(storagePath, 'task-1', `${storedArtifact.id}.txt`));
      expect(fs.existsSync(storedArtifact.file_path)).toBe(true);
      expect(fs.readFileSync(storedArtifact.file_path, 'utf8')).toBe(sourceContent);
      expect(getText(result)).toContain('## Artifact Stored');
      expect(getText(result)).toContain(storedArtifact.id);
      expect(getText(result)).toContain('source.txt');
      expect(getText(result)).toContain('text/plain');
      expect(getText(result)).toContain('Apr 10, 2026');
    });
  });

  describe('handleListArtifacts', () => {
    it('returns MISSING_REQUIRED_PARAM when task_id is missing', () => {
      const result = handlers.handleListArtifacts({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('task_id is required');
      expect(mockDb.listArtifacts).not.toHaveBeenCalled();
    });

    it('renders the artifact table for the task', () => {
      vi.spyOn(Date.prototype, 'toLocaleDateString').mockReturnValue('Mar 11, 2026');
      mockDb.listArtifacts.mockReturnValue([
        {
          name: 'build.log',
          size_bytes: 2048,
          mime_type: 'text/plain',
          created_at: '2026-03-11T12:00:00.000Z',
        },
      ]);

      const result = handlers.handleListArtifacts({
        task_id: '12345678-aaaa-bbbb-cccc-1234567890ab',
      });

      expect(mockDb.listArtifacts).toHaveBeenCalledWith('12345678-aaaa-bbbb-cccc-1234567890ab');
      expect(getText(result)).toContain('Artifacts for Task 12345678...');
      expect(getText(result)).toContain('| build.log | 2.0 KB | text/plain | Mar 11, 2026 |');
      expect(getText(result)).toContain('**Total:** 1 artifacts');
    });
  });

  describe('handleGetArtifact', () => {
    it('returns INVALID_PARAM when the arguments object is missing', () => {
      const result = handlers.handleGetArtifact();

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(getText(result)).toContain('Arguments object is required');
    });

    it('returns RESOURCE_NOT_FOUND when no artifact matches the lookup', () => {
      const result = handlers.handleGetArtifact({ artifact_id: 'artifact-missing' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('RESOURCE_NOT_FOUND');
      expect(getText(result)).toContain('Artifact not found');
    });

    it('renders artifact details and inline text content', () => {
      const artifactPath = path.join(tempDir, 'artifact.txt');
      fs.writeFileSync(artifactPath, 'line 1\nline 2');
      vi.spyOn(Date.prototype, 'toLocaleString').mockReturnValue('Mock DateTime');
      mockDb.getArtifact.mockReturnValue({
        id: 'artifact-1',
        task_id: 'task-1',
        name: 'artifact.txt',
        size_bytes: Buffer.byteLength('line 1\nline 2'),
        mime_type: 'text/plain',
        checksum: 'abc123',
        file_path: artifactPath,
        created_at: '2026-03-11T10:00:00.000Z',
        expires_at: '2026-04-10T10:00:00.000Z',
        metadata: { env: 'test' },
      });

      const result = handlers.handleGetArtifact({
        artifact_id: 'artifact-1',
        include_content: true,
      });

      expect(mockDb.getArtifact).toHaveBeenCalledWith('artifact-1');
      expect(getText(result)).toContain('## Artifact: artifact.txt');
      expect(getText(result)).toContain('**ID:** artifact-1');
      expect(getText(result)).toContain('**Task:** task-1');
      expect(getText(result)).toContain('**Type:** text/plain');
      expect(getText(result)).toContain('**Checksum:** abc123');
      expect(getText(result)).toContain('Mock DateTime');
      expect(getText(result)).toContain('"env": "test"');
      expect(getText(result)).toContain('### Content');
      expect(getText(result)).toContain('line 1');
      expect(getText(result)).toContain('line 2');
    });
  });

  describe('handleDeleteArtifact', () => {
    it('returns MISSING_REQUIRED_PARAM when artifact_id is missing', () => {
      const result = handlers.handleDeleteArtifact({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('artifact_id is required');
      expect(mockDb.getArtifact).not.toHaveBeenCalled();
    });

    it('returns RESOURCE_NOT_FOUND when the artifact does not exist', () => {
      const result = handlers.handleDeleteArtifact({ artifact_id: 'artifact-missing' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('RESOURCE_NOT_FOUND');
      expect(getText(result)).toContain('Artifact not found: artifact-missing');
      expect(mockDb.deleteArtifact).not.toHaveBeenCalled();
    });

    it('removes the stored file and deletes the database record', () => {
      const artifactPath = path.join(tempDir, 'delete-me.txt');
      fs.writeFileSync(artifactPath, 'delete me');
      mockDb.getArtifact.mockReturnValue({
        id: 'artifact-2',
        name: 'delete-me.txt',
        file_path: artifactPath,
      });

      const result = handlers.handleDeleteArtifact({ artifact_id: 'artifact-2' });

      expect(mockDb.getArtifact).toHaveBeenCalledWith('artifact-2');
      expect(mockDb.deleteArtifact).toHaveBeenCalledWith('artifact-2');
      expect(fs.existsSync(artifactPath)).toBe(false);
      expect(getText(result)).toContain('Artifact deleted: delete-me.txt');
    });
  });

  describe('handleConfigureArtifactStorage', () => {
    it('returns INVALID_PARAM when the arguments object is missing', () => {
      const result = handlers.handleConfigureArtifactStorage();

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(getText(result)).toContain('Arguments object is required');
    });

    it('rejects invalid max_size_mb values', () => {
      const result = handlers.handleConfigureArtifactStorage({ max_size_mb: 0 });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(getText(result)).toContain('max_size_mb must be a positive number');
      expect(mockDb.setArtifactConfig).not.toHaveBeenCalled();
    });

    it('updates storage settings and returns the current configuration', () => {
      const storagePath = path.join(tempDir, 'artifacts');

      const result = handlers.handleConfigureArtifactStorage({
        storage_path: storagePath,
        max_size_mb: 128,
        retention_days: 45,
        max_per_task: 9,
      });

      expect(mockDb.setArtifactConfig).toHaveBeenCalledTimes(4);
      expect(mockDb.setArtifactConfig).toHaveBeenNthCalledWith(1, 'storage_path', storagePath);
      expect(mockDb.setArtifactConfig).toHaveBeenNthCalledWith(2, 'max_size_mb', '128');
      expect(mockDb.setArtifactConfig).toHaveBeenNthCalledWith(3, 'retention_days', '45');
      expect(mockDb.setArtifactConfig).toHaveBeenNthCalledWith(4, 'max_per_task', '9');
      expect(getText(result)).toContain('## Artifact Storage Configuration');
      expect(getText(result)).toContain(`storage_path = ${storagePath}`);
      expect(getText(result)).toContain('max_size_mb = 128');
      expect(getText(result)).toContain('retention_days = 45');
      expect(getText(result)).toContain('max_per_task = 9');
      expect(getText(result)).toContain(`| Storage Path | ${storagePath} |`);
      expect(getText(result)).toContain('| Max Size | 128 MB |');
      expect(getText(result)).toContain('| Retention | 45 days |');
      expect(getText(result)).toContain('| Max per Task | 9 |');
    });
  });

  describe('handleExportArtifacts', () => {
    it('returns MISSING_REQUIRED_PARAM when task_id is missing', async () => {
      const result = await handlers.handleExportArtifacts({});

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('MISSING_REQUIRED_PARAM');
      expect(getText(result)).toContain('task_id is required');
    });

    it('returns RESOURCE_NOT_FOUND when the task has no artifacts', async () => {
      const result = await handlers.handleExportArtifacts({ task_id: 'task-1' });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('RESOURCE_NOT_FOUND');
      expect(getText(result)).toContain('No artifacts found for this task');
    });

    it('exports task artifacts to the requested output path', async () => {
      installArchiverMock();
      const exportsDir = path.join(tempDir, 'exports');
      const outputPath = path.join(exportsDir, 'artifacts.zip');
      const artifactAPath = path.join(tempDir, 'artifact-a.txt');
      const artifactBPath = path.join(tempDir, 'artifact-b.log');
      fs.mkdirSync(exportsDir, { recursive: true });
      fs.writeFileSync(artifactAPath, 'artifact A');
      fs.writeFileSync(artifactBPath, 'artifact B');
      mockDb.listArtifacts.mockReturnValue([
        { name: 'artifact-a.txt', file_path: artifactAPath },
        { name: 'artifact-b.log', file_path: artifactBPath },
      ]);

      const result = await handlers.handleExportArtifacts({
        task_id: '12345678-aaaa-bbbb-cccc-1234567890ab',
        output_path: outputPath,
      });

      expect(mockArchiver).toHaveBeenCalledWith('zip', { zlib: { level: 9 } });
      expect(archiverState.instances).toHaveLength(1);
      expect(archiverState.instances[0].files).toEqual([
        { file_path: artifactAPath, name: 'artifact-a.txt' },
        { file_path: artifactBPath, name: 'artifact-b.log' },
      ]);
      expect(fs.existsSync(outputPath)).toBe(true);
      expect(fs.readFileSync(outputPath, 'utf8')).toContain('artifact-a.txt');
      expect(fs.readFileSync(outputPath, 'utf8')).toContain('artifact-b.log');
      expect(getText(result)).toContain('## Artifacts Exported');
      expect(getText(result)).toContain(`**Output:** ${outputPath}`);
      expect(getText(result)).toContain('**Artifacts:** 2');
      expect(getText(result)).toContain('- artifact-a.txt');
      expect(getText(result)).toContain('- artifact-b.log');
    });
  });
});
