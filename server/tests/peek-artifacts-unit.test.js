'use strict';

// --- Mocks injected via require.cache ---
const fsMock = {
  existsSync: vi.fn(() => true),
  statSync: vi.fn(() => ({ isFile: () => true, size: 256 })),
  readFileSync: vi.fn(() => Buffer.from('{}', 'utf8')),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
};

const dbMock = {
  storeArtifact: vi.fn((artifact) => ({
    ...artifact,
    created_at: '2026-03-11T00:00:00.000Z',
    expires_at: '2026-04-10T00:00:00.000Z',
  })),
  getWorkflow: vi.fn(() => ({ context: {} })),
  formatPolicyProof: vi.fn(),
  recordPolicyProofAudit: vi.fn(),
  updateTask: vi.fn(),
  updateWorkflow: vi.fn(),
};

const contractsMock = {
  attachPeekArtifactReferences: vi.fn((container, refs) => ({
    ...(container || {}),
    peek_bundle_artifacts: refs,
  })),
  mergePeekArtifactReferences: vi.fn((existing, newRefs) => [...(existing || []), ...(newRefs || [])]),
  normalizePeekArtifactReference: vi.fn((ref) => ref),
};

const sharedMock = {
  getTorqueArtifactStorageRoot: vi.fn(() => '/tmp/torque-artifacts'),
  inferPeekArtifactMimeType: vi.fn(() => 'application/json'),
  sanitizePeekTargetKey: vi.fn((val) => val.replace(/[^a-zA-Z0-9_-]/g, '_')),
};

const mockLoggerInstance = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
const loggerMock = { child: vi.fn(() => mockLoggerInstance) };

const path = require('path');

function installMock(modPath, mock) {
  const resolved = require.resolve(modPath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: mock,
  };
}

// Resolve relative paths from artifacts.js location (server/handlers/peek/)
const artifactsDir = path.resolve(__dirname, '..', 'handlers', 'peek');

function installMockFrom(dir, relPath, mock) {
  const resolved = require.resolve(path.resolve(dir, relPath));
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: mock,
  };
}

installMock('fs', fsMock);
installMockFrom(artifactsDir, '../../database', dbMock);
installMockFrom(artifactsDir, '../../db/task-core', dbMock);
installMockFrom(artifactsDir, '../../db/task-metadata', dbMock);
installMockFrom(artifactsDir, '../../db/workflow-engine', dbMock);
installMockFrom(artifactsDir, '../../db/peek-policy-audit', dbMock);
installMockFrom(artifactsDir, '../../contracts/peek', contractsMock);
installMockFrom(artifactsDir, './shared', sharedMock);
installMockFrom(artifactsDir, '../../logger', loggerMock);

const artifacts = require('../plugins/snapscope/handlers/artifacts');

describe('peek/artifacts — unit tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMock.existsSync.mockReturnValue(true);
    fsMock.statSync.mockReturnValue({ isFile: () => true, size: 256 });
    fsMock.readFileSync.mockReturnValue(Buffer.from('{}', 'utf8'));
    contractsMock.normalizePeekArtifactReference.mockImplementation((ref) => ref);
    contractsMock.mergePeekArtifactReferences.mockImplementation((existing, newRefs) => [
      ...(existing || []),
      ...(newRefs || []),
    ]);
    contractsMock.attachPeekArtifactReferences.mockImplementation((container, refs) => ({
      ...(container || {}),
      peek_bundle_artifacts: refs,
    }));
  });

  // --- canonicalizeBundleData ---

  describe('canonicalizeBundleData', () => {
    it('sorts object keys alphabetically', () => {
      const input = { z: 1, a: 2, m: 3 };
      const result = artifacts.canonicalizeBundleData(input);
      expect(Object.keys(result)).toEqual(['a', 'm', 'z']);
    });

    it('sorts nested objects recursively', () => {
      const input = { b: { z: 1, a: 2 }, a: 1 };
      const result = artifacts.canonicalizeBundleData(input);
      expect(Object.keys(result)).toEqual(['a', 'b']);
      expect(Object.keys(result.b)).toEqual(['a', 'z']);
    });

    it('handles arrays preserving order', () => {
      const result = artifacts.canonicalizeBundleData([3, 1, 2]);
      expect(result).toEqual([3, 1, 2]);
    });

    it('replaces undefined values in arrays with null', () => {
      const result = artifacts.canonicalizeBundleData([1, undefined, 3]);
      expect(result).toEqual([1, null, 3]);
    });

    it('omits undefined object properties', () => {
      const result = artifacts.canonicalizeBundleData({ a: 1, b: undefined });
      expect(result).toEqual({ a: 1 });
      expect('b' in result).toBe(false);
    });

    it('passes through primitives unchanged', () => {
      expect(artifacts.canonicalizeBundleData('hello')).toBe('hello');
      expect(artifacts.canonicalizeBundleData(42)).toBe(42);
      expect(artifacts.canonicalizeBundleData(null)).toBe(null);
      expect(artifacts.canonicalizeBundleData(true)).toBe(true);
    });
  });

  // --- hasPeekEvidenceValue ---

  describe('hasPeekEvidenceValue', () => {
    it('returns false for null/undefined', () => {
      expect(artifacts.hasPeekEvidenceValue(null)).toBe(false);
      expect(artifacts.hasPeekEvidenceValue(undefined)).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(artifacts.hasPeekEvidenceValue('')).toBe(false);
      expect(artifacts.hasPeekEvidenceValue('   ')).toBe(false);
    });

    it('returns true for non-empty string', () => {
      expect(artifacts.hasPeekEvidenceValue('data')).toBe(true);
    });

    it('returns false for empty array', () => {
      expect(artifacts.hasPeekEvidenceValue([])).toBe(false);
    });

    it('returns true for non-empty array', () => {
      expect(artifacts.hasPeekEvidenceValue([1])).toBe(true);
    });

    it('returns false for empty object', () => {
      expect(artifacts.hasPeekEvidenceValue({})).toBe(false);
    });

    it('returns true for non-empty object', () => {
      expect(artifacts.hasPeekEvidenceValue({ x: 1 })).toBe(true);
    });

    it('returns true for numbers and booleans', () => {
      expect(artifacts.hasPeekEvidenceValue(0)).toBe(true);
      expect(artifacts.hasPeekEvidenceValue(false)).toBe(true);
    });
  });

  // --- getPeekSnapshotEvidenceFields ---

  describe('getPeekSnapshotEvidenceFields', () => {
    it('returns visual_tree + property_bag for WPF', () => {
      expect(artifacts.getPeekSnapshotEvidenceFields({ app_type: 'wpf' }))
        .toEqual(['visual_tree', 'property_bag']);
    });

    it('returns hwnd_metadata + class_name_chain for win32', () => {
      expect(artifacts.getPeekSnapshotEvidenceFields({ app_type: 'win32' }))
        .toEqual(['hwnd_metadata', 'class_name_chain']);
    });

    it('returns devtools_protocol + dom_snapshot for electron', () => {
      expect(artifacts.getPeekSnapshotEvidenceFields({ app_type: 'electron' }))
        .toEqual(['devtools_protocol', 'dom_snapshot']);
    });

    it('returns devtools_protocol + dom_snapshot for electron_webview', () => {
      expect(artifacts.getPeekSnapshotEvidenceFields({ app_type: 'electron_webview' }))
        .toEqual(['devtools_protocol', 'dom_snapshot']);
    });

    it('returns all fields for unknown app_type', () => {
      const fields = artifacts.getPeekSnapshotEvidenceFields({ app_type: 'unknown' });
      expect(fields).toContain('visual_tree');
      expect(fields).toContain('property_bag');
      expect(fields).toContain('hwnd_metadata');
      expect(fields).toContain('dom_snapshot');
      expect(fields.length).toBe(6);
    });

    it('returns all fields when no app_type', () => {
      expect(artifacts.getPeekSnapshotEvidenceFields({})).toHaveLength(6);
      expect(artifacts.getPeekSnapshotEvidenceFields(null)).toHaveLength(6);
    });
  });

  // --- getPeekPrimarySnapshotField ---

  describe('getPeekPrimarySnapshotField', () => {
    it('returns visual_tree for wpf', () => {
      expect(artifacts.getPeekPrimarySnapshotField({ app_type: 'wpf' })).toBe('visual_tree');
    });

    it('returns class_name_chain for win32', () => {
      expect(artifacts.getPeekPrimarySnapshotField({ app_type: 'win32' })).toBe('class_name_chain');
    });

    it('returns dom_snapshot for electron', () => {
      expect(artifacts.getPeekPrimarySnapshotField({ app_type: 'electron' })).toBe('dom_snapshot');
    });

    it('returns dom_snapshot for electron_webview', () => {
      expect(artifacts.getPeekPrimarySnapshotField({ app_type: 'electron_webview' })).toBe('dom_snapshot');
    });

    it('returns null for unknown app_type', () => {
      expect(artifacts.getPeekPrimarySnapshotField({ app_type: 'qt' })).toBeNull();
      expect(artifacts.getPeekPrimarySnapshotField({})).toBeNull();
      expect(artifacts.getPeekPrimarySnapshotField(null)).toBeNull();
    });
  });

  // --- isPeekRichEvidenceBundle ---

  describe('isPeekRichEvidenceBundle', () => {
    it('returns false for null/non-object', () => {
      expect(artifacts.isPeekRichEvidenceBundle(null)).toBe(false);
      expect(artifacts.isPeekRichEvidenceBundle('string')).toBe(false);
      expect(artifacts.isPeekRichEvidenceBundle(42)).toBe(false);
    });

    it('returns true when app_type is present', () => {
      expect(artifacts.isPeekRichEvidenceBundle({ app_type: 'wpf' })).toBe(true);
    });

    it('returns true when capture_data is present', () => {
      expect(artifacts.isPeekRichEvidenceBundle({ capture_data: {} })).toBe(true);
    });

    it('returns true when metadata is present', () => {
      expect(artifacts.isPeekRichEvidenceBundle({ metadata: {} })).toBe(true);
    });

    it('returns true when snapshot fields are present', () => {
      expect(artifacts.isPeekRichEvidenceBundle({ visual_tree: {} })).toBe(true);
      expect(artifacts.isPeekRichEvidenceBundle({ dom_snapshot: {} })).toBe(true);
      expect(artifacts.isPeekRichEvidenceBundle({ hwnd_metadata: {} })).toBe(true);
    });

    it('returns false for empty object', () => {
      expect(artifacts.isPeekRichEvidenceBundle({})).toBe(false);
    });

    it('returns false for object with unrelated keys', () => {
      expect(artifacts.isPeekRichEvidenceBundle({ x: 1, y: 2 })).toBe(false);
    });
  });

  // --- classifyEvidenceSufficiency ---

  describe('classifyEvidenceSufficiency', () => {
    it('returns sufficient for complete rich bundle', () => {
      const bundle = {
        app_type: 'wpf',
        capture_data: { image: 'base64...' },
        metadata: { title: 'App' },
        visual_tree: { root: {} },
        property_bag: { props: [] },
      };
      expect(artifacts.classifyEvidenceSufficiency(bundle)).toEqual({ sufficient: true });
    });

    it('reports missing capture_data for rich bundle', () => {
      const bundle = {
        app_type: 'wpf',
        capture_data: null,
        metadata: { title: 'App' },
        visual_tree: { root: {} },
      };
      const result = artifacts.classifyEvidenceSufficiency(bundle);
      expect(result.sufficient).toBe(false);
      expect(result.missing).toContain('capture_data');
    });

    it('reports missing metadata for rich bundle', () => {
      const bundle = {
        app_type: 'wpf',
        capture_data: { image: 'data' },
        metadata: null,
        visual_tree: { root: {} },
      };
      const result = artifacts.classifyEvidenceSufficiency(bundle);
      expect(result.sufficient).toBe(false);
      expect(result.missing).toContain('metadata');
    });

    it('reports missing primary snapshot field', () => {
      const bundle = {
        app_type: 'wpf',
        capture_data: { image: 'data' },
        metadata: { title: 'App' },
        visual_tree: null,
        property_bag: { props: [] },
      };
      const result = artifacts.classifyEvidenceSufficiency(bundle);
      expect(result.sufficient).toBe(false);
      expect(result.missing).toContain('visual_tree');
    });

    it('handles legacy non-rich bundle format', () => {
      const bundle = {
        evidence: { screenshot: 'data', elements: { tree: { root: {} } } },
        runtime: { version: '1.0' },
        target: { name: 'app' },
      };
      expect(artifacts.classifyEvidenceSufficiency(bundle)).toEqual({ sufficient: true });
    });

    it('reports missing screenshot for legacy bundle', () => {
      const bundle = {
        evidence: { screenshot: null, elements: { tree: { root: {} } } },
        runtime: { version: '1.0' },
        target: { name: 'app' },
      };
      const result = artifacts.classifyEvidenceSufficiency(bundle);
      expect(result.sufficient).toBe(false);
      expect(result.missing).toContain('capture_data');
    });

    it('reports missing visual_tree for legacy bundle without tree', () => {
      const bundle = {
        evidence: { screenshot: 'data', elements: { tree: null } },
        runtime: { version: '1.0' },
        target: { name: 'app' },
      };
      const result = artifacts.classifyEvidenceSufficiency(bundle);
      expect(result.sufficient).toBe(false);
      expect(result.missing).toContain('visual_tree');
    });
  });

  // --- applyEvidenceStateToBundle ---

  describe('applyEvidenceStateToBundle', () => {
    it('sets evidence_state to complete when sufficient', () => {
      const bundle = {};
      artifacts.applyEvidenceStateToBundle(bundle, { sufficient: true });
      expect(bundle.evidence_state).toBe('complete');
      expect(bundle.evidence_sufficiency).toEqual({ sufficient: true });
      expect(bundle.missing_evidence_fields).toEqual([]);
    });

    it('sets evidence_state to insufficient when not sufficient', () => {
      const bundle = {};
      artifacts.applyEvidenceStateToBundle(bundle, {
        sufficient: false,
        missing: ['capture_data', 'visual_tree'],
        confidence: 'low',
      });
      expect(bundle.evidence_state).toBe('insufficient');
      expect(bundle.evidence_sufficiency.sufficient).toBe(false);
      expect(bundle.evidence_sufficiency.missing).toEqual(['capture_data', 'visual_tree']);
      expect(bundle.missing_evidence_fields).toEqual(['capture_data', 'visual_tree']);
    });

    it('returns bundle unchanged for null input', () => {
      expect(artifacts.applyEvidenceStateToBundle(null, { sufficient: true })).toBeNull();
    });

    it('returns non-object input unchanged', () => {
      expect(artifacts.applyEvidenceStateToBundle('string', { sufficient: true })).toBe('string');
    });
  });

  // --- attachPeekArtifactReferences ---

  describe('attachPeekArtifactReferences', () => {
    it('delegates to contracts/peek', () => {
      const container = { existing: true };
      const refs = [{ kind: 'screenshot' }];
      artifacts.attachPeekArtifactReferences(container, refs);
      expect(contractsMock.attachPeekArtifactReferences).toHaveBeenCalledWith(container, refs);
    });
  });

  // --- storePeekArtifactsForTask ---

  describe('storePeekArtifactsForTask', () => {
    it('stores artifacts and returns merged refs', () => {
      fsMock.readFileSync.mockReturnValue(Buffer.from('not-json', 'utf8'));
      const refs = [{
        kind: 'screenshot',
        name: 'capture.png',
        path: '/tmp/capture.png',
        mime_type: 'image/png',
      }];

      const result = artifacts.storePeekArtifactsForTask('task-1', refs, {
        workflowId: 'wf-1',
        taskLabel: 'step-1',
      });

      expect(dbMock.storeArtifact).toHaveBeenCalledTimes(1);
      const stored = dbMock.storeArtifact.mock.calls[0][0];
      expect(stored.task_id).toBe('task-1');
      expect(stored.metadata.workflow_id).toBe('wf-1');
      expect(stored.metadata.task_label).toBe('step-1');
      expect(result.length).toBeGreaterThan(0);
    });

    it('skips refs that normalize to null', () => {
      contractsMock.normalizePeekArtifactReference.mockReturnValue(null);
      const result = artifacts.storePeekArtifactsForTask('task-2', [{ kind: 'bad' }]);
      expect(dbMock.storeArtifact).not.toHaveBeenCalled();
      expect(result).toEqual([]);
    });

    it('skips non-existent files', () => {
      fsMock.existsSync.mockReturnValue(false);
      artifacts.storePeekArtifactsForTask('task-3', [{
        kind: 'screenshot',
        path: '/missing/file.png',
      }]);
      expect(dbMock.storeArtifact).not.toHaveBeenCalled();
      expect(mockLoggerInstance.info).toHaveBeenCalled();
    });

    it('skips directories', () => {
      fsMock.statSync.mockReturnValue({ isFile: () => false, size: 0 });
      artifacts.storePeekArtifactsForTask('task-4', [{
        kind: 'screenshot',
        path: '/tmp/directory',
      }]);
      expect(dbMock.storeArtifact).not.toHaveBeenCalled();
    });

    it('handles empty/null refs array', () => {
      expect(artifacts.storePeekArtifactsForTask('task-5', null)).toEqual([]);
      expect(artifacts.storePeekArtifactsForTask('task-5', [])).toEqual([]);
    });

    it('signs bundle_json artifacts with checksum and evidence', () => {
      const bundleData = {
        app_type: 'wpf',
        capture_data: { image: 'test' },
        metadata: { title: 'Test' },
        visual_tree: { root: {} },
        property_bag: { items: [] },
      };
      fsMock.readFileSync.mockReturnValue(Buffer.from(JSON.stringify(bundleData), 'utf8'));

      artifacts.storePeekArtifactsForTask('task-6', [{
        kind: 'bundle_json',
        name: 'bundle.json',
        path: '/tmp/bundle.json',
      }]);

      const stored = dbMock.storeArtifact.mock.calls[0][0];
      expect(stored.metadata.signed_metadata).toBeDefined();
      expect(stored.metadata.signed_metadata.algorithm).toBe('sha256');
      expect(stored.metadata.signed_metadata.signer).toBe('torque-agent');
      expect(stored.metadata.integrity).toEqual({ valid: true });
      expect(stored.metadata.evidence_state).toBe('complete');
    });

    it('handles invalid JSON in bundle gracefully', () => {
      fsMock.readFileSync.mockReturnValue(Buffer.from('not valid json', 'utf8'));

      artifacts.storePeekArtifactsForTask('task-7', [{
        kind: 'bundle_json',
        name: 'bundle.json',
        path: '/tmp/bundle.json',
      }]);

      const stored = dbMock.storeArtifact.mock.calls[0][0];
      // Should not have signed_metadata since JSON.parse failed
      expect(stored.metadata.signed_metadata).toBeUndefined();
      expect(mockLoggerInstance.info).toHaveBeenCalled();
    });
  });

  // --- persistPeekResultReferences ---

  describe('persistPeekResultReferences', () => {
    it('returns empty array when no refs', () => {
      expect(artifacts.persistPeekResultReferences({}, [])).toEqual([]);
      expect(artifacts.persistPeekResultReferences({}, null)).toEqual([]);
    });

    it('stores artifacts and updates task metadata when taskId present', () => {
      const refs = [{
        kind: 'screenshot',
        name: 'cap.png',
        path: '/tmp/cap.png',
      }];
      fsMock.readFileSync.mockReturnValue(Buffer.from('img', 'utf8'));
      contractsMock.mergePeekArtifactReferences.mockImplementation(
        (existing, newRefs) => newRefs || existing || [],
      );

      const context = {
        taskId: 'task-persist-1',
        task: { metadata: { existing: true } },
      };
      artifacts.persistPeekResultReferences(context, refs);

      expect(dbMock.storeArtifact).toHaveBeenCalled();
      expect(dbMock.updateTask).toHaveBeenCalledWith('task-persist-1', expect.objectContaining({
        metadata: expect.any(Object),
      }));
    });

    it('updates workflow context when workflowId present', () => {
      const refs = [{
        kind: 'screenshot',
        name: 'cap.png',
        path: '/tmp/cap.png',
      }];
      fsMock.readFileSync.mockReturnValue(Buffer.from('img', 'utf8'));
      contractsMock.mergePeekArtifactReferences.mockImplementation(
        (existing, newRefs) => newRefs || existing || [],
      );
      dbMock.getWorkflow.mockReturnValue({ context: { previous: true } });

      const context = { workflowId: 'wf-persist-1' };
      artifacts.persistPeekResultReferences(context, refs);

      expect(dbMock.getWorkflow).toHaveBeenCalledWith('wf-persist-1');
      expect(dbMock.updateWorkflow).toHaveBeenCalledWith('wf-persist-1', expect.objectContaining({
        context: expect.any(Object),
      }));
    });

    it('handles storeArtifact errors gracefully', () => {
      const refs = [{
        kind: 'screenshot',
        name: 'cap.png',
        path: '/tmp/cap.png',
      }];
      fsMock.readFileSync.mockReturnValue(Buffer.from('img', 'utf8'));
      contractsMock.mergePeekArtifactReferences.mockImplementation(
        (existing, newRefs) => newRefs || existing || [],
      );
      dbMock.storeArtifact.mockImplementation(() => { throw new Error('DB error'); });

      const context = { taskId: 'task-fail' };
      // Should not throw
      artifacts.persistPeekResultReferences(context, refs);
      expect(mockLoggerInstance.info).toHaveBeenCalled();
    });

    it('handles getWorkflow errors gracefully', () => {
      const refs = [{
        kind: 'screenshot',
        name: 'cap.png',
        path: '/tmp/cap.png',
      }];
      fsMock.readFileSync.mockReturnValue(Buffer.from('img', 'utf8'));
      contractsMock.mergePeekArtifactReferences.mockImplementation(
        (existing, newRefs) => newRefs || existing || [],
      );
      dbMock.getWorkflow.mockImplementation(() => { throw new Error('workflow not found'); });

      const context = { workflowId: 'wf-fail' };
      artifacts.persistPeekResultReferences(context, refs);
      expect(mockLoggerInstance.info).toHaveBeenCalled();
    });
  });

  // --- buildPeekFallbackPersistOutputDir ---

  describe('buildPeekFallbackPersistOutputDir', () => {
    it('creates directory under artifact root with process name', () => {
      artifacts.buildPeekFallbackPersistOutputDir({ process: 'notepad.exe' });
      expect(fsMock.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('_adhoc'),
        { recursive: true },
      );
    });

    it('uses title when process not specified', () => {
      artifacts.buildPeekFallbackPersistOutputDir({ title: 'My Window' });
      expect(fsMock.mkdirSync).toHaveBeenCalled();
      expect(sharedMock.sanitizePeekTargetKey).toHaveBeenCalledWith('My Window', 'peek-diagnose');
    });

    it('uses default target when neither process nor title given', () => {
      artifacts.buildPeekFallbackPersistOutputDir({});
      expect(sharedMock.sanitizePeekTargetKey).toHaveBeenCalledWith('window', 'peek-diagnose');
    });
  });

  // --- ensurePeekBundlePersistence ---

  describe('ensurePeekBundlePersistence', () => {
    it('returns null for null/non-object input', () => {
      expect(artifacts.ensurePeekBundlePersistence(null, '/tmp')).toBeNull();
      expect(artifacts.ensurePeekBundlePersistence('string', '/tmp')).toBeNull();
    });

    it('persists bundle when evidence_state is insufficient', () => {
      const bundle = {
        evidence_state: 'insufficient',
        data: 'test',
      };
      const result = artifacts.ensurePeekBundlePersistence(bundle, '/tmp/output');
      expect(fsMock.writeFileSync).toHaveBeenCalled();
      expect(result).toBeTruthy();
      expect(bundle.artifacts.persisted).toBe(true);
    });

    it('persists bundle when outputDir is provided', () => {
      const bundle = { data: 'test' };
      const result = artifacts.ensurePeekBundlePersistence(bundle, '/tmp/output');
      expect(fsMock.writeFileSync).toHaveBeenCalled();
      expect(result).toBeTruthy();
    });

    it('uses existing bundle_path if available', () => {
      const bundle = {
        evidence_state: 'insufficient',
        artifacts: {
          persisted: false,
          bundle_path: '/existing/path/bundle.json',
        },
      };
      const result = artifacts.ensurePeekBundlePersistence(bundle, '/tmp/output');
      expect(result).toBe('/existing/path/bundle.json');
    });

    it('creates fallback output dir when no outputDir given', () => {
      const bundle = {
        evidence_state: 'insufficient',
        data: 'test',
      };
      artifacts.ensurePeekBundlePersistence(bundle, null, { process: 'calc.exe' });
      expect(sharedMock.getTorqueArtifactStorageRoot).toHaveBeenCalled();
    });

    it('returns null when nothing triggers persistence', () => {
      const bundle = { data: 'ok' };
      const result = artifacts.ensurePeekBundlePersistence(bundle, null);
      expect(result).toBeNull();
      expect(fsMock.writeFileSync).not.toHaveBeenCalled();
    });

    it('initializes artifacts object if not present', () => {
      const bundle = { evidence_state: 'insufficient' };
      artifacts.ensurePeekBundlePersistence(bundle, '/tmp/out');
      expect(bundle.artifacts).toBeDefined();
      expect(bundle.artifacts.persisted).toBe(true);
    });
  });

  // --- generateBundleChecksum ---

  describe('generateBundleChecksum', () => {
    it('produces consistent SHA256 hex hash', () => {
      const data = { name: 'test', value: 42 };
      const hash1 = artifacts.generateBundleChecksum(data);
      const hash2 = artifacts.generateBundleChecksum(data);
      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[0-9a-f]{64}$/);
    });

    it('produces same hash regardless of key order', () => {
      const hash1 = artifacts.generateBundleChecksum({ b: 2, a: 1 });
      const hash2 = artifacts.generateBundleChecksum({ a: 1, b: 2 });
      expect(hash1).toBe(hash2);
    });

    it('handles null/undefined input', () => {
      const hash = artifacts.generateBundleChecksum(null);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // --- signBundleMetadata ---

  describe('signBundleMetadata', () => {
    it('extracts bundle_version from contract', () => {
      const meta = artifacts.signBundleMetadata(
        { contract: { version: '2.0' } },
        'abc123',
      );
      expect(meta.bundle_version).toBe('2.0');
      expect(meta.checksum).toBe('abc123');
      expect(meta.algorithm).toBe('sha256');
      expect(meta.signer).toBe('torque-agent');
    });

    it('uses bundle_version field if available', () => {
      const meta = artifacts.signBundleMetadata({ bundle_version: '1.5' }, 'xyz');
      expect(meta.bundle_version).toBe('1.5');
    });

    it('returns null version for empty bundle', () => {
      const meta = artifacts.signBundleMetadata(null, 'hash');
      expect(meta.bundle_version).toBeNull();
    });
  });

  // --- validateBundleIntegrity ---

  describe('validateBundleIntegrity', () => {
    it('validates matching checksum', () => {
      const bundle = { data: 'test' };
      const checksum = artifacts.generateBundleChecksum(bundle);
      const meta = { checksum, algorithm: 'sha256' };
      expect(artifacts.validateBundleIntegrity(bundle, meta)).toBe(true);
    });

    it('rejects mismatched checksum', () => {
      const meta = { checksum: 'wrong', algorithm: 'sha256' };
      expect(artifacts.validateBundleIntegrity({ data: 'test' }, meta)).toBe(false);
    });

    it('rejects non-sha256 algorithm', () => {
      const bundle = { data: 'test' };
      const checksum = artifacts.generateBundleChecksum(bundle);
      expect(artifacts.validateBundleIntegrity(bundle, { checksum, algorithm: 'md5' })).toBe(false);
    });

    it('rejects null/missing bundle', () => {
      expect(artifacts.validateBundleIntegrity(null, { checksum: 'x', algorithm: 'sha256' })).toBe(false);
    });

    it('rejects null/missing metadata', () => {
      expect(artifacts.validateBundleIntegrity({ a: 1 }, null)).toBe(false);
    });

    it('rejects empty checksum', () => {
      expect(artifacts.validateBundleIntegrity({ a: 1 }, { checksum: '  ', algorithm: 'sha256' })).toBe(false);
    });

    it('unwraps signed_metadata envelope', () => {
      const bundle = { data: 'test' };
      const checksum = artifacts.generateBundleChecksum(bundle);
      const envelope = {
        signed_metadata: { checksum, algorithm: 'sha256' },
      };
      expect(artifacts.validateBundleIntegrity(bundle, envelope)).toBe(true);
    });
  });
});
