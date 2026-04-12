const path = require('path');
const os = require('os');
const fs = require('fs');
const {
  setupTestDb,
  teardownTestDb,
  getText,
  mkTask,
} = require('./vitest-setup');
const {
  handleHashlineRead,
  handleHashlineEdit,
} = require('../handlers/hashline-handlers');

let db;
let tempDir;
let outsideFilePath;

beforeAll(() => {
  ({ db } = setupTestDb('hashline-path-scoping'));
  tempDir = path.join(os.tmpdir(), 'torque-hashline-path-scoping-tests');
  fs.mkdirSync(tempDir, { recursive: true });
});

beforeEach(() => {
  db.resetForTest(fs.readFileSync(path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf')));
  outsideFilePath = path.join(
    tempDir,
    `hashline-outside-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`
  );
  fs.writeFileSync(outsideFilePath, 'outside\n');
});

afterAll(() => {
  teardownTestDb();
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('hashline handler workspace path scoping', () => {
  function createTaskArgs() {
    const result = mkTask(db, {
      working_directory: path.resolve(__dirname, '..', '..'),
    });
    const taskId = typeof result === 'object' && result?.id ? result.id : result;
    return { __taskId: taskId };
  }

  it('rejects reads outside the task workspace root', () => {
    const result = handleHashlineRead({
      file_path: outsideFilePath,
      ...createTaskArgs(),
    });

    expect(result.isError).toBe(true);
    expect(getText(result)).toContain('file_path is outside workspace root');
  });

  it('rejects edits outside the task workspace root', () => {
    const result = handleHashlineEdit({
      file_path: outsideFilePath,
      edits: [{ start_line: 1, start_hash: 'xx', new_content: 'blocked' }],
      ...createTaskArgs(),
    });

    expect(result.isError).toBe(true);
    expect(getText(result)).toContain('file_path is outside workspace root');
  });
});
