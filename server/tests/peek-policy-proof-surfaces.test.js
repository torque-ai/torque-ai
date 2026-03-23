'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { PROOF_SURFACE_CATALOG } = require('../contracts/peek');
const { createTables } = require('../db/schema-tables');
const policyProofAudit = require('../db/peek-policy-audit');

const DATABASE_MODULE_PATH = path.resolve(__dirname, '..', 'database.js');
const LOGGER_MODULE_PATH = path.resolve(__dirname, '..', 'logger.js');
const TASK_CORE_MODULE_PATH = path.resolve(__dirname, '..', 'db', 'task-core.js');
const TASK_METADATA_MODULE_PATH = path.resolve(__dirname, '..', 'db', 'task-metadata.js');
const WORKFLOW_ENGINE_MODULE_PATH = path.resolve(__dirname, '..', 'db', 'workflow-engine.js');
const PEEK_POLICY_AUDIT_MODULE_PATH = path.resolve(__dirname, '..', 'db', 'peek-policy-audit.js');
const PEEK_SHARED_MODULE_PATH = path.resolve(__dirname, '..', 'handlers', 'peek', 'shared.js');
const PEEK_WEBHOOK_MODULE_PATH = path.resolve(__dirname, '..', 'handlers', 'peek', 'webhook-outbound.js');
const PEEK_ARTIFACTS_MODULE_PATH = path.resolve(__dirname, '..', 'handlers', 'peek', 'artifacts.js');
const PEEK_CAPTURE_MODULE_PATH = path.resolve(__dirname, '..', 'handlers', 'peek', 'capture.js');

function makeProof(overrides = {}) {
  return {
    evaluated_at: '2026-03-11T12:00:00.000Z',
    policies_checked: 3,
    passed: 1,
    warned: 1,
    failed: 0,
    blocked: 0,
    mode: 'advisory',
    details: [
      {
        policy_id: 'policy-1',
        outcome: 'warn',
        message: 'example proof',
      },
    ],
    ...overrides,
  };
}

function setMockModule(modulePath, mock, restoreRegistry) {
  const resolvedPath = require.resolve(modulePath);
  if (!restoreRegistry.has(resolvedPath)) {
    restoreRegistry.set(
      resolvedPath,
      Object.prototype.hasOwnProperty.call(require.cache, resolvedPath) ? require.cache[resolvedPath] : null,
    );
  }

  require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    loaded: true,
    exports: mock,
  };
}

function restoreMockModules(restoreRegistry) {
  for (const [resolvedPath, originalEntry] of restoreRegistry.entries()) {
    if (originalEntry) {
      require.cache[resolvedPath] = originalEntry;
    } else {
      delete require.cache[resolvedPath];
    }
  }
}

function loadArtifactsModule({ databaseMock, tempRoot, restoreRegistry }) {
  setMockModule(DATABASE_MODULE_PATH, databaseMock, restoreRegistry);
  setMockModule(TASK_CORE_MODULE_PATH, databaseMock, restoreRegistry);
  setMockModule(TASK_METADATA_MODULE_PATH, databaseMock, restoreRegistry);
  setMockModule(WORKFLOW_ENGINE_MODULE_PATH, databaseMock, restoreRegistry);
  setMockModule(PEEK_POLICY_AUDIT_MODULE_PATH, databaseMock, restoreRegistry);
  setMockModule(LOGGER_MODULE_PATH, {
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }, restoreRegistry);
  setMockModule(PEEK_SHARED_MODULE_PATH, {
    getTorqueArtifactStorageRoot: () => tempRoot,
    inferPeekArtifactMimeType: (filePath) => (
      path.extname(filePath).toLowerCase() === '.json'
        ? 'application/json'
        : 'application/octet-stream'
    ),
    sanitizePeekTargetKey: (value, fallback) => {
      const normalized = String(value || '')
        .trim()
        .replace(/[^a-zA-Z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '');
      return normalized || fallback;
    },
  }, restoreRegistry);
  setMockModule(PEEK_WEBHOOK_MODULE_PATH, {
    fireWebhookForEvent: vi.fn(() => Promise.resolve()),
  }, restoreRegistry);

  delete require.cache[require.resolve(PEEK_ARTIFACTS_MODULE_PATH)];
  return require(PEEK_ARTIFACTS_MODULE_PATH);
}

function loadCaptureModule({ databaseMock, sharedMock, tempHome, restoreRegistry }) {
  setMockModule(DATABASE_MODULE_PATH, databaseMock, restoreRegistry);
  setMockModule(PEEK_POLICY_AUDIT_MODULE_PATH, databaseMock, restoreRegistry);
  setMockModule(LOGGER_MODULE_PATH, {
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }, restoreRegistry);
  setMockModule(PEEK_SHARED_MODULE_PATH, sharedMock, restoreRegistry);

  vi.spyOn(os, 'homedir').mockReturnValue(tempHome);
  delete require.cache[require.resolve(PEEK_CAPTURE_MODULE_PATH)];
  return require(PEEK_CAPTURE_MODULE_PATH);
}

describe('peek policy proof surfaces', () => {
  let db;
  let logger;
  let restoreRegistry;
  let tempDirs;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    restoreRegistry = new Map();
    tempDirs = [];

    createTables(db, logger);
    policyProofAudit.setDb(db);
  });

  afterEach(() => {
    policyProofAudit.setDb(null);
    restoreMockModules(restoreRegistry);
    vi.restoreAllMocks();
    delete require.cache[require.resolve(PEEK_ARTIFACTS_MODULE_PATH)];
    delete require.cache[require.resolve(PEEK_CAPTURE_MODULE_PATH)];

    for (const tempDir of tempDirs) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    if (db) {
      db.close();
      db = null;
    }
  });

  it('PROOF_SURFACE_CATALOG has 4 frozen surface descriptions', () => {
    expect(Object.keys(PROOF_SURFACE_CATALOG).sort()).toEqual([
      'artifact_persistence',
      'bundle_creation',
      'capture_analysis',
      'recovery_execution',
    ]);
    expect(Object.isFrozen(PROOF_SURFACE_CATALOG)).toBe(true);

    for (const description of Object.values(PROOF_SURFACE_CATALOG)) {
      expect(description).toEqual(expect.any(String));
      expect(description.length).toBeGreaterThan(0);
    }
  });

  it('stores a policy proof audit row when artifacts are persisted', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'peek-proof-artifacts-'));
    tempDirs.push(tempRoot);

    const bundlePath = path.join(tempRoot, 'bundle.json');
    fs.writeFileSync(bundlePath, JSON.stringify({ capture_data: { image: 'abc' } }), 'utf8');

    const formatPolicyProof = vi.fn((payload) => policyProofAudit.formatPolicyProof(payload));
    const artifacts = loadArtifactsModule({
      tempRoot,
      restoreRegistry,
      databaseMock: {
        formatPolicyProof,
        storeArtifact: vi.fn((artifact) => ({
          ...artifact,
          id: artifact.id || 'artifact-1',
          file_path: artifact.file_path,
          mime_type: artifact.mime_type,
        })),
      },
    });

    const refs = artifacts.storePeekArtifactsForTask('task-artifact', [{
      kind: 'bundle_json',
      name: 'bundle.json',
      path: bundlePath,
    }], {
      workflowId: 'wf-artifact',
      policyProof: makeProof(),
    });

    expect(refs).toHaveLength(1);
    expect(formatPolicyProof).toHaveBeenCalledTimes(1);

    const rows = db.prepare('SELECT * FROM policy_proof_audit ORDER BY id ASC').all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      surface: 'artifact_persistence',
      policy_family: 'peek',
      decision: 'warn',
    });
    expect(rows[0].proof_hash).toEqual(expect.any(String));

    const context = JSON.parse(rows[0].context_json);
    expect(context).toMatchObject({
      task_id: 'task-artifact',
      workflow_id: 'wf-artifact',
      action: 'store_artifacts',
      artifact_count: 1,
    });
  });

  it('stores a policy proof audit row when capture analysis completes', async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'peek-proof-capture-'));
    tempDirs.push(tempHome);

    const savePath = path.join(tempHome, 'capture.png');
    const formatPolicyProof = vi.fn((payload) => policyProofAudit.formatPolicyProof(payload));
    const capture = loadCaptureModule({
      tempHome,
      restoreRegistry,
      databaseMock: {
        formatPolicyProof,
      },
      sharedMock: {
        escapeXml: (value) => String(value),
        formatBytes: (value) => `${value} bytes`,
        getPeekTargetKey: () => 'process-chrome-exe',
        peekHttpGetUrl: vi.fn(async () => ({ data: { ok: true } })),
        peekHttpGetWithRetry: vi.fn(async () => ({
          data: {
            image: Buffer.from('capture-image').toString('base64'),
            format: 'png',
            mime_type: 'image/png',
            mode: 'process',
            process: 'chrome.exe',
            title: 'Docs',
            width: 1280,
            height: 720,
            size_bytes: 13,
          },
        })),
        peekHttpPostWithRetry: vi.fn(),
        postCompareWithRetry: vi.fn(),
        resolvePeekHost: vi.fn(() => ({
          hostName: 'peek-host',
          hostUrl: 'http://peek-host:9876',
        })),
      },
    });

    const result = await capture.handlePeekUi({
      process: 'chrome.exe',
      save_path: savePath,
      task_id: 'task-capture',
      workflow_id: 'wf-capture',
      policyProof: makeProof({
        mode: 'block',
        warned: 0,
        failed: 1,
        blocked: 1,
        passed: 0,
      }),
    });

    expect(result.error_code).toBeUndefined();
    expect(formatPolicyProof).toHaveBeenCalledTimes(1);

    const rows = db.prepare('SELECT * FROM policy_proof_audit ORDER BY id ASC').all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      surface: 'capture_analysis',
      policy_family: 'peek',
      decision: 'deny',
    });
    expect(rows[0].proof_hash).toEqual(expect.any(String));

    const context = JSON.parse(rows[0].context_json);
    expect(context).toMatchObject({
      task_id: 'task-capture',
      workflow_id: 'wf-capture',
      action: 'capture_complete',
      host: 'peek-host',
      target: 'Docs',
    });
  });
});
