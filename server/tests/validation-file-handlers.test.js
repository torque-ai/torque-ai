const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');

let db;
let dataDir;

function parseResult(result) {
  const text = getText(result);
  if (result.isError) return text;
  return JSON.parse(text);
}

function createTask(overrides = {}) {
  const id = overrides.id || randomUUID();
  const workingDirectory = overrides.working_directory || path.join(dataDir, `task-${id}`);
  fs.mkdirSync(workingDirectory, { recursive: true });

  db.createTask({
    id,
    task_description: overrides.task_description || 'Validation-file handler fixture task',
    working_directory: workingDirectory,
    status: overrides.status || 'completed',
    priority: overrides.priority || 0,
    project: overrides.project || null,
    provider: overrides.provider || 'codex',
    output: overrides.output || null,
  });

  return db.getTask(id);
}

function writeFile(filePath, contents = '') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, 'utf8');
  return filePath;
}

function uniqueTaskDir(task, suffix) {
  return path.join(task.working_directory, suffix || randomUUID());
}

describe('Validation File Handlers', () => {
  beforeAll(() => {
    ({ db } = setupTestDb('val-file'));
    dataDir = process.env.TORQUE_DATA_DIR;
  });

  afterAll(() => { teardownTestDb(); });

  describe('set_expected_output_path', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('set_expected_output_path', { expected_directory: path.join(dataDir, 'out') });
      expect(result.isError).toBe(true);
    });

    it('rejects missing expected_directory', async () => {
      const task = createTask();
      const result = await safeTool('set_expected_output_path', { task_id: task.id });
      expect(result.isError).toBe(true);
    });

    it('stores expected path with defaults for new task', async () => {
      const task = createTask();
      const expectedDirectory = path.join(task.working_directory, 'expected');

      const result = await safeTool('set_expected_output_path', {
        task_id: task.id,
        expected_directory: expectedDirectory
      });

      const payload = parseResult(result);
      const rows = db.getExpectedOutputPaths(task.id);

      expect(result.isError).toBeFalsy();
      expect(payload.task_id).toBe(task.id);
      expect(payload.expected_directory).toBe(expectedDirectory);
      expect(rows).toHaveLength(1);
      expect(rows[0].expected_directory).toBe(expectedDirectory);
      expect(rows[0].allow_subdirs).toBe(1);
    });

    it('stores explicit options for expected output rules', async () => {
      const task = createTask();
      const expectedDirectory = path.join(task.working_directory, 'expected-strict');

      const result = await safeTool('set_expected_output_path', {
        task_id: task.id,
        expected_directory: expectedDirectory,
        allow_subdirs: false,
        file_patterns: ['*.cs', '*.ts']
      });

      const rows = db.getExpectedOutputPaths(task.id);
      const payload = parseResult(result);

      expect(result.isError).toBeFalsy();
      expect(payload.task_id).toBe(task.id);
      expect(rows[0].allow_subdirs).toBe(0);
      expect(JSON.parse(rows[0].file_patterns)).toEqual(['*.cs', '*.ts']);
    });
  });

  describe('record_file_change', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('record_file_change', {
        file_path: 'foo.js',
        change_type: 'created'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects missing file_path', async () => {
      const result = await safeTool('record_file_change', {
        task_id: randomUUID(),
        change_type: 'created'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects invalid change_type', async () => {
      const task = createTask();
      const result = await safeTool('record_file_change', {
        task_id: task.id,
        file_path: 'src/new-file.ts',
        change_type: 'renamed'
      });
      expect(result.isError).toBe(true);
    });

    it('records changes and marks outside-workdir paths', async () => {
      const task = createTask();
      const outsidePath = path.join(path.dirname(task.working_directory), 'outside', 'created.js');

      const result = await safeTool('record_file_change', {
        task_id: task.id,
        file_path: outsidePath,
        change_type: 'created',
        working_directory: task.working_directory
      });

      const payload = parseResult(result);
      const changes = db.getTaskFileChanges(task.id);

      expect(result.isError).toBeFalsy();
      expect(payload.is_outside_workdir).toBe(true);
      expect(changes).toHaveLength(1);
      expect(changes[0].is_outside_workdir).toBe(1);
      expect(changes[0].change_type).toBe('created');
    });

    it('computes relative_path for in-workdir changes', async () => {
      const task = createTask();
      const filePath = path.join(task.working_directory, 'src', 'inside.ts');

      const result = await safeTool('record_file_change', {
        task_id: task.id,
        file_path: filePath,
        change_type: 'modified',
        working_directory: task.working_directory
      });

      const payload = parseResult(result);
      const [change] = db.getTaskFileChanges(task.id);

      expect(result.isError).toBeFalsy();
      expect(payload.is_outside_workdir).toBe(false);
      expect(change.relative_path).toBe(`src${path.sep}inside.ts`);
      expect(change.is_outside_workdir).toBe(0);
      expect(change.change_type).toBe('modified');
    });
  });

  describe('check_file_locations', () => {
    it('rejects missing required arguments', async () => {
      const result = await safeTool('check_file_locations', { task_id: randomUUID() });
      expect(result.isError).toBe(true);
    });

    it('returns clean when changes match expected output path', async () => {
      const task = createTask();
      const expectedDirectory = path.join(task.working_directory, 'src');
      const goodFile = path.join(expectedDirectory, 'main.ts');
      writeFile(goodFile, 'console.log(1);');

      const setPath = await safeTool('set_expected_output_path', {
        task_id: task.id,
        expected_directory: expectedDirectory,
        allow_subdirs: true
      });
      expect(setPath.isError).toBeFalsy();

      const record = await safeTool('record_file_change', {
        task_id: task.id,
        file_path: goodFile,
        change_type: 'created',
        working_directory: task.working_directory
      });
      expect(record.isError).toBeFalsy();

      const result = await safeTool('check_file_locations', {
        task_id: task.id,
        working_directory: task.working_directory
      });
      const payload = parseResult(result);

      expect(payload.anomalies_found).toBe(0);
      expect(payload.status).toBe('clean');
      expect(payload.anomalies).toHaveLength(0);
    });

    it('flags outside-workdir and unexpected-location anomalies', async () => {
      const task = createTask();
      const expectedDirectory = path.join(task.working_directory, 'expected');
      const outsidePath = path.join(path.dirname(task.working_directory), 'outside', 'rogue.ts');
      const unexpectedPath = path.join(task.working_directory, 'other', 'wrong.ts');
      writeFile(unexpectedPath, 'export default 1;');

      await safeTool('set_expected_output_path', {
        task_id: task.id,
        expected_directory: expectedDirectory,
        allow_subdirs: false
      });

      const outsideRecord = await safeTool('record_file_change', {
        task_id: task.id,
        file_path: outsidePath,
        change_type: 'modified',
        working_directory: task.working_directory
      });
      const unexpectedRecord = await safeTool('record_file_change', {
        task_id: task.id,
        file_path: unexpectedPath,
        change_type: 'created',
        working_directory: task.working_directory
      });

      expect(outsideRecord.isError).toBeFalsy();
      expect(unexpectedRecord.isError).toBeFalsy();

      const result = await safeTool('check_file_locations', {
        task_id: task.id,
        working_directory: task.working_directory
      });
      const payload = parseResult(result);

      const types = payload.anomalies.map(a => a.anomaly_type);

      expect(payload.anomalies_found).toBeGreaterThanOrEqual(2);
      expect(types).toContain('outside_workdir');
      expect(types).toContain('unexpected_location');
      expect(payload.status).toBe('issues_found');
    });
  });

  describe('check_duplicate_files', () => {
    it('rejects missing working_directory', async () => {
      const result = await safeTool('check_duplicate_files', { task_id: randomUUID() });
      expect(result.isError).toBe(true);
    });

    it('detects duplicate filenames and reports locations', async () => {
      const task = createTask();
      const scanRoot = uniqueTaskDir(task, 'dup-scan');
      const dirA = path.join(scanRoot, 'a');
      const dirB = path.join(scanRoot, 'b');
      writeFile(path.join(dirA, 'Widget.ts'), 'export class WidgetA {}');
      writeFile(path.join(dirB, 'Widget.ts'), 'export class WidgetB {}');

      const result = await safeTool('check_duplicate_files', {
        task_id: task.id,
        working_directory: scanRoot,
        file_extensions: ['.ts']
      });
      const payload = parseResult(result);

      expect(result.isError).toBeFalsy();
      expect(payload.duplicates_found).toBeGreaterThanOrEqual(1);
      expect(payload.status).toBe('duplicates_found');
      const dupe = payload.duplicates.find(d => d.file_name === 'Widget.ts');
      expect(dupe).toBeDefined();
      expect(dupe.location_count).toBe(2);
      expect(dupe.locations).toHaveLength(2);
    });

    it('returns clean when no duplicates exist', async () => {
      const task = createTask();
      const scanRoot = uniqueTaskDir(task, 'dup-clean');
      writeFile(path.join(scanRoot, 'Unique.ts'), 'export class Unique {}');

      const result = await safeTool('check_duplicate_files', {
        task_id: task.id,
        working_directory: scanRoot,
        file_extensions: ['.ts']
      });
      const payload = parseResult(result);

      expect(payload.duplicates_found).toBe(0);
      expect(payload.status).toBe('clean');
      expect(payload.duplicates).toHaveLength(0);
    });
  });

  describe('get_file_location_issues', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('get_file_location_issues', {});
      expect(result.isError).toBe(true);
    });

    it('aggregates anomalies and duplicates by task', async () => {
      const task = createTask();
      const expectedDirectory = path.join(task.working_directory, 'expected');
      const outsidePath = path.join(path.dirname(task.working_directory), 'outside-issue', 'rogue.ts');
      const scanRoot = uniqueTaskDir(task, 'issues-dups');
      writeFile(path.join(scanRoot, 'dup', 'Dup.ts'), 'x');
      writeFile(path.join(scanRoot, 'uniq', 'Dup.ts'), 'y');

      await safeTool('set_expected_output_path', {
        task_id: task.id,
        expected_directory: expectedDirectory
      });
      await safeTool('record_file_change', {
        task_id: task.id,
        file_path: outsidePath,
        change_type: 'created',
        working_directory: task.working_directory
      });
      await safeTool('check_file_locations', {
        task_id: task.id,
        working_directory: task.working_directory
      });

      await safeTool('check_duplicate_files', {
        task_id: task.id,
        working_directory: scanRoot,
        file_extensions: ['.ts']
      });

      const result = await safeTool('get_file_location_issues', { task_id: task.id });
      const payload = parseResult(result);

      expect(payload.task_id).toBe(task.id);
      expect(payload.total_issues).toBe(2);
      expect(payload.anomalies).toHaveLength(1);
      expect(payload.duplicates).toHaveLength(1);
      expect(payload.duplicates[0].locations).toEqual(expect.arrayContaining([
        expect.stringContaining('Dup.ts')
      ]));
    });
  });

  describe('resolve_file_location_issue', () => {
    it('rejects missing issue_type', async () => {
      const result = await safeTool('resolve_file_location_issue', { issue_id: 123 });
      expect(result.isError).toBe(true);
    });

    it('rejects missing issue_id', async () => {
      const result = await safeTool('resolve_file_location_issue', { issue_type: 'anomaly' });
      expect(result.isError).toBe(true);
    });

    it('rejects invalid issue_type', async () => {
      const result = await safeTool('resolve_file_location_issue', {
        issue_type: 'invalid',
        issue_id: 123
      });
      expect(result.isError).toBe(true);
    });

    it('resolves anomaly issue IDs', async () => {
      const task = createTask();
      const outsidePath = path.join(path.dirname(task.working_directory), 'out', 'rogue.ts');

      await safeTool('record_file_change', {
        task_id: task.id,
        file_path: outsidePath,
        change_type: 'modified',
        working_directory: task.working_directory
      });

      const check = await safeTool('check_file_locations', {
        task_id: task.id,
        working_directory: task.working_directory
      });
      const checkPayload = parseResult(check);
      expect(checkPayload.anomalies_found).toBeGreaterThan(0);

      const issues = await safeTool('get_file_location_issues', { task_id: task.id });
      const issuesPayload = parseResult(issues);
      const anomaly = issuesPayload.anomalies[0];

      expect(anomaly).toBeDefined();
      expect(anomaly.id).toBeDefined();

      const resolved = await safeTool('resolve_file_location_issue', {
        issue_type: 'anomaly',
        issue_id: anomaly.id
      });
      expect(resolved.isError).toBeFalsy();
      const resolvedPayload = parseResult(resolved);
      const updated = await safeTool('get_file_location_issues', { task_id: task.id });
      const updatedPayload = parseResult(updated);

      expect(resolvedPayload.result.resolved).toBe(1);
      expect(updatedPayload.anomalies).toHaveLength(0);
      expect(updatedPayload.total_issues).toBe(0);
    });

    it('resolves duplicate issue IDs', async () => {
      const task = createTask();
      const scanRoot = uniqueTaskDir(task, 'resolve-dupes');
      writeFile(path.join(scanRoot, 'a', 'Shared.ts'), 'A');
      writeFile(path.join(scanRoot, 'b', 'Shared.ts'), 'B');

      const dup = await safeTool('check_duplicate_files', {
        task_id: task.id,
        working_directory: scanRoot,
        file_extensions: ['.ts']
      });
      const dupPayload = parseResult(dup);
      expect(dupPayload.duplicates_found).toBeGreaterThan(0);
      const issues = await safeTool('get_file_location_issues', { task_id: task.id });
      const issuesPayload = parseResult(issues);
      const entry = issuesPayload.duplicates[0];

      expect(entry).toBeDefined();
      expect(entry.id).toBeDefined();

      const resolved = await safeTool('resolve_file_location_issue', {
        issue_type: 'duplicate',
        issue_id: entry.id
      });
      expect(resolved.isError).toBeFalsy();
      const resolvedPayload = parseResult(resolved);
      const updated = await safeTool('get_file_location_issues', { task_id: task.id });
      const updatedPayload = parseResult(updated);

      expect(resolvedPayload.result.resolved).toBe(1);
      expect(updatedPayload.total_issues).toBe(0);
      expect(updatedPayload.duplicates).toHaveLength(0);
    });
  });

  describe('search_similar_files', () => {
    it('rejects missing required arguments', async () => {
      const result = await safeTool('search_similar_files', {
        task_id: randomUUID(),
        working_directory: dataDir
      });
      expect(result.isError).toBe(true);
    });

    it('returns filename matches for active files', async () => {
      const task = createTask();
      const searchRoot = uniqueTaskDir(task, 'search-hits');
      writeFile(path.join(searchRoot, 'UserService.ts'), 'export class UserService {}');
      writeFile(path.join(searchRoot, 'BillingService.ts'), 'export class BillingService {}');

      const result = await safeTool('search_similar_files', {
        task_id: task.id,
        search_term: 'UserService',
        working_directory: searchRoot
      });
      const payload = parseResult(result);

      expect(payload.status).toBe('similar_files_exist');
      expect(payload.matches_found).toBeGreaterThanOrEqual(1);
      expect(payload.matches.some(p => p.endsWith('UserService.ts'))).toBe(true);
      expect(payload.recommendation).toContain('similar file');
    });

    it('handles missing working files as empty results', async () => {
      const task = createTask();
      const emptyDir = uniqueTaskDir(task, 'search-empty');
      fs.mkdirSync(emptyDir, { recursive: true });

      const result = await safeTool('search_similar_files', {
        task_id: task.id,
        search_term: 'DoesNotExist',
        working_directory: path.join(emptyDir, 'does-not-exist')
      });

      const payload = parseResult(result);

      expect(payload.status).toBe('no_matches');
      expect(payload.matches_found).toBe(0);
      expect(payload.matches).toHaveLength(0);
      expect(payload.recommendation).toBeNull();
    });

    it('handles empty file contents without crashing classname search', async () => {
      const task = createTask();
      const searchRoot = uniqueTaskDir(task, 'search-empty-content');
      writeFile(path.join(searchRoot, 'Empty.ts'), '');

      const result = await safeTool('search_similar_files', {
        task_id: task.id,
        search_term: 'SomeMissingClass',
        working_directory: searchRoot,
        search_type: 'classname'
      });

      const payload = parseResult(result);
      expect(payload.status).toBe('no_matches');
      expect(payload.matches_found).toBe(0);
      expect(payload.matches).toHaveLength(0);
    });
  });

  describe('get_similar_file_results', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('get_similar_file_results', {});
      expect(result.isError).toBe(true);
    });

    it('returns past search results for the task', async () => {
      const task = createTask();
      const searchRoot = uniqueTaskDir(task, 'search-history');
      writeFile(path.join(searchRoot, 'History.ts'), 'export class History {}');

      await safeTool('search_similar_files', {
        task_id: task.id,
        search_term: 'History',
        working_directory: searchRoot
      });
      await safeTool('search_similar_files', {
        task_id: task.id,
        search_term: 'Missing',
        working_directory: searchRoot
      });

      const result = await safeTool('get_similar_file_results', { task_id: task.id });
      const payload = parseResult(result);

      expect(payload.search_count).toBe(2);
      expect(payload.results).toHaveLength(2);
      expect(payload.results[0]).toHaveProperty('match_files');
      expect(Array.isArray(payload.results[0].match_files)).toBe(true);
    });

    it('returns error for non-existent task', async () => {
      const result = await safeTool('get_similar_file_results', { task_id: randomUUID() });
      expect(result.isError).toBe(true);
    });

    it('retrieves empty array when no searches were run for task', async () => {
      const task = createTask();
      const result = await safeTool('get_similar_file_results', { task_id: task.id });
      const payload = parseResult(result);

      expect(payload.results).toEqual([]);
      expect(payload.search_count).toBe(0);
    });
  });
});




