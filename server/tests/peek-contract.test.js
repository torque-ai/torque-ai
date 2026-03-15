'use strict';

const fs = require('fs');
const path = require('path');

const snapscopeDefs = require('../tool-defs/snapscope-defs');
const {
  attachPeekArtifactReferences,
  buildPeekBundleArtifactReferences,
  PEEK_CAPABILITIES_CONTRACT,
  PEEK_DIAGNOSE_REQUEST_FIELDS,
  PEEK_DIAGNOSE_TOOL_INPUT_KEYS,
  PEEK_FIRST_SLICE_CANONICAL_HANDLER_NAME,
  PEEK_FIRST_SLICE_CANONICAL_TOOL_NAME,
  PEEK_FIRST_SLICE_NAME,
  PEEK_INVESTIGATION_BUNDLE_CONTRACT,
  buildPeekContractCatalog,
  buildPeekDiagnosePayload,
  formatPeekArtifactReferenceSection,
  getPeekFirstSliceCanonicalEntry,
  getPeekArtifactReferences,
  loadPeekContractFixture,
  normalizePeekHealthStatus,
  validatePeekCapabilitiesEnvelope,
  validatePeekInvestigationBundleEnvelope,
} = require('../contracts/peek');

const LOCAL_FIXTURE_DIR = path.join(__dirname, 'fixtures', 'contracts');
const UPSTREAM_FIXTURE_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'SnapScope',
  'tools',
  'peek-server',
  'tests',
  'fixtures',
  'contracts'
);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

describe('Peek contract intake', () => {
  it('stores Torque-side copies of the published SnapScope contract fixtures', () => {
    if (!fs.existsSync(UPSTREAM_FIXTURE_DIR)) {
      // SnapScope repo not present on this machine — skip cross-repo comparison
      return;
    }
    const localCapabilityFixture = readJson(path.join(LOCAL_FIXTURE_DIR, 'peek-capabilities-v1.json'));
    const localBundleFixture = readJson(path.join(LOCAL_FIXTURE_DIR, 'peek-investigation-bundle-v1.json'));
    const upstreamCapabilityFixture = readJson(path.join(UPSTREAM_FIXTURE_DIR, 'peek-capabilities-v1.json'));
    const upstreamBundleFixture = readJson(path.join(UPSTREAM_FIXTURE_DIR, 'peek-investigation-bundle-v1.json'));

    expect(localCapabilityFixture).toEqual(upstreamCapabilityFixture);
    expect(localBundleFixture).toEqual(upstreamBundleFixture);
  });

  it('validates the ingested capability and bundle fixtures against the first-slice contract rules', () => {
    const capabilityFixture = loadPeekContractFixture('peek-capabilities-v1.json');
    const bundleFixture = loadPeekContractFixture('peek-investigation-bundle-v1.json');

    expect(validatePeekCapabilitiesEnvelope(capabilityFixture)).toEqual([]);
    expect(validatePeekInvestigationBundleEnvelope(bundleFixture)).toEqual([]);
    expect(buildPeekContractCatalog()).toEqual({
      capabilities: PEEK_CAPABILITIES_CONTRACT,
      investigation_bundle: PEEK_INVESTIGATION_BUNDLE_CONTRACT,
    });
  });

  it('maps Torque diagnose inputs to the supported upstream request payload fields', () => {
    const payload = buildPeekDiagnosePayload({
      process: 'Taskmgr',
      host: 'omen',
      screenshot: false,
      annotate: true,
      elements: true,
      element_depth: 5,
      measurements: false,
      text_content: true,
      crop_element: 'Save',
      format: 'png',
      quality: 72,
      max_width: 1440,
      timeout_seconds: 45,
    });

    expect(payload).toEqual({
      mode: 'process',
      name: 'Taskmgr',
      screenshot: false,
      annotate: true,
      elements: true,
      element_depth: 5,
      measurements: false,
      text_content: true,
      crop_element: 'Save',
      format: 'png',
      quality: 72,
      max_width: 1440,
    });
    expect(Object.keys(payload).sort()).toEqual([...PEEK_DIAGNOSE_REQUEST_FIELDS].sort());
  });

  it('keeps the peek_diagnose tool definition aligned with the supported Torque-side inputs', () => {
    const diagnoseDef = snapscopeDefs.find((tool) => tool.name === PEEK_FIRST_SLICE_CANONICAL_TOOL_NAME);
    expect(diagnoseDef).toBeTruthy();

    const propertyKeys = Object.keys(diagnoseDef.inputSchema.properties).sort();
    expect(propertyKeys).toEqual([...PEEK_DIAGNOSE_TOOL_INPUT_KEYS].sort());
    expect(diagnoseDef.inputSchema.required || []).toEqual([]);
  });

  it('pins one canonical first-slice diagnose entry across the contract and tool-definition layers', () => {
    const canonicalEntry = getPeekFirstSliceCanonicalEntry();
    const diagnoseDef = snapscopeDefs.find((tool) => tool.name === canonicalEntry.tool_name);
    const peekUiDef = snapscopeDefs.find((tool) => tool.name === 'peek_ui');

    expect(canonicalEntry).toEqual({
      flow: 'diagnose_bundle',
      slice: PEEK_FIRST_SLICE_NAME,
      tool_name: PEEK_FIRST_SLICE_CANONICAL_TOOL_NAME,
      handler_name: PEEK_FIRST_SLICE_CANONICAL_HANDLER_NAME,
      upstream_route: '/diagnose',
      contract: PEEK_INVESTIGATION_BUNDLE_CONTRACT,
    });
    expect(diagnoseDef?.description).toContain('Canonical first-slice diagnose-and-bundle path.');
    expect(peekUiDef?.description).toContain('use `peek_diagnose`');
  });

  it('keeps the published bundle request example inside the Torque-supported request surface', () => {
    const bundleFixture = loadPeekContractFixture('peek-investigation-bundle-v1.json');
    const optionKeys = Object.keys(bundleFixture.request.options)
      .filter((key) => key !== 'hwnd')
      .sort();

    expect(optionKeys).toEqual(['annotate', 'elements', 'format', 'measurements', 'text_content']);
    expect(optionKeys.every((key) => PEEK_DIAGNOSE_REQUEST_FIELDS.includes(key))).toBe(true);
  });

  it('normalizes the published /health status label for Torque host summaries', () => {
    expect(normalizePeekHealthStatus({ status: 'ok' })).toBe('healthy');
    expect(normalizePeekHealthStatus({ status: 'healthy' })).toBe('healthy');
    expect(normalizePeekHealthStatus({ status: 'DEGRADED' })).toBe('degraded');
  });

  it('builds stable first-slice artifact references from persisted bundle metadata', () => {
    const bundleFixture = loadPeekContractFixture('peek-investigation-bundle-v1.json');
    bundleFixture.artifacts.persisted = true;
    bundleFixture.artifacts.bundle_path = 'C:/artifacts/bundle.json';
    bundleFixture.artifacts.artifact_report_path = 'C:/artifacts/artifact-report.json';

    const refs = buildPeekBundleArtifactReferences(bundleFixture, {
      host: 'omen',
      target: 'Taskmgr',
      task_id: 'task-123',
      workflow_id: 'wf-456',
      task_label: 'diagnose',
    });

    expect(refs).toEqual([
      expect.objectContaining({
        kind: 'bundle_json',
        name: 'bundle.json',
        path: 'C:/artifacts/bundle.json',
        host: 'omen',
        target: 'Taskmgr',
        task_id: 'task-123',
        workflow_id: 'wf-456',
        task_label: 'diagnose',
      }),
      expect.objectContaining({
        kind: 'artifact_report',
        name: 'artifact-report.json',
        path: 'C:/artifacts/artifact-report.json',
      }),
    ]);
  });

  it('stores and formats bundle references through the shared metadata helper', () => {
    const refs = [
      {
        kind: 'bundle_json',
        name: 'bundle.json',
        path: 'C:/artifacts/bundle.json',
        artifact_id: 'artifact-1234',
        task_label: 'diagnose',
        contract: { name: 'peek_investigation_bundle', version: 1 },
      },
    ];

    const metadata = attachPeekArtifactReferences({}, refs);

    expect(getPeekArtifactReferences(metadata)).toEqual([
      expect.objectContaining({
        kind: 'bundle_json',
        path: 'C:/artifacts/bundle.json',
      }),
    ]);
    expect(formatPeekArtifactReferenceSection(refs)).toContain('bundle.json: C:/artifacts/bundle.json');
  });
});
