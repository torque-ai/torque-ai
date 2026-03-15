import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const crypto = require('crypto');
const path = require('path');

const MODULE_PATH = require.resolve('../handlers/peek/artifacts');

let currentModules = {};

vi.mock('fs', () => currentModules.fsModule);
vi.mock('../database', () => currentModules.database);
vi.mock('../contracts/peek', () => currentModules.contracts);
vi.mock('../handlers/peek/shared', () => currentModules.shared);
vi.mock('../handlers/peek/webhook-outbound', () => currentModules.webhookOutbound);
vi.mock('../logger', () => currentModules.logger);

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function loadArtifacts() {
  vi.resetModules();
  vi.doMock('fs', () => currentModules.fsModule);
  vi.doMock('../database', () => currentModules.database);
  vi.doMock('../contracts/peek', () => currentModules.contracts);
  vi.doMock('../handlers/peek/shared', () => currentModules.shared);
  vi.doMock('../handlers/peek/webhook-outbound', () => currentModules.webhookOutbound);
  vi.doMock('../logger', () => currentModules.logger);

  installCjsModuleMock('fs', currentModules.fsModule);
  installCjsModuleMock('../database', currentModules.database);
  installCjsModuleMock('../contracts/peek', currentModules.contracts);
  installCjsModuleMock('../handlers/peek/shared', currentModules.shared);
  installCjsModuleMock('../handlers/peek/webhook-outbound', currentModules.webhookOutbound);
  installCjsModuleMock('../logger', currentModules.logger);

  delete require.cache[MODULE_PATH];
  return require('../handlers/peek/artifacts');
}

function createLoggerMock() {
  const instance = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };

  return {
    instance,
    module: {
      child: vi.fn(() => instance),
    },
  };
}

function cloneContract(contract) {
  if (!contract || typeof contract !== 'object') {
    return null;
  }

  return {
    name: typeof contract.name === 'string' ? contract.name : null,
    version: contract.version ?? null,
    slice: typeof contract.slice === 'string' ? contract.slice : null,
    created_at: typeof contract.created_at === 'string' ? contract.created_at : null,
    persisted: typeof contract.persisted === 'boolean' ? contract.persisted : null,
    signed: typeof contract.signed === 'boolean' ? contract.signed : null,
  };
}

function normalizeReference(ref) {
  if (!ref || typeof ref !== 'object') {
    return null;
  }

  const artifactPath = typeof ref.path === 'string' && ref.path.trim()
    ? ref.path.trim()
    : null;
  if (!artifactPath) {
    return null;
  }

  return {
    source: typeof ref.source === 'string' ? ref.source : 'peek_diagnose',
    kind: typeof ref.kind === 'string' ? ref.kind : null,
    name: typeof ref.name === 'string' && ref.name.trim() ? ref.name.trim() : path.basename(artifactPath),
    path: artifactPath,
    mime_type: typeof ref.mime_type === 'string' ? ref.mime_type : null,
    artifact_id: typeof ref.artifact_id === 'string' ? ref.artifact_id : null,
    task_id: typeof ref.task_id === 'string' ? ref.task_id : null,
    workflow_id: typeof ref.workflow_id === 'string' ? ref.workflow_id : null,
    host: typeof ref.host === 'string' ? ref.host : null,
    target: typeof ref.target === 'string' ? ref.target : null,
    task_label: typeof ref.task_label === 'string' ? ref.task_label : null,
    contract: cloneContract(ref.contract),
  };
}

function mergeRefs(existingRefs, nextRefs) {
  const merged = [];
  const seen = new Set();

  for (const ref of [...(existingRefs || []), ...(nextRefs || [])]) {
    const normalized = normalizeReference(ref);
    if (!normalized) {
      continue;
    }

    const dedupeKey = [
      normalized.kind || '',
      normalized.artifact_id || '',
      normalized.path,
      normalized.task_id || '',
      normalized.workflow_id || '',
    ].join('::');

    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    merged.push(normalized);
  }

  return merged;
}

function attachRefs(container, refs) {
  const base = container && typeof container === 'object' ? { ...container } : {};
  const peek = base.peek && typeof base.peek === 'object' ? { ...base.peek } : {};
  const existingRefs = Array.isArray(peek.bundle_references) ? peek.bundle_references : [];
  peek.bundle_references = mergeRefs(existingRefs, refs);
  base.peek = peek;
  return base;
}

function createContractsMock(overrides = {}) {
  return {
    attachPeekArtifactReferences: vi.fn(attachRefs),
    mergePeekArtifactReferences: vi.fn(mergeRefs),
    normalizePeekArtifactReference: vi.fn(normalizeReference),
    ...overrides,
  };
}

function createSharedMock(overrides = {}) {
  return {
    getTorqueArtifactStorageRoot: vi.fn(() => path.join('C:\\', 'artifacts-root')),
    inferPeekArtifactMimeType: vi.fn((filePath) => {
      switch (path.extname(filePath || '').toLowerCase()) {
        case '.json':
          return 'application/json';
        case '.png':
          return 'image/png';
        case '.txt':
          return 'text/plain';
        default:
          return 'application/octet-stream';
      }
    }),
    sanitizePeekTargetKey: vi.fn((value, fallback) => {
      const normalized = String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      return normalized || fallback;
    }),
    ...overrides,
  };
}

function createFsModule(fileRegistry) {
  return {
    existsSync: vi.fn((artifactPath) => {
      const entry = fileRegistry.get(artifactPath);
      return !!entry && entry.exists !== false;
    }),
    statSync: vi.fn((artifactPath) => {
      const entry = fileRegistry.get(artifactPath);
      if (!entry) {
        throw new Error(`ENOENT: ${artifactPath}`);
      }

      const size = entry.size ?? (entry.buffer ? entry.buffer.length : 0);
      return {
        isFile: () => entry.isFile !== false,
        size,
      };
    }),
    readFileSync: vi.fn((artifactPath) => {
      const entry = fileRegistry.get(artifactPath);
      if (!entry) {
        throw new Error(`ENOENT: ${artifactPath}`);
      }
      return entry.buffer || Buffer.from('', 'utf8');
    }),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
}

function createDatabaseMock(overrides = {}) {
  return {
    storeArtifact: vi.fn((artifact) => ({
      ...artifact,
      created_at: '2026-03-12T18:30:00.000Z',
      expires_at: '2026-04-11T18:30:00.000Z',
    })),
    getWorkflow: vi.fn(() => ({ context: { keep: true } })),
    updateTask: vi.fn(),
    updateWorkflow: vi.fn(),
    formatPolicyProof: vi.fn(),
    recordPolicyProofAudit: vi.fn(),
    ...overrides,
  };
}

function createBundle(overrides = {}) {
  return {
    contract: {
      name: 'peek_investigation_bundle',
      version: 2,
    },
    bundle_version: 2,
    app_type: 'wpf',
    capture_data: {
      screenshot: 'base64-image',
    },
    metadata: {
      title: 'Calculator',
    },
    visual_tree: {
      root: {},
    },
    property_bag: {
      values: [],
    },
    artifacts: {
      persisted: false,
      bundle_path: null,
      artifact_report_path: null,
      signed: false,
    },
    ...overrides,
  };
}

function setupHarness(options = {}) {
  const fileRegistry = new Map();
  const loggerMock = createLoggerMock();
  const database = createDatabaseMock(options.database);
  const contracts = createContractsMock(options.contracts);
  const shared = createSharedMock(options.shared);
  const fsModule = createFsModule(fileRegistry);
  const fireWebhookForEvent = options.fireWebhookForEvent || vi.fn(() => Promise.resolve({ fired: 1 }));

  currentModules = {
    fsModule,
    database,
    contracts,
    shared,
    webhookOutbound: {
      fireWebhookForEvent,
    },
    logger: loggerMock.module,
  };

  const artifacts = loadArtifacts();

  function setFile(filePath, content, overrides = {}) {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    fileRegistry.set(filePath, {
      buffer,
      exists: overrides.exists !== false,
      isFile: overrides.isFile !== false,
      size: overrides.size,
    });
    return filePath;
  }

  return {
    artifacts,
    database,
    contracts,
    shared,
    fsModule,
    fireWebhookForEvent,
    loggerMock,
    setFile,
  };
}

describe('peek/artifacts exported handlers', () => {
  let harness;
  let artifacts;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-12T18:30:00.000Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0.31415926);
    harness = setupHarness();
    artifacts = harness.artifacts;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.resetModules();
    currentModules = {};
    delete require.cache[MODULE_PATH];
    harness = null;
    artifacts = null;
  });

  describe('canonicalizeBundleData', () => {
    it('sorts object keys recursively and omits undefined object properties', () => {
      const result = artifacts.canonicalizeBundleData({
        z: 1,
        nested: {
          b: 2,
          a: 1,
          drop: undefined,
        },
        a: 0,
        remove: undefined,
      });

      expect(Object.keys(result)).toEqual(['a', 'nested', 'z']);
      expect(result).toEqual({
        a: 0,
        nested: {
          a: 1,
          b: 2,
        },
        z: 1,
      });
    });

    it('replaces undefined array items with null while canonicalizing nested values', () => {
      const result = artifacts.canonicalizeBundleData([
        undefined,
        {
          b: 2,
          a: undefined,
          c: [1, undefined],
        },
      ]);

      expect(result).toEqual([
        null,
        {
          b: 2,
          c: [1, null],
        },
      ]);
    });
  });

  describe('generateBundleChecksum', () => {
    it('produces the same checksum for equivalent objects with different key order', () => {
      const left = {
        metadata: {
          title: 'Calc',
          width: 640,
        },
        app_type: 'wpf',
      };
      const right = {
        app_type: 'wpf',
        metadata: {
          width: 640,
          title: 'Calc',
        },
      };

      expect(artifacts.generateBundleChecksum(left)).toBe(artifacts.generateBundleChecksum(right));
    });

    it('normalizes undefined input to the same hash as null', () => {
      expect(artifacts.generateBundleChecksum(undefined)).toBe(artifacts.generateBundleChecksum(null));
    });
  });

  describe('signBundleMetadata', () => {
    it('prefers bundle_version over contract version and includes signer fields', () => {
      const signed = artifacts.signBundleMetadata({
        bundle_version: 9,
        contract: {
          version: 2,
        },
      }, 'checksum-1');

      expect(signed).toEqual({
        bundle_version: 9,
        checksum: 'checksum-1',
        algorithm: 'sha256',
        signed_at: '2026-03-12T18:30:00.000Z',
        signer: 'torque-agent',
      });
    });

    it('falls back to the contract version when bundle_version is absent', () => {
      const signed = artifacts.signBundleMetadata({
        contract: {
          version: 3,
        },
      }, 'checksum-2');

      expect(signed.bundle_version).toBe(3);
      expect(signed.checksum).toBe('checksum-2');
    });
  });

  describe('validateBundleIntegrity', () => {
    it('returns true when the checksum matches direct signed metadata', () => {
      const bundle = createBundle();
      const signed = artifacts.signBundleMetadata(bundle, artifacts.generateBundleChecksum(bundle));

      expect(artifacts.validateBundleIntegrity(bundle, signed)).toBe(true);
    });

    it('accepts signed_metadata envelopes', () => {
      const bundle = createBundle();
      const signed = artifacts.signBundleMetadata(bundle, artifacts.generateBundleChecksum(bundle));

      expect(artifacts.validateBundleIntegrity(bundle, {
        signed_metadata: signed,
      })).toBe(true);
    });

    it('rejects missing checksum, unsupported algorithms, and mismatched bundle data', () => {
      const bundle = createBundle();
      const checksum = artifacts.generateBundleChecksum(bundle);

      expect(artifacts.validateBundleIntegrity(bundle, {
        checksum,
        algorithm: 'md5',
      })).toBe(false);
      expect(artifacts.validateBundleIntegrity(bundle, {
        checksum: '   ',
        algorithm: 'sha256',
      })).toBe(false);
      expect(artifacts.validateBundleIntegrity({
        ...bundle,
        metadata: {
          title: 'Changed',
        },
      }, {
        checksum,
        algorithm: 'sha256',
      })).toBe(false);
    });
  });

  describe('attachPeekArtifactReferences', () => {
    it('delegates to the contract helper and returns the attached reference container', () => {
      const result = artifacts.attachPeekArtifactReferences({
        existing: true,
      }, [{
        kind: 'bundle_json',
        path: 'C:\\artifacts\\bundle.json',
      }]);

      expect(harness.contracts.attachPeekArtifactReferences).toHaveBeenCalledWith({
        existing: true,
      }, [{
        kind: 'bundle_json',
        path: 'C:\\artifacts\\bundle.json',
      }]);
      expect(result.peek.bundle_references).toEqual([
        expect.objectContaining({
          kind: 'bundle_json',
          path: 'C:\\artifacts\\bundle.json',
        }),
      ]);
    });
  });

  describe('hasPeekEvidenceValue', () => {
    it('returns false for nullish, blank, and empty container values', () => {
      expect(artifacts.hasPeekEvidenceValue(null)).toBe(false);
      expect(artifacts.hasPeekEvidenceValue(undefined)).toBe(false);
      expect(artifacts.hasPeekEvidenceValue('   ')).toBe(false);
      expect(artifacts.hasPeekEvidenceValue([])).toBe(false);
      expect(artifacts.hasPeekEvidenceValue({})).toBe(false);
    });

    it('returns true for non-empty values including false and zero', () => {
      expect(artifacts.hasPeekEvidenceValue(false)).toBe(true);
      expect(artifacts.hasPeekEvidenceValue(0)).toBe(true);
      expect(artifacts.hasPeekEvidenceValue(['x'])).toBe(true);
      expect(artifacts.hasPeekEvidenceValue({
        value: true,
      })).toBe(true);
    });
  });

  describe('getPeekSnapshotEvidenceFields', () => {
    it('returns app-specific snapshot field requirements for wpf bundles', () => {
      expect(artifacts.getPeekSnapshotEvidenceFields({
        app_type: 'wpf',
      })).toEqual(['visual_tree', 'property_bag']);
    });

    it('falls back to the full snapshot field set for unknown app types', () => {
      expect(artifacts.getPeekSnapshotEvidenceFields({
        app_type: 'unknown',
      })).toEqual([
        'visual_tree',
        'property_bag',
        'hwnd_metadata',
        'class_name_chain',
        'devtools_protocol',
        'dom_snapshot',
      ]);
    });
  });

  describe('getPeekPrimarySnapshotField', () => {
    it('returns dom_snapshot for electron bundles', () => {
      expect(artifacts.getPeekPrimarySnapshotField({
        app_type: 'electron',
      })).toBe('dom_snapshot');
    });

    it('returns null for unsupported app types', () => {
      expect(artifacts.getPeekPrimarySnapshotField({
        app_type: 'qt',
      })).toBeNull();
      expect(artifacts.getPeekPrimarySnapshotField(null)).toBeNull();
    });
  });

  describe('isPeekRichEvidenceBundle', () => {
    it('detects rich bundles when app_type or snapshot fields are present', () => {
      expect(artifacts.isPeekRichEvidenceBundle({
        app_type: 'win32',
      })).toBe(true);
      expect(artifacts.isPeekRichEvidenceBundle({
        dom_snapshot: {
          root: {},
        },
      })).toBe(true);
    });

    it('returns false for non-objects and unrelated plain objects', () => {
      expect(artifacts.isPeekRichEvidenceBundle('bundle')).toBe(false);
      expect(artifacts.isPeekRichEvidenceBundle({
        arbitrary: true,
      })).toBe(false);
    });
  });

  describe('classifyEvidenceSufficiency', () => {
    it('marks complete rich bundles as sufficient', () => {
      expect(artifacts.classifyEvidenceSufficiency(createBundle())).toEqual({
        sufficient: true,
      });
    });

    it('requires the primary snapshot field for app-specific rich bundles', () => {
      const result = artifacts.classifyEvidenceSufficiency(createBundle({
        visual_tree: null,
      }));

      expect(result).toEqual({
        sufficient: false,
        missing: ['visual_tree'],
        confidence: 'low',
      });
    });

    it('reports missing capture, metadata, and tree evidence for legacy bundles', () => {
      const result = artifacts.classifyEvidenceSufficiency({
        evidence: {
          screenshot: null,
          elements: {
            tree: null,
          },
        },
        runtime: null,
        target: null,
      });

      expect(result).toEqual({
        sufficient: false,
        missing: ['capture_data', 'metadata', 'visual_tree'],
        confidence: 'low',
      });
    });

    it('requires dom_snapshot for electron bundles when no snapshot evidence is present', () => {
      const result = artifacts.classifyEvidenceSufficiency({
        app_type: 'electron',
        capture_data: {
          screenshot: 'base64',
        },
        metadata: {
          title: 'Docs',
        },
        dom_snapshot: null,
        devtools_protocol: null,
      });

      expect(result).toEqual({
        sufficient: false,
        missing: ['dom_snapshot', 'devtools_protocol'],
        confidence: 'low',
      });
    });
  });

  describe('applyEvidenceStateToBundle', () => {
    it('sets complete state and clears missing fields when evidence is sufficient', () => {
      const bundle = {};

      const result = artifacts.applyEvidenceStateToBundle(bundle, {
        sufficient: true,
      });

      expect(result).toBe(bundle);
      expect(bundle).toEqual({
        evidence_state: 'complete',
        evidence_sufficiency: {
          sufficient: true,
        },
        missing_evidence_fields: [],
      });
    });

    it('copies missing fields and confidence when evidence is insufficient', () => {
      const bundle = {};

      artifacts.applyEvidenceStateToBundle(bundle, {
        sufficient: false,
        missing: ['metadata', 'visual_tree'],
        confidence: 'medium',
      });

      expect(bundle).toEqual({
        evidence_state: 'insufficient',
        evidence_sufficiency: {
          sufficient: false,
          missing: ['metadata', 'visual_tree'],
          confidence: 'medium',
        },
        missing_evidence_fields: ['metadata', 'visual_tree'],
      });
    });

    it('returns non-object inputs unchanged', () => {
      expect(artifacts.applyEvidenceStateToBundle(null, {
        sufficient: true,
      })).toBeNull();
      expect(artifacts.applyEvidenceStateToBundle('bundle', {
        sufficient: true,
      })).toBe('bundle');
    });
  });

  describe('buildPeekFallbackPersistOutputDir', () => {
    it('builds a process-scoped adhoc output path under the artifact root', () => {
      const outputDir = artifacts.buildPeekFallbackPersistOutputDir({
        process: 'My App.exe',
      });

      expect(outputDir).toBe(path.join(
        'C:\\',
        'artifacts-root',
        '_adhoc',
        'peek-diagnose',
        `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        'my-app-exe',
      ));
      expect(harness.fsModule.mkdirSync).toHaveBeenCalledWith(outputDir, {
        recursive: true,
      });
    });

    it('uses the title when process is absent', () => {
      artifacts.buildPeekFallbackPersistOutputDir({
        title: 'Diagnostics Window',
      });

      expect(harness.shared.sanitizePeekTargetKey).toHaveBeenCalledWith('Diagnostics Window', 'peek-diagnose');
    });

    it('falls back to the default window target key', () => {
      artifacts.buildPeekFallbackPersistOutputDir({});

      expect(harness.shared.sanitizePeekTargetKey).toHaveBeenCalledWith('window', 'peek-diagnose');
    });
  });

  describe('ensurePeekBundlePersistence', () => {
    it('returns null for non-object bundle data', () => {
      expect(artifacts.ensurePeekBundlePersistence(null, 'C:\\persist')).toBeNull();
      expect(artifacts.ensurePeekBundlePersistence('bundle', 'C:\\persist')).toBeNull();
    });

    it('returns null when no persistence trigger is present', () => {
      const result = artifacts.ensurePeekBundlePersistence({
        evidence_state: 'complete',
      }, null);

      expect(result).toBeNull();
      expect(harness.fsModule.writeFileSync).not.toHaveBeenCalled();
    });

    it('persists insufficient bundles to the provided output directory and initializes artifacts metadata', () => {
      const bundle = {
        evidence_state: 'insufficient',
      };

      const bundlePath = artifacts.ensurePeekBundlePersistence(bundle, 'C:\\persist\\task-output');

      expect(bundlePath).toBe(path.join('C:\\persist\\task-output', 'bundle.json'));
      expect(bundle.artifacts).toEqual({
        persisted: true,
        bundle_path: path.join('C:\\persist\\task-output', 'bundle.json'),
        artifact_report_path: null,
        signed: false,
      });
      expect(harness.fsModule.mkdirSync).toHaveBeenCalledWith(path.dirname(bundlePath), {
        recursive: true,
      });
      expect(harness.fsModule.writeFileSync).toHaveBeenCalledWith(
        bundlePath,
        JSON.stringify(bundle, null, 2),
        'utf8',
      );
    });

    it('reuses an existing bundle_path and preserves valid artifact metadata fields', () => {
      const bundle = {
        artifacts: {
          persisted: false,
          bundle_path: 'C:\\persist\\existing\\bundle.json',
          artifact_report_path: 'C:\\persist\\existing\\artifact-report.json',
          signed: true,
        },
      };

      const bundlePath = artifacts.ensurePeekBundlePersistence(bundle, 'C:\\ignored');

      expect(bundlePath).toBe('C:\\persist\\existing\\bundle.json');
      expect(bundle.artifacts).toEqual({
        persisted: true,
        bundle_path: 'C:\\persist\\existing\\bundle.json',
        artifact_report_path: 'C:\\persist\\existing\\artifact-report.json',
        signed: true,
      });
    });

    it('preserves truthy artifact_report_path values and resets non-boolean signed flags', () => {
      const bundle = {
        evidence_state: 'insufficient',
        artifacts: {
          bundle_path: '',
          artifact_report_path: 42,
          signed: 'yes',
        },
      };

      artifacts.ensurePeekBundlePersistence(bundle, 'C:\\persist\\normalize');

      expect(bundle.artifacts.artifact_report_path).toBe(42);
      expect(bundle.artifacts.signed).toBe(false);
    });

    it('creates a fallback output directory when outputDir is absent but persistence is required', () => {
      const bundlePath = artifacts.ensurePeekBundlePersistence({
        evidence_state: 'insufficient',
      }, null, {
        process: 'calc.exe',
      });

      expect(harness.shared.getTorqueArtifactStorageRoot).toHaveBeenCalledTimes(1);
      expect(bundlePath).toContain(path.join('_adhoc', 'peek-diagnose'));
    });
  });

  describe('storePeekArtifactsForTask', () => {
    it('returns an empty array when refs is null or empty', () => {
      expect(artifacts.storePeekArtifactsForTask('task-empty', null)).toEqual([]);
      expect(artifacts.storePeekArtifactsForTask('task-empty', [])).toEqual([]);
      expect(harness.database.storeArtifact).not.toHaveBeenCalled();
    });

    it('skips refs that normalize to null', () => {
      harness.contracts.normalizePeekArtifactReference.mockReturnValueOnce(null);

      const result = artifacts.storePeekArtifactsForTask('task-null-ref', [{
        kind: 'bundle_json',
      }]);

      expect(result).toEqual([]);
      expect(harness.database.storeArtifact).not.toHaveBeenCalled();
    });

    it('logs and skips refs whose file path no longer exists', () => {
      const result = artifacts.storePeekArtifactsForTask('task-missing-file', [{
        kind: 'bundle_json',
        path: 'C:\\missing\\bundle.json',
      }]);

      expect(result).toEqual([]);
      expect(harness.loggerMock.instance.info).toHaveBeenCalledWith(
        expect.stringContaining('persisted artifact missing for task task-missing-file'),
      );
    });

    it('skips refs whose persisted path is not a file', () => {
      harness.setFile('C:\\artifacts\\dir-entry', '', {
        isFile: false,
      });

      const result = artifacts.storePeekArtifactsForTask('task-dir', [{
        kind: 'artifact_report',
        path: 'C:\\artifacts\\dir-entry',
      }]);

      expect(result).toEqual([]);
      expect(harness.database.storeArtifact).not.toHaveBeenCalled();
    });

    it('stores artifact metadata, checksum, and context for non-bundle artifacts', () => {
      vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce('artifact-image');
      const buffer = Buffer.from('png-bytes');
      harness.setFile('C:\\artifacts\\capture.png', buffer);

      const result = artifacts.storePeekArtifactsForTask('task-image', [{
        kind: 'screenshot',
        name: 'capture.png',
        path: 'C:\\artifacts\\capture.png',
        host: 'peek-host',
        target: 'Calculator',
      }], {
        workflowId: 'wf-image',
        taskLabel: 'peek-capture',
      });

      expect(harness.database.storeArtifact).toHaveBeenCalledWith(expect.objectContaining({
        id: 'artifact-image',
        task_id: 'task-image',
        name: 'capture.png',
        file_path: 'C:\\artifacts\\capture.png',
        mime_type: 'image/png',
        size_bytes: buffer.length,
        checksum: crypto.createHash('sha256').update(buffer).digest('hex'),
        metadata: expect.objectContaining({
          source: 'peek_diagnose',
          kind: 'screenshot',
          host: 'peek-host',
          target: 'Calculator',
          workflow_id: 'wf-image',
          task_label: 'peek-capture',
          evidence_state: null,
          missing_evidence_fields: [],
          evidence_sufficiency: null,
        }),
      }));
      expect(result).toEqual([
        expect.objectContaining({
          artifact_id: 'artifact-image',
          task_id: 'task-image',
          workflow_id: 'wf-image',
          task_label: 'peek-capture',
          mime_type: 'image/png',
        }),
      ]);
    });

    it('uses workflow_id and task_label from the normalized ref when context does not override them', () => {
      vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce('artifact-ref-context');
      harness.setFile('C:\\artifacts\\report.txt', 'report');

      const result = artifacts.storePeekArtifactsForTask('task-ref-context', [{
        kind: 'artifact_report',
        path: 'C:\\artifacts\\report.txt',
        workflow_id: 'wf-from-ref',
        task_label: 'ref-label',
      }]);

      expect(harness.database.storeArtifact.mock.calls[0][0].metadata).toEqual(expect.objectContaining({
        workflow_id: 'wf-from-ref',
        task_label: 'ref-label',
      }));
      expect(result[0]).toEqual(expect.objectContaining({
        workflow_id: 'wf-from-ref',
        task_label: 'ref-label',
      }));
    });

    it('stores signed bundle metadata and preserves explicit evidence state fields from the bundle', () => {
      vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce('artifact-bundle-explicit');
      const bundle = createBundle({
        evidence_state: 'review-required',
        evidence_sufficiency: {
          sufficient: false,
          missing: ['dom_snapshot'],
          confidence: 'medium',
        },
        missing_evidence_fields: ['dom_snapshot'],
      });
      harness.setFile('C:\\artifacts\\bundle-explicit.json', JSON.stringify(bundle, null, 2));

      const result = artifacts.storePeekArtifactsForTask('task-bundle-explicit', [{
        kind: 'bundle_json',
        path: 'C:\\artifacts\\bundle-explicit.json',
        contract: {
          name: bundle.contract.name,
          version: bundle.contract.version,
        },
      }]);

      const stored = harness.database.storeArtifact.mock.calls[0][0];
      expect(stored.metadata).toEqual(expect.objectContaining({
        evidence_state: 'review-required',
        missing_evidence_fields: ['dom_snapshot'],
        evidence_sufficiency: {
          sufficient: false,
          missing: ['dom_snapshot'],
          confidence: 'medium',
        },
        signed_metadata: expect.objectContaining({
          bundle_version: 2,
          algorithm: 'sha256',
          signer: 'torque-agent',
          checksum: artifacts.generateBundleChecksum(bundle),
        }),
        integrity: {
          valid: true,
        },
      }));
      expect(result[0]).toEqual(expect.objectContaining({
        artifact_id: 'artifact-bundle-explicit',
        kind: 'bundle_json',
      }));
    });

    it('classifies evidence sufficiency for bundle_json artifacts when the bundle omits explicit metadata', () => {
      vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce('artifact-bundle-inferred');
      const bundle = createBundle({
        metadata: null,
        visual_tree: null,
      });
      delete bundle.evidence_state;
      delete bundle.evidence_sufficiency;
      delete bundle.missing_evidence_fields;
      harness.setFile('C:\\artifacts\\bundle-inferred.json', JSON.stringify(bundle, null, 2));

      artifacts.storePeekArtifactsForTask('task-bundle-inferred', [{
        kind: 'bundle_json',
        path: 'C:\\artifacts\\bundle-inferred.json',
      }]);

      expect(harness.database.storeArtifact.mock.calls[0][0].metadata).toEqual(expect.objectContaining({
        evidence_state: 'insufficient',
        missing_evidence_fields: ['metadata', 'visual_tree'],
        evidence_sufficiency: {
          sufficient: false,
          missing: ['metadata', 'visual_tree'],
          confidence: 'low',
        },
        integrity: {
          valid: true,
        },
      }));
    });

    it('logs bundle signing failures for invalid JSON and still stores the artifact record', () => {
      vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce('artifact-bad-json');
      harness.setFile('C:\\artifacts\\bundle-bad.json', '{not-json');

      const result = artifacts.storePeekArtifactsForTask('task-bad-json', [{
        kind: 'bundle_json',
        path: 'C:\\artifacts\\bundle-bad.json',
      }]);

      const stored = harness.database.storeArtifact.mock.calls[0][0];
      expect(stored.metadata.signed_metadata).toBeUndefined();
      expect(stored.metadata.integrity).toBeUndefined();
      expect(stored.metadata.evidence_state).toBeNull();
      expect(harness.loggerMock.instance.info).toHaveBeenCalledWith(
        expect.stringContaining('bundle signing failed for task task-bad-json'),
      );
      expect(result).toHaveLength(1);
    });

    it('records policy proof audits with formatPolicyProof when artifacts are stored', () => {
      vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce('artifact-proof-format');
      harness.setFile('C:\\artifacts\\capture-proof.png', Buffer.from('proof-bytes'));
      const proof = {
        mode: 'advisory',
        warned: 1,
      };

      artifacts.storePeekArtifactsForTask('task-proof-format', [{
        kind: 'screenshot',
        path: 'C:\\artifacts\\capture-proof.png',
      }], {
        workflowId: 'wf-proof-format',
        policyProof: proof,
      });

      expect(harness.database.formatPolicyProof).toHaveBeenCalledWith({
        surface: 'artifact_persistence',
        policy_family: 'peek',
        proof,
        context: {
          task_id: 'task-proof-format',
          workflow_id: 'wf-proof-format',
          action: 'store_artifacts',
          artifact_count: 1,
        },
      });
      expect(harness.database.recordPolicyProofAudit).not.toHaveBeenCalled();
    });

    it('falls back to recordPolicyProofAudit when formatPolicyProof is unavailable', () => {
      harness = setupHarness({
        database: {
          formatPolicyProof: undefined,
          recordPolicyProofAudit: vi.fn(),
        },
      });
      artifacts = harness.artifacts;
      vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce('artifact-proof-record');
      harness.setFile('C:\\artifacts\\capture-proof-record.png', Buffer.from('proof-record'));

      artifacts.storePeekArtifactsForTask('task-proof-record', [{
        kind: 'screenshot',
        path: 'C:\\artifacts\\capture-proof-record.png',
      }], {
        workflowId: 'wf-proof-record',
        policyProof: {
          blocked: 0,
        },
      });

      expect(harness.database.recordPolicyProofAudit).toHaveBeenCalledWith(expect.objectContaining({
        surface: 'artifact_persistence',
        policy_family: 'peek',
      }));
    });

    it('logs policy proof audit failures without failing artifact storage', () => {
      harness = setupHarness({
        database: {
          formatPolicyProof: vi.fn(() => {
            throw new Error('audit sink unavailable');
          }),
        },
      });
      artifacts = harness.artifacts;
      vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce('artifact-proof-warn');
      harness.setFile('C:\\artifacts\\capture-proof-warn.png', Buffer.from('proof-warn'));

      const result = artifacts.storePeekArtifactsForTask('task-proof-warn', [{
        kind: 'screenshot',
        path: 'C:\\artifacts\\capture-proof-warn.png',
      }], {
        policyProof: {
          failed: 1,
        },
      });

      expect(result).toHaveLength(1);
      expect(harness.loggerMock.instance.warn).toHaveBeenCalledWith(
        'Policy proof audit recording failed: audit sink unavailable',
      );
    });

    it('fires a webhook once when at least one bundle artifact is persisted among multiple refs', async () => {
      vi.spyOn(crypto, 'randomUUID')
        .mockReturnValueOnce('artifact-bundle')
        .mockReturnValueOnce('artifact-report');
      harness.setFile('C:\\artifacts\\bundle-webhook.json', JSON.stringify(createBundle(), null, 2));
      harness.setFile('C:\\artifacts\\artifact-report.json', JSON.stringify({
        summary: 'ok',
      }, null, 2));

      const result = artifacts.storePeekArtifactsForTask('task-webhook', [{
        kind: 'bundle_json',
        path: 'C:\\artifacts\\bundle-webhook.json',
      }, {
        kind: 'artifact_report',
        path: 'C:\\artifacts\\artifact-report.json',
      }]);
      await Promise.resolve();

      expect(harness.database.storeArtifact).toHaveBeenCalledTimes(2);
      expect(harness.contracts.mergePeekArtifactReferences).toHaveBeenCalledWith([], expect.arrayContaining([
        expect.objectContaining({
          kind: 'bundle_json',
          artifact_id: 'artifact-bundle',
        }),
        expect.objectContaining({
          kind: 'artifact_report',
          artifact_id: 'artifact-report',
        }),
      ]));
      expect(harness.fireWebhookForEvent).toHaveBeenCalledWith('peek.bundle.created', {
        task_id: 'task-webhook',
      });
      expect(result).toHaveLength(2);
    });

    it('does not fire bundle webhooks when only non-bundle artifacts are stored', () => {
      vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce('artifact-no-webhook');
      harness.setFile('C:\\artifacts\\note.txt', 'hello');

      artifacts.storePeekArtifactsForTask('task-no-webhook', [{
        kind: 'artifact_report',
        path: 'C:\\artifacts\\note.txt',
      }]);

      expect(harness.fireWebhookForEvent).not.toHaveBeenCalled();
    });
  });

  describe('persistPeekResultReferences', () => {
    it('returns an empty array when merging yields no refs', () => {
      expect(artifacts.persistPeekResultReferences({}, null)).toEqual([]);
      expect(harness.database.updateTask).not.toHaveBeenCalled();
      expect(harness.database.updateWorkflow).not.toHaveBeenCalled();
    });

    it('stores artifacts and attaches bundle references to task metadata', () => {
      vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce('artifact-persist-task');
      harness.setFile('C:\\artifacts\\persist-task.png', Buffer.from('persist-task'));

      const result = artifacts.persistPeekResultReferences({
        taskId: 'task-persist',
        task: {
          metadata: {
            owner: 'operator',
          },
        },
        workflowId: null,
      }, [{
        kind: 'screenshot',
        path: 'C:\\artifacts\\persist-task.png',
      }]);

      expect(harness.database.updateTask).toHaveBeenCalledWith('task-persist', {
        metadata: expect.objectContaining({
          owner: 'operator',
          peek: {
            bundle_references: [
              expect.objectContaining({
                artifact_id: 'artifact-persist-task',
                task_id: 'task-persist',
              }),
            ],
          },
        }),
      });
      expect(result).toEqual([
        expect.objectContaining({
          artifact_id: 'artifact-persist-task',
          task_id: 'task-persist',
        }),
      ]);
    });

    it('updates workflow context with normalized refs when only workflowId is present', () => {
      artifacts.persistPeekResultReferences({
        workflowId: 'wf-persist',
      }, [{
        kind: 'screenshot',
        path: 'C:\\artifacts\\persist-workflow.png',
      }]);

      expect(harness.database.getWorkflow).toHaveBeenCalledWith('wf-persist');
      expect(harness.database.updateWorkflow).toHaveBeenCalledWith('wf-persist', {
        context: expect.objectContaining({
          keep: true,
          peek: {
            bundle_references: [
              expect.objectContaining({
                artifact_id: null,
                workflow_id: null,
                path: 'C:\\artifacts\\persist-workflow.png',
              }),
            ],
          },
        }),
      });
    });

    it('skips workflow updates when the workflow lookup returns null', () => {
      harness = setupHarness({
        database: {
          getWorkflow: vi.fn(() => null),
        },
      });
      artifacts = harness.artifacts;
      harness.setFile('C:\\artifacts\\persist-skip.png', Buffer.from('persist-skip'));
      vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce('artifact-persist-skip');

      const result = artifacts.persistPeekResultReferences({
        workflowId: 'wf-missing',
      }, [{
        kind: 'screenshot',
        path: 'C:\\artifacts\\persist-skip.png',
      }]);

      expect(harness.database.updateWorkflow).not.toHaveBeenCalled();
      expect(result).toEqual([
        expect.objectContaining({
          artifact_id: null,
          workflow_id: null,
          path: 'C:\\artifacts\\persist-skip.png',
        }),
      ]);
    });

    it('logs task persistence failures and returns the normalized refs', () => {
      harness = setupHarness({
        database: {
          storeArtifact: vi.fn(() => {
            throw new Error('store failed');
          }),
        },
      });
      artifacts = harness.artifacts;
      harness.setFile('C:\\artifacts\\task-fail.png', Buffer.from('task-fail'));

      const result = artifacts.persistPeekResultReferences({
        taskId: 'task-fail',
      }, [{
        kind: 'screenshot',
        path: 'C:\\artifacts\\task-fail.png',
      }]);

      expect(result).toEqual([
        expect.objectContaining({
          kind: 'screenshot',
          path: 'C:\\artifacts\\task-fail.png',
          task_id: null,
        }),
      ]);
      expect(harness.database.updateTask).not.toHaveBeenCalled();
      expect(harness.loggerMock.instance.info).toHaveBeenCalledWith(
        '[peek-artifacts] task artifact persistence failed for task-fail: store failed',
      );
    });

    it('logs workflow persistence failures without discarding stored task refs', () => {
      harness = setupHarness({
        database: {
          getWorkflow: vi.fn(() => {
            throw new Error('workflow unavailable');
          }),
        },
      });
      artifacts = harness.artifacts;
      vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce('artifact-task-then-workflow');
      harness.setFile('C:\\artifacts\\task-then-workflow.png', Buffer.from('task-then-workflow'));

      const result = artifacts.persistPeekResultReferences({
        taskId: 'task-then-workflow',
        task: {
          metadata: {},
        },
        workflowId: 'wf-then-fail',
      }, [{
        kind: 'screenshot',
        path: 'C:\\artifacts\\task-then-workflow.png',
      }]);

      expect(harness.database.updateTask).toHaveBeenCalledTimes(1);
      expect(result).toEqual([
        expect.objectContaining({
          artifact_id: 'artifact-task-then-workflow',
          task_id: 'task-then-workflow',
          workflow_id: 'wf-then-fail',
        }),
      ]);
      expect(harness.loggerMock.instance.info).toHaveBeenCalledWith(
        '[peek-artifacts] workflow artifact persistence failed for wf-then-fail: workflow unavailable',
      );
    });
  });
});
