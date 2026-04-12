const path = require('path');
const os = require('os');
const fs = require('fs');
const {
  handleAddTsInterfaceMembers,
} = require('../handlers/automation-ts-tools');

function getText(result) {
  return result?.content?.[0]?.text || '';
}

let tempDir;
let outsideFilePath;

beforeAll(() => {
  tempDir = path.join(os.tmpdir(), 'torque-ts-automation-path-scoping-tests');
  fs.mkdirSync(tempDir, { recursive: true });
});

beforeEach(() => {
  outsideFilePath = path.join(
    tempDir,
    `outside-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ts`
  );
  fs.writeFileSync(outsideFilePath, 'export interface Config {}\n');
});

afterAll(() => {
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('automation ts tool workspace path scoping', () => {
  it('rejects absolute file paths outside the workspace root', () => {
    const result = handleAddTsInterfaceMembers({
      file_path: outsideFilePath,
      working_directory: path.resolve(__dirname, '..', '..'),
      interface_name: 'Config',
      members: [{ name: 'timeout', type_definition: 'number' }],
    });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe('PATH_TRAVERSAL');
    expect(getText(result)).toContain('file_path is outside workspace root');
  });
});
