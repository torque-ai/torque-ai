/**
 * Snapscope Handlers Tests
 *
 * Tests for handleCaptureScreenshots, handleCaptureView, handleCaptureViews,
 * and handleValidateManifest from the SnapScope plugin handlers.
 *
 * Mocking strategy:
 * - vi.mock('child_process') does NOT work for Node built-ins in pool:forks + CJS mode.
 * - Instead: monkey-patch the child_process module exports BEFORE loading the handler.
 *   The handler destructures { exec, execFile } on require(), so patching first ensures
 *   it captures the mocks.
 * - Node's built-in exec delegates internally to execFile, so patching execFile also
 *   intercepts exec calls from ensureBuilt().
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { EventEmitter } = require('events');
const sharp = require('sharp');

// ─── Patch child_process BEFORE the handler is loaded ────────────────────────
const childProc = require('child_process');
const http = require('http');

const mockExecFile = vi.fn((exe, args, opts, cb) => {
  if (typeof opts === 'function') { opts(null, 'Succeeded: 1  Failed: 0', ''); return; }
  if (typeof cb === 'function') { cb(null, 'Succeeded: 1  Failed: 0', ''); }
});

// execPlain = the exec function used by ensureBuilt()
const mockExecPlain = vi.fn((cmd, opts, cb) => {
  if (typeof opts === 'function') { opts(null); return; }
  if (typeof cb === 'function') { cb(null); }
});

const originalExecFile = childProc.execFile;
const originalExecPlain = childProc['exec'];

// Patch execFile (used by runSnapScopeCli) and exec (used by ensureBuilt)
childProc.execFile = mockExecFile;
childProc['exec'] = mockExecPlain;

const emailPeek = require('../db/email-peek');
const taskCore = require('../db/task-core');
const workflowEngine = require('../db/workflow-engine');
const taskMetadata = require('../db/task-metadata');
const { loadPeekContractFixture } = require('../contracts/peek');
const snapscopeDefs = require('../plugins/snapscope/tool-defs');

const originalHttpGet = http.get;
const originalHttpRequest = http.request;
const originalRegisterPeekHost = emailPeek.registerPeekHost;
const originalUnregisterPeekHost = emailPeek.unregisterPeekHost;
const originalListPeekHosts = emailPeek.listPeekHosts;
const originalGetPeekHost = emailPeek.getPeekHost;
const originalGetDefaultPeekHost = emailPeek.getDefaultPeekHost;
const originalGetTask = taskCore.getTask;
const originalUpdateTask = taskCore.updateTask;
const originalGetWorkflow = workflowEngine.getWorkflow;
const originalUpdateWorkflow = workflowEngine.updateWorkflow;
const originalGetArtifactConfig = taskMetadata.getArtifactConfig;
const originalStoreArtifact = taskMetadata.storeArtifact;
const originalHomedir = os.homedir;

emailPeek.registerPeekHost = vi.fn();
emailPeek.unregisterPeekHost = vi.fn();
emailPeek.listPeekHosts = vi.fn(() => []);
emailPeek.getPeekHost = vi.fn(() => null);
emailPeek.getDefaultPeekHost = vi.fn(() => null);
taskCore.getTask = vi.fn(() => null);
taskCore.updateTask = vi.fn();
workflowEngine.getWorkflow = vi.fn(() => null);
workflowEngine.updateWorkflow = vi.fn();
taskMetadata.getArtifactConfig = vi.fn(() => null);
taskMetadata.storeArtifact = vi.fn((artifact) => artifact);

// ─── Load the handler AFTER patching ─────────────────────────────────────────
const handlers = {
  ...require('../plugins/snapscope/handlers/cli'),
  ...require('../plugins/snapscope/handlers/capture'),
  ...require('../plugins/snapscope/handlers/analysis'),
  ...require('../plugins/snapscope/handlers/artifacts'),
  ...require('../plugins/snapscope/handlers/hosts'),
  ...require('../plugins/snapscope/handlers/recovery'),
  ...require('../plugins/snapscope/handlers/onboarding'),
  ...require('../plugins/snapscope/handlers/compliance'),
  ...require('../plugins/snapscope/handlers/federation'),
  ...require('../plugins/snapscope/handlers/quality-score'),
  ...require('../plugins/snapscope/handlers/accessibility-diff'),
  ...require('../plugins/snapscope/handlers/browser-capture'),
  ...require('../plugins/snapscope/handlers/live-autonomy'),
  ...require('../plugins/snapscope/handlers/rollback'),
  ...require('../plugins/snapscope/handlers/webhook-outbound'),
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
let tempDir;
let mockHttpGetQueue = [];
let mockHttpRequestQueue = [];
let mockHttpRequestBodies = [];

function writeTempManifest(name, content) {
  const p = path.join(tempDir, name);
  fs.writeFileSync(p, JSON.stringify(content), 'utf8');
  return p;
}

function queueHttpResponse(response) {
  mockHttpGetQueue.push(response);
}

function queueHttpRequestResponse(response) {
  mockHttpRequestQueue.push(response);
}

function installHttpGetMock() {
  http.get = vi.fn((url, options, cb) => {
    const next = mockHttpGetQueue.shift() || {};
    const req = new EventEmitter();
    req.destroy = vi.fn();

    process.nextTick(() => {
      if (next.timeout) {
        req.emit('timeout');
        return;
      }

      if (next.error) {
        req.emit('error', new Error(next.error));
        return;
      }

      const res = new EventEmitter();
      res.statusCode = next.statusCode ?? 200;
      cb(res);

      if (next.body !== undefined) {
        const payload = typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
        res.emit('data', Buffer.from(payload));
      }

      res.emit('end');
    });

    return req;
  });
}

function installHttpRequestMock() {
  http.request = vi.fn((url, options, cb) => {
    const next = mockHttpRequestQueue.shift() || {};
    const req = new EventEmitter();
    req.destroy = vi.fn();

    let body = '';
    req.write = vi.fn((chunk) => {
      body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    });
    req.end = vi.fn((chunk) => {
      if (chunk !== undefined) {
        req.write(chunk);
      }
      mockHttpRequestBodies.push(body);

      process.nextTick(() => {
        if (next.timeout) {
          req.emit('timeout');
          return;
        }

        if (next.error) {
          req.emit('error', new Error(next.error));
          return;
        }

        const res = new EventEmitter();
        res.statusCode = next.statusCode ?? 200;
        cb(res);

        if (next.body !== undefined) {
          const payload = typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
          res.emit('data', Buffer.from(payload));
        }

        res.emit('end');
      });
    });

    return req;
  });
}

// ─── Suite ───────────────────────────────────────────────────────────────────
describe('Snapscope Handlers', () => {
  beforeAll(() => {
    tempDir = path.join(os.tmpdir(), 'snapscope-test-' + Date.now());
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterAll(() => {
    childProc.execFile = originalExecFile;
    childProc['exec'] = originalExecPlain;
    http.get = originalHttpGet;
    http.request = originalHttpRequest;
    emailPeek.registerPeekHost = originalRegisterPeekHost;
    emailPeek.unregisterPeekHost = originalUnregisterPeekHost;
    emailPeek.listPeekHosts = originalListPeekHosts;
    emailPeek.getPeekHost = originalGetPeekHost;
    emailPeek.getDefaultPeekHost = originalGetDefaultPeekHost;
    taskCore.getTask = originalGetTask;
    taskCore.updateTask = originalUpdateTask;
    workflowEngine.getWorkflow = originalGetWorkflow;
    workflowEngine.updateWorkflow = originalUpdateWorkflow;
    taskMetadata.getArtifactConfig = originalGetArtifactConfig;
    taskMetadata.storeArtifact = originalStoreArtifact;
    os.homedir = originalHomedir;
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    mockExecFile.mockReset();
    mockExecFile.mockImplementation((exe, args, opts, cb) => {
      if (typeof opts === 'function') { opts(null, 'Succeeded: 1  Failed: 0', ''); return; }
      if (typeof cb === 'function') { cb(null, 'Succeeded: 1  Failed: 0', ''); }
    });
    mockExecPlain.mockReset();
    mockExecPlain.mockImplementation((cmd, opts, cb) => {
      if (typeof opts === 'function') { opts(null); return; }
      if (typeof cb === 'function') { cb(null); }
    });
    mockHttpGetQueue = [];
    mockHttpRequestQueue = [];
    mockHttpRequestBodies = [];
    installHttpGetMock();
    installHttpRequestMock();
    emailPeek.registerPeekHost.mockReset();
    emailPeek.unregisterPeekHost.mockReset();
    emailPeek.listPeekHosts.mockReset();
    emailPeek.getPeekHost.mockReset();
    emailPeek.getDefaultPeekHost.mockReset();
    taskCore.getTask.mockReset();
    taskCore.updateTask.mockReset();
    workflowEngine.getWorkflow.mockReset();
    workflowEngine.updateWorkflow.mockReset();
    taskMetadata.getArtifactConfig.mockReset();
    taskMetadata.storeArtifact.mockReset();
    emailPeek.listPeekHosts.mockImplementation(() => []);
    emailPeek.getPeekHost.mockImplementation(() => null);
    emailPeek.getDefaultPeekHost.mockImplementation(() => null);
    taskCore.getTask.mockImplementation(() => null);
    workflowEngine.getWorkflow.mockImplementation(() => null);
    taskMetadata.getArtifactConfig.mockImplementation(() => ({ storage_path: tempDir }));
    taskMetadata.storeArtifact.mockImplementation((artifact) => ({
      ...artifact,
      created_at: '2026-03-10T00:00:00.000Z',
      expires_at: '2026-04-09T00:00:00.000Z',
    }));
    os.homedir = vi.fn(() => tempDir);
    fs.rmSync(path.join(tempDir, '.peek-ui'), { recursive: true, force: true });
  });

  // ─── handleCaptureScreenshots ───────────────────────────────────────────────
  describe('handleCaptureScreenshots', () => {
    it('returns error when manifest_path is missing', async () => {
      const result = await handlers.handleCaptureScreenshots({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('manifest_path');
    });

    it('returns error when manifest_path is not a string', async () => {
      const result = await handlers.handleCaptureScreenshots({ manifest_path: 42 });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('manifest_path');
    });

    it('returns error when manifest file does not exist', async () => {
      const result = await handlers.handleCaptureScreenshots({
        manifest_path: '/nonexistent/path/manifest.json'
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    });

    it('returns error when timeout_seconds is too high (>600)', async () => {
      const manifestPath = writeTempManifest('ss-timeout-high.json', { views: [] });
      const result = await handlers.handleCaptureScreenshots({
        manifest_path: manifestPath,
        timeout_seconds: 9999
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('timeout');
    });

    it('returns error when timeout_seconds is zero', async () => {
      const manifestPath = writeTempManifest('ss-timeout-zero.json', { views: [] });
      const result = await handlers.handleCaptureScreenshots({
        manifest_path: manifestPath,
        timeout_seconds: 0
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('timeout');
    });

    it('returns error when timeout_seconds is negative', async () => {
      const manifestPath = writeTempManifest('ss-timeout-neg.json', { views: [] });
      const result = await handlers.handleCaptureScreenshots({
        manifest_path: manifestPath,
        timeout_seconds: -5
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('timeout');
    });

    it('succeeds with valid manifest path and default options', async () => {
      const manifestPath = writeTempManifest('ss-valid.json', {
        views: [{ name: 'Dashboard', url: 'http://localhost' }],
        outputDir: 'screenshots'
      });
      const result = await handlers.handleCaptureScreenshots({ manifest_path: manifestPath });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('SnapScope Capture Results');
    });

    it('accepts timeout_seconds at lower boundary (1)', async () => {
      const manifestPath = writeTempManifest('ss-timeout-min.json', { views: [] });
      const result = await handlers.handleCaptureScreenshots({
        manifest_path: manifestPath,
        timeout_seconds: 1
      });
      if (result.isError) {
        expect(result.content[0].text).not.toContain('timeout_seconds must be between');
      }
    });

    it('accepts timeout_seconds at upper boundary (600)', async () => {
      const manifestPath = writeTempManifest('ss-timeout-max.json', { views: [] });
      const result = await handlers.handleCaptureScreenshots({
        manifest_path: manifestPath,
        timeout_seconds: 600
      });
      if (result.isError) {
        expect(result.content[0].text).not.toContain('timeout_seconds must be between');
      }
    });

    it('passes --filter flag to CLI when filter_tag is provided', async () => {
      mockExecFile.mockClear();
      const manifestPath = writeTempManifest('ss-filter.json', {
        views: [{ name: 'Main', url: 'http://localhost' }]
      });
      await handlers.handleCaptureScreenshots({ manifest_path: manifestPath, filter_tag: 'smoke' });
      expect(mockExecFile).toHaveBeenCalled();
      const cliArgs = mockExecFile.mock.calls[0][1];
      expect(cliArgs).toContain('--filter');
      expect(cliArgs).toContain('smoke');
    });

    it('passes --dry-run flag to CLI when dry_run is true', async () => {
      mockExecFile.mockClear();
      const manifestPath = writeTempManifest('ss-dryrun.json', { views: [] });
      await handlers.handleCaptureScreenshots({ manifest_path: manifestPath, dry_run: true });
      expect(mockExecFile).toHaveBeenCalled();
      const cliArgs = mockExecFile.mock.calls[0][1];
      expect(cliArgs).toContain('--dry-run');
    });

    it('returns error when CLI exits with non-zero code', async () => {
      const mockErr = new Error('CLI failed');
      mockErr.code = 1;
      mockExecFile.mockImplementationOnce((exe, args, opts, cb) => {
        if (typeof opts === 'function') { opts(mockErr, '', 'CLI error output'); return; }
        if (typeof cb === 'function') { cb(mockErr, '', 'CLI error output'); }
      });
      const manifestPath = writeTempManifest('ss-fail.json', { views: [] });
      const result = await handlers.handleCaptureScreenshots({ manifest_path: manifestPath });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('SnapScope CLI failed');
    });

    it('passes --manifest flag with manifest path to CLI', async () => {
      mockExecFile.mockClear();
      const manifestPath = writeTempManifest('ss-manifest-flag.json', {
        views: [{ name: 'V1', url: 'http://localhost' }]
      });
      await handlers.handleCaptureScreenshots({ manifest_path: manifestPath });
      expect(mockExecFile).toHaveBeenCalled();
      const cliArgs = mockExecFile.mock.calls[0][1];
      expect(cliArgs).toContain('--manifest');
      expect(cliArgs).toContain(manifestPath);
    });
  });

  // ─── handleCaptureView ──────────────────────────────────────────────────────
  describe('handleCaptureView', () => {
    it('returns error when manifest_path is missing', async () => {
      const result = await handlers.handleCaptureView({ view_name: 'Dashboard' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('manifest_path');
    });

    it('returns error when view_name is missing', async () => {
      const manifestPath = writeTempManifest('view-no-viewname.json', {
        views: [{ name: 'Dashboard', url: 'http://localhost' }]
      });
      const result = await handlers.handleCaptureView({ manifest_path: manifestPath });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('view_name');
    });

    it('returns error when manifest file does not exist', async () => {
      const result = await handlers.handleCaptureView({
        manifest_path: '/nonexistent/manifest.json',
        view_name: 'Dashboard'
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    });

    it('returns error when view is not found in manifest', async () => {
      const manifestPath = writeTempManifest('view-not-found.json', {
        views: [{ name: 'Dashboard', url: 'http://localhost' }]
      });
      const result = await handlers.handleCaptureView({
        manifest_path: manifestPath,
        view_name: 'NonExistentView'
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('NonExistentView');
      expect(result.content[0].text).toContain('not found');
    });

    it('returns error when manifest JSON is invalid', async () => {
      const p = path.join(tempDir, 'invalid-view.json');
      fs.writeFileSync(p, 'not valid json', 'utf8');
      const result = await handlers.handleCaptureView({ manifest_path: p, view_name: 'Dashboard' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to parse manifest');
    });

    it('validates timeout_seconds range (above 600)', async () => {
      const manifestPath = writeTempManifest('view-timeout.json', {
        views: [{ name: 'Dashboard', url: 'http://localhost' }]
      });
      const result = await handlers.handleCaptureView({
        manifest_path: manifestPath,
        view_name: 'Dashboard',
        timeout_seconds: 999
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('timeout');
    });

    it('succeeds with valid manifest and existing view', async () => {
      const manifestPath = writeTempManifest('view-valid.json', {
        views: [{ name: 'Dashboard', url: 'http://localhost' }],
        outputDir: 'screenshots'
      });
      const result = await handlers.handleCaptureView({
        manifest_path: manifestPath,
        view_name: 'Dashboard'
      });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Dashboard');
    });

    it('passes --view flag with view name to CLI', async () => {
      mockExecFile.mockClear();
      const manifestPath = writeTempManifest('view-flag.json', {
        views: [{ name: 'MainView', url: 'http://localhost' }]
      });
      await handlers.handleCaptureView({ manifest_path: manifestPath, view_name: 'MainView' });
      expect(mockExecFile).toHaveBeenCalled();
      const cliArgs = mockExecFile.mock.calls[0][1];
      expect(cliArgs).toContain('--view');
      expect(cliArgs).toContain('MainView');
    });

    it('passes --output flag to CLI when output_dir is provided', async () => {
      mockExecFile.mockClear();
      const manifestPath = writeTempManifest('view-output.json', {
        views: [{ name: 'Main', url: 'http://localhost' }]
      });
      const outDir = path.join(tempDir, 'output');
      await handlers.handleCaptureView({
        manifest_path: manifestPath,
        view_name: 'Main',
        output_dir: outDir
      });
      expect(mockExecFile).toHaveBeenCalled();
      const cliArgs = mockExecFile.mock.calls[0][1];
      expect(cliArgs).toContain('--output');
      expect(cliArgs).toContain(outDir);
    });

    it('returns error when CLI exits with non-zero code', async () => {
      const mockErr = new Error('CLI failed');
      mockErr.code = 1;
      mockExecFile.mockImplementationOnce((exe, args, opts, cb) => {
        if (typeof opts === 'function') { opts(mockErr, '', 'stderr output'); return; }
        if (typeof cb === 'function') { cb(mockErr, '', 'stderr output'); }
      });
      const manifestPath = writeTempManifest('view-fail.json', {
        views: [{ name: 'FailView', url: 'http://localhost' }]
      });
      const result = await handlers.handleCaptureView({
        manifest_path: manifestPath,
        view_name: 'FailView'
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('SnapScope CLI failed');
    });
  });

  // ─── handleCaptureViews ─────────────────────────────────────────────────────
  describe('handleCaptureViews', () => {
    it('returns error when manifest_path is missing', async () => {
      const result = await handlers.handleCaptureViews({ view_names: ['Dashboard'] });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('manifest_path');
    });

    it('returns error when view_names is missing', async () => {
      const manifestPath = writeTempManifest('views-no-names.json', { views: [] });
      const result = await handlers.handleCaptureViews({ manifest_path: manifestPath });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('view_names');
    });

    it('returns error when view_names is an empty array', async () => {
      const manifestPath = writeTempManifest('views-empty.json', { views: [] });
      const result = await handlers.handleCaptureViews({ manifest_path: manifestPath, view_names: [] });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('view_names');
    });

    it('returns error when manifest file does not exist', async () => {
      const result = await handlers.handleCaptureViews({
        manifest_path: '/no/such/manifest.json',
        view_names: ['Dashboard']
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    });

    it('returns error when a requested view is not in the manifest', async () => {
      const manifestPath = writeTempManifest('views-unmatched.json', {
        views: [{ name: 'Dashboard', url: 'http://localhost' }]
      });
      const result = await handlers.handleCaptureViews({
        manifest_path: manifestPath,
        view_names: ['Dashboard', 'MissingView']
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('MissingView');
    });

    it('returns error when manifest JSON is invalid', async () => {
      const p = path.join(tempDir, 'views-invalid.json');
      fs.writeFileSync(p, '{ broken json', 'utf8');
      const result = await handlers.handleCaptureViews({ manifest_path: p, view_names: ['Dashboard'] });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to parse manifest');
    });

    it('validates timeout_seconds range (above max)', async () => {
      const manifestPath = writeTempManifest('views-timeout.json', {
        views: [{ name: 'Main', url: 'http://localhost' }]
      });
      const result = await handlers.handleCaptureViews({
        manifest_path: manifestPath,
        view_names: ['Main'],
        timeout_seconds: 601
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('timeout');
    });

    it('succeeds with valid manifest and matched views', async () => {
      const manifestPath = writeTempManifest('views-valid.json', {
        views: [
          { name: 'Dashboard', url: 'http://localhost/dashboard' },
          { name: 'Settings', url: 'http://localhost/settings' }
        ]
      });
      const result = await handlers.handleCaptureViews({
        manifest_path: manifestPath,
        view_names: ['Dashboard', 'Settings']
      });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('SnapScope Batch');
    });

    it('includes view count in success output', async () => {
      const manifestPath = writeTempManifest('views-count.json', {
        views: [
          { name: 'View1', url: 'http://localhost/1' },
          { name: 'View2', url: 'http://localhost/2' }
        ]
      });
      const result = await handlers.handleCaptureViews({
        manifest_path: manifestPath,
        view_names: ['View1', 'View2']
      });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('2 views');
    });

    it('returns error when CLI exits with non-zero code', async () => {
      const mockErr = new Error('CLI failed');
      mockErr.code = 1;
      mockExecFile.mockImplementationOnce((exe, args, opts, cb) => {
        if (typeof opts === 'function') { opts(mockErr, '', 'CLI error'); return; }
        if (typeof cb === 'function') { cb(mockErr, '', 'CLI error'); }
      });
      const manifestPath = writeTempManifest('views-fail.json', {
        views: [{ name: 'FailView', url: 'http://localhost' }]
      });
      const result = await handlers.handleCaptureViews({
        manifest_path: manifestPath,
        view_names: ['FailView']
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('SnapScope CLI failed');
    });
  });

  // ─── handleValidateManifest ─────────────────────────────────────────────────
  describe('handleValidateManifest', () => {
    it('returns error when manifest_path is missing', async () => {
      const result = await handlers.handleValidateManifest({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('manifest_path');
    });

    it('returns error when manifest_path is not a string', async () => {
      const result = await handlers.handleValidateManifest({ manifest_path: null });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('manifest_path');
    });

    it('returns error when manifest file does not exist', async () => {
      const result = await handlers.handleValidateManifest({ manifest_path: '/no/such/file.json' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    });

    it('returns successful validation result when CLI exits 0', async () => {
      mockExecFile.mockImplementationOnce((exe, args, opts, cb) => {
        const stdout = '2 view(s) selected\n- Dashboard\n- Settings\n';
        if (typeof opts === 'function') { opts(null, stdout, ''); return; }
        if (typeof cb === 'function') { cb(null, stdout, ''); }
      });
      const manifestPath = writeTempManifest('validate-valid.json', {
        views: [
          { name: 'Dashboard', url: 'http://localhost/dashboard' },
          { name: 'Settings', url: 'http://localhost/settings' }
        ]
      });
      const result = await handlers.handleValidateManifest({ manifest_path: manifestPath });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Manifest Validation');
      expect(result.content[0].text).toContain('Valid');
    });

    it('returns invalid result text when CLI exits non-zero', async () => {
      const mockErr = new Error('Validation failed');
      mockErr.code = 1;
      mockExecFile.mockImplementationOnce((exe, args, opts, cb) => {
        const stderr = 'Error: missing required field "url"';
        if (typeof opts === 'function') { opts(mockErr, '', stderr); return; }
        if (typeof cb === 'function') { cb(mockErr, '', stderr); }
      });
      const manifestPath = writeTempManifest('validate-invalid.json', {
        views: [{ name: 'Broken' }]
      });
      const result = await handlers.handleValidateManifest({ manifest_path: manifestPath });
      expect(result.content[0].text).toContain('Manifest Validation');
      expect(result.content[0].text).toContain('Invalid');
    });

    it('includes view count from CLI stdout when present', async () => {
      mockExecFile.mockImplementationOnce((exe, args, opts, cb) => {
        const stdout = '3 view(s) selected\n- View1\n- View2\n- View3\n';
        if (typeof opts === 'function') { opts(null, stdout, ''); return; }
        if (typeof cb === 'function') { cb(null, stdout, ''); }
      });
      const manifestPath = writeTempManifest('validate-count.json', {
        views: [
          { name: 'View1', url: 'http://localhost/1' },
          { name: 'View2', url: 'http://localhost/2' },
          { name: 'View3', url: 'http://localhost/3' }
        ]
      });
      const result = await handlers.handleValidateManifest({ manifest_path: manifestPath });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('3');
    });

    it('passes --validate and --dry-run flags to CLI', async () => {
      mockExecFile.mockClear();
      mockExecFile.mockImplementationOnce((exe, args, opts, cb) => {
        if (typeof opts === 'function') { opts(null, '', ''); return; }
        if (typeof cb === 'function') { cb(null, '', ''); }
      });
      const manifestPath = writeTempManifest('validate-flags.json', { views: [] });
      await handlers.handleValidateManifest({ manifest_path: manifestPath });
      expect(mockExecFile).toHaveBeenCalled();
      const cliArgs = mockExecFile.mock.calls[0][1];
      expect(cliArgs).toContain('--validate');
      expect(cliArgs).toContain('--dry-run');
    });
  });

  // ─── peek host management ──────────────────────────────────────────────────
  describe('peek host management', () => {
    it('registers a peek host through the email-peek module', async () => {
      const result = await handlers.handleRegisterPeekHost({
        name: 'omen',
        url: 'http://omen:9876',
        ssh: 'user@omen',
        default: true,
        platform: 'windows'
      });

      expect(result.isError).toBeFalsy();
      expect(emailPeek.registerPeekHost).toHaveBeenCalledWith(
        'omen',
        'http://omen:9876',
        'user@omen',
        true,
        'windows'
      );
      expect(result.content[0].text).toContain('Peek Host Registered');
    });

    it('returns an error when unregistering an unknown peek host', async () => {
      emailPeek.unregisterPeekHost.mockImplementation(() => false);

      const result = await handlers.handleUnregisterPeekHost({ name: 'missing-host' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Peek host not found');
    });

    it('lists peek hosts with live health status', async () => {
      emailPeek.listPeekHosts.mockImplementation(() => [
        { name: 'omen', url: 'http://omen:9876', is_default: 1, platform: 'windows' },
        { name: 'lab', url: 'http://lab:9876', is_default: 0, platform: 'linux' }
      ]);
      queueHttpResponse({ body: { status: 'healthy' } });
      queueHttpResponse({ error: 'connect ECONNREFUSED' });

      const result = await handlers.handleListPeekHosts({});

      expect(result.isError).toBeFalsy();
      expect(http.get).toHaveBeenCalledTimes(2);
      expect(result.content[0].text).toContain('| Name | URL | Default | Platform | Status |');
      expect(result.content[0].text).toContain('| omen | http://omen:9876 | Yes | windows | healthy |');
      expect(result.content[0].text).toContain('| lab | http://lab:9876 | No | linux | connect ECONNREFUSED |');
    });

    it('normalizes the published health payload status and capabilities contract', async () => {
      const capabilityFixture = loadPeekContractFixture('peek-capabilities-v1.json');
      emailPeek.listPeekHosts.mockImplementation(() => [
        { name: 'omen', url: 'http://omen:9876', is_default: 1, platform: 'windows' },
      ]);
      queueHttpResponse({
        body: {
          status: 'ok',
          host: 'omen-host',
          hostname: 'omen-host',
          platform: 'windows',
          version: capabilityFixture.versioning.runtime_version,
          contracts: {
            capabilities: capabilityFixture.contract,
            investigation_bundle: {
              name: 'peek_investigation_bundle',
              version: 1,
            },
          },
          capabilities: capabilityFixture,
        }
      });

      const result = await handlers.handleListPeekHosts({});

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('| omen | http://omen:9876 | Yes | windows | healthy |');
    });
  });

  // ─── peek_ui ───────────────────────────────────────────────────────────────
  describe('handlePeekUi', () => {
    it('applies annotations and writes the annotated image to disk', { timeout: 30000 }, async () => {
      emailPeek.getDefaultPeekHost.mockImplementation(() => ({
        name: 'omen',
        url: 'http://omen:9876'
      }));

      const baseImage = await sharp({
        create: {
          width: 64,
          height: 64,
          channels: 4,
          background: { r: 255, g: 255, b: 255, alpha: 1 }
        }
      }).png().toBuffer();
      const savePath = path.join(tempDir, `peek-annotated-${Date.now()}.png`);

      queueHttpResponse({ body: { status: 'healthy' } });
      queueHttpResponse({
        body: {
          image: baseImage.toString('base64'),
          format: 'png',
          mime_type: 'image/png',
          mode: 'screen',
          width: 64,
          height: 64,
          size_bytes: baseImage.length
        }
      });

      const result = await handlers.handlePeekUi({
        save_path: savePath,
        format: 'png',
        annotations: [
          {
            type: 'rect',
            x: 8,
            y: 8,
            w: 24,
            h: 24,
            color: 'red',
            label: 'Target'
          }
        ]
      });

      expect(result.isError).toBeFalsy();
      expect(fs.existsSync(savePath)).toBe(true);

      const savedBuffer = fs.readFileSync(savePath);
      expect(savedBuffer.equals(baseImage)).toBe(false);

      expect(result.content[0]).toMatchObject({
        type: 'image',
        mimeType: 'image/png'
      });
      expect(result.content[0].data).toBe(savedBuffer.toString('base64'));
      expect(result.content[1].text).toContain('peek_ui capture');
      expect(result.content[1].text).toContain(`**Saved to:** ${savePath}`);
    });

    it('routes through a named host and diffs against a saved baseline', async () => {
      emailPeek.getPeekHost.mockImplementation(() => ({
        name: 'lab',
        url: 'http://lab:9876'
      }));

      const baselineDir = path.join(tempDir, '.peek-ui', 'baselines', 'default');
      fs.mkdirSync(baselineDir, { recursive: true });
      fs.writeFileSync(path.join(baselineDir, 'smoke.png'), Buffer.from('old-baseline'));

      const currentImage = Buffer.from('new-current-image');
      const diffImage = Buffer.from('diff-image');
      const savePath = path.join(tempDir, 'named-host-capture.png');

      queueHttpResponse({ body: { status: 'healthy' } });
      queueHttpResponse({
        body: {
          image: currentImage.toString('base64'),
          format: 'png',
          mime_type: 'image/png',
          mode: 'title',
          title: 'Dashboard',
          process: 'torque',
          width: 80,
          height: 40,
          size_bytes: currentImage.length
        }
      });
      queueHttpRequestResponse({
        body: {
          diff_image: diffImage.toString('base64'),
          diff_mime_type: 'image/png',
          changed_pixels: 42,
          diff_percent: 0.02,
          passed: false
        }
      });

      const result = await handlers.handlePeekUi({
        host: 'lab',
        title: 'Dashboard',
        format: 'png',
        save_path: savePath,
        save_baseline: 'smoke',
        diff_baseline: 'smoke'
      });

      expect(result.isError).toBeFalsy();
      expect(emailPeek.getPeekHost).toHaveBeenCalledWith('lab');
      expect(http.get).toHaveBeenNthCalledWith(1, 'http://lab:9876/health', { timeout: 5000 }, expect.any(Function));
      expect(String(http.get.mock.calls[1][0])).toContain('http://lab:9876/peek?');
      expect(String(http.request.mock.calls[0][0].href || http.request.mock.calls[0][0])).toBe('http://lab:9876/compare');

      const comparePayload = JSON.parse(mockHttpRequestBodies[0]);
      expect(comparePayload.baseline).toBe(Buffer.from('old-baseline').toString('base64'));
      expect(comparePayload.current).toBe(currentImage.toString('base64'));
      expect(comparePayload.threshold).toBe(0.01);

      expect(fs.readFileSync(path.join(baselineDir, 'smoke.png')).equals(currentImage)).toBe(true);

      expect(result.content).toHaveLength(3);
      expect(result.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
      expect(result.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
      expect(result.content[2].text).toContain('**Diff Source:** baseline:smoke');
      expect(result.content[2].text).toContain('**Changed Pixels:** 42');
      expect(result.content[2].text).toContain('**Host:** lab');
    });

    it('uses the default host and auto-diffs against the previous capture for the same target', async () => {
      emailPeek.getDefaultPeekHost.mockImplementation(() => ({
        name: 'omen',
        url: 'http://omen:9876'
      }));

      const previousDir = path.join(tempDir, '.peek-ui', 'last', 'default');
      const previousPath = path.join(previousDir, 'process-my-app.png');
      fs.mkdirSync(previousDir, { recursive: true });
      fs.writeFileSync(previousPath, Buffer.from('old-last-capture'));

      const currentImage = Buffer.from('fresh-current-capture');
      const diffImage = Buffer.from('auto-diff-image');
      const savePath = path.join(tempDir, 'auto-diff-capture.png');

      queueHttpResponse({ body: { status: 'healthy' } });
      queueHttpResponse({
        body: {
          image: currentImage.toString('base64'),
          format: 'png',
          mime_type: 'image/png',
          mode: 'process',
          process: 'My App',
          width: 120,
          height: 60,
          size_bytes: currentImage.length
        }
      });
      queueHttpRequestResponse({
        body: {
          diff_image: diffImage.toString('base64'),
          diff_mime_type: 'image/png',
          changed_pixels: 9,
          diff_percent: 0.005,
          passed: true
        }
      });

      const result = await handlers.handlePeekUi({
        process: 'My App',
        format: 'png',
        save_path: savePath,
        auto_diff: true
      });

      expect(result.isError).toBeFalsy();
      expect(emailPeek.getDefaultPeekHost).toHaveBeenCalled();
      expect(http.get).toHaveBeenNthCalledWith(1, 'http://omen:9876/health', { timeout: 5000 }, expect.any(Function));

      const comparePayload = JSON.parse(mockHttpRequestBodies[0]);
      expect(comparePayload.baseline).toBe(Buffer.from('old-last-capture').toString('base64'));
      expect(comparePayload.current).toBe(currentImage.toString('base64'));
      expect(fs.readFileSync(previousPath).equals(currentImage)).toBe(true);

      expect(result.content).toHaveLength(3);
      expect(result.content[2].text).toContain('**Diff Source:** last:process-my-app');
      expect(result.content[2].text).toContain('**Within Threshold:** Yes');
      expect(result.content[2].text).toContain('**Host:** omen');
    });

    it('returns an invalid-param error when an explicitly requested host is missing', async () => {
      emailPeek.getPeekHost.mockImplementation(() => null);

      const result = await handlers.handlePeekUi({ host: 'missing-host' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Peek host not found: missing-host');
      expect(http.get).not.toHaveBeenCalled();
    });
  });

  describe('handlePeekDiagnose', () => {
    it('posts the Torque-supported request subset and surfaces bundle contract metadata', async () => {
      const bundleFixture = loadPeekContractFixture('peek-investigation-bundle-v1.json');
      emailPeek.getDefaultPeekHost.mockImplementation(() => ({
        name: 'omen',
        url: 'http://omen:9876'
      }));

      queueHttpRequestResponse({
        body: {
          success: true,
          screenshot: bundleFixture.evidence.screenshot.data,
          annotated_screenshot: bundleFixture.evidence.annotated_screenshot.data,
          elements: bundleFixture.evidence.elements,
          measurements: bundleFixture.evidence.measurements,
          text_content: bundleFixture.evidence.text_content,
          bundle: bundleFixture,
          format: 'png'
        }
      });

      const result = await handlers.handlePeekDiagnose({
        process: 'Taskmgr',
        elements: true,
        annotate: true,
        text_content: true,
        measurements: true,
        format: 'png',
        quality: 80,
        max_width: 1280,
        timeout_seconds: 20,
      });

      expect(result.isError).toBeFalsy();
      expect(http.request).toHaveBeenCalledTimes(1);
      expect(String(http.request.mock.calls[0][0].href || http.request.mock.calls[0][0])).toBe('http://omen:9876/diagnose');
      expect(JSON.parse(mockHttpRequestBodies[0])).toEqual({
        mode: 'process',
        name: 'Taskmgr',
        annotate: true,
        elements: true,
        measurements: true,
        text_content: true,
        format: 'png',
        quality: 80,
        max_width: 1280,
        persist: true,
      });
      expect(result.content[2].text).toContain('**Bundle Contract:** peek_investigation_bundle v1');
      expect(result.content[2].text).toContain('**Artifacts Persisted:** No');
      expect(result.content[2].text).toContain('**Bundle Signed:** No');
    });

    it('stores persisted bundle artifacts against the owning task and workflow when task context is present', async () => {
      const bundleDir = path.join(tempDir, 'peek-bundle-output');
      fs.mkdirSync(bundleDir, { recursive: true });
      const bundlePath = path.join(bundleDir, 'bundle.json');
      const artifactReportPath = path.join(bundleDir, 'artifact-report.json');
      fs.writeFileSync(bundlePath, '{"bundle":true}', 'utf8');
      fs.writeFileSync(artifactReportPath, '{"report":true}', 'utf8');

      const bundleFixture = loadPeekContractFixture('peek-investigation-bundle-v1.json');
      bundleFixture.artifacts.persisted = true;
      bundleFixture.artifacts.bundle_path = bundlePath;
      bundleFixture.artifacts.artifact_report_path = artifactReportPath;

      emailPeek.getDefaultPeekHost.mockImplementation(() => ({
        name: 'omen',
        url: 'http://omen:9876'
      }));
      taskCore.getTask.mockImplementation(() => ({
        id: 'task-peek-1',
        metadata: {},
        workflow_id: 'wf-peek-1',
        workflow_node_id: 'diagnose-ui',
      }));
      workflowEngine.getWorkflow.mockImplementation(() => ({
        id: 'wf-peek-1',
        context: {},
      }));

      queueHttpRequestResponse({
        body: {
          success: true,
          screenshot: bundleFixture.evidence.screenshot.data,
          annotated_screenshot: bundleFixture.evidence.annotated_screenshot.data,
          elements: bundleFixture.evidence.elements,
          measurements: bundleFixture.evidence.measurements,
          text_content: bundleFixture.evidence.text_content,
          bundle: bundleFixture,
          format: 'png'
        }
      });

      const result = await handlers.handlePeekDiagnose({
        process: 'Taskmgr',
        format: 'png',
        __taskId: 'task-peek-1',
        __workflowId: 'wf-peek-1',
      });

      const requestBody = JSON.parse(mockHttpRequestBodies[0]);
      expect(requestBody.persist).toBe(true);
      expect(typeof requestBody.output_dir).toBe('string');
      expect(requestBody.output_dir).toContain(path.join('task-peek-1', 'peek-diagnose'));

      expect(taskMetadata.storeArtifact).toHaveBeenCalledTimes(2);
      expect(taskMetadata.storeArtifact.mock.calls[0][0]).toEqual(expect.objectContaining({
        task_id: 'task-peek-1',
        name: 'bundle.json',
        file_path: bundlePath,
        metadata: expect.objectContaining({
          signed_metadata: expect.objectContaining({
            bundle_version: bundleFixture.contract.version,
            checksum: expect.any(String),
            algorithm: 'sha256',
            signer: 'torque-agent',
          }),
          integrity: {
            valid: true,
          },
        }),
      }));
      expect(taskCore.updateTask).toHaveBeenCalledWith('task-peek-1', expect.objectContaining({
        metadata: expect.objectContaining({
          peek: expect.objectContaining({
            bundle_references: expect.arrayContaining([
              expect.objectContaining({
                artifact_id: expect.any(String),
                path: bundlePath,
              }),
            ]),
          }),
        }),
      }));
      expect(workflowEngine.updateWorkflow).toHaveBeenCalledWith('wf-peek-1', expect.objectContaining({
        context: expect.objectContaining({
          peek: expect.objectContaining({
            bundle_references: expect.arrayContaining([
              expect.objectContaining({
                task_label: 'diagnose-ui',
                path: bundlePath,
              }),
            ]),
          }),
        }),
      }));
      expect(result.peek_bundle_artifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          artifact_id: expect.any(String),
          path: bundlePath,
          task_label: 'diagnose-ui',
        }),
      ]));
      expect(result.content[2].text).toContain('### Bundle Artifacts');
      expect(result.content[2].text).toContain(bundlePath);
    });
  });

  describe('peek_ui tool definition', () => {
    it('declares annotation input support', () => {
      const peekUiDef = snapscopeDefs.find((tool) => tool.name === 'peek_ui');
      const annotations = peekUiDef?.inputSchema?.properties?.annotations;

      expect(annotations).toMatchObject({
        type: 'array',
        description: 'Annotations to draw on the captured image'
      });
      expect(annotations.items.required).toEqual(['type']);
      expect(annotations.items.properties.type.enum).toEqual(['rect', 'circle', 'arrow']);
      expect(annotations.items.properties.color.default).toBe('red');
    });

    it('declares host routing and baseline diff inputs', () => {
      const peekUiDef = snapscopeDefs.find((tool) => tool.name === 'peek_ui');
      const props = peekUiDef?.inputSchema?.properties || {};

      expect(props.host).toMatchObject({
        type: 'string',
        description: 'Name of a registered peek host (default: use default host from registry)'
      });
      expect(props.save_baseline).toMatchObject({
        type: 'string',
        description: 'Save this capture as a named baseline for future comparison'
      });
      expect(props.diff_baseline).toMatchObject({
        type: 'string',
        description: 'Compare this capture against a previously saved baseline by name'
      });
      expect(props.auto_diff).toMatchObject({
        type: 'boolean',
        default: false,
        description: 'Automatically diff against the last capture of the same target'
      });
    });
  });
});
