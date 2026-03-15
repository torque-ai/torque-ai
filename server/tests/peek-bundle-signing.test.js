const fs = require('fs');
const os = require('os');
const path = require('path');

const database = require('../database');
const { loadPeekContractFixture } = require('../contracts/peek');
const {
  generateBundleChecksum,
  signBundleMetadata,
  storePeekArtifactsForTask,
  validateBundleIntegrity,
} = require('../handlers/peek-handlers');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

describe('peek bundle signing helpers', () => {
  let tempDir = null;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('generateBundleChecksum returns consistent hash for same input', () => {
    const bundle = loadPeekContractFixture('peek-investigation-bundle-v1.json');

    expect(generateBundleChecksum(bundle)).toBe(generateBundleChecksum(clone(bundle)));
  });

  it('generateBundleChecksum returns different hash for different input', () => {
    const bundle = loadPeekContractFixture('peek-investigation-bundle-v1.json');
    const tamperedBundle = clone(bundle);
    tamperedBundle.result.success = false;

    expect(generateBundleChecksum(bundle)).not.toBe(generateBundleChecksum(tamperedBundle));
  });

  it('signBundleMetadata includes all required fields', () => {
    const bundle = loadPeekContractFixture('peek-investigation-bundle-v1.json');
    const checksum = generateBundleChecksum(bundle);

    const signedMetadata = signBundleMetadata(bundle, checksum);

    expect(signedMetadata).toEqual(expect.objectContaining({
      bundle_version: bundle.contract.version,
      checksum,
      algorithm: 'sha256',
      signer: 'torque-agent',
    }));
    expect(Number.isNaN(Date.parse(signedMetadata.signed_at))).toBe(false);
  });

  it('validateBundleIntegrity returns true for valid bundle', () => {
    const bundle = loadPeekContractFixture('peek-investigation-bundle-v1.json');
    const signedMetadata = signBundleMetadata(bundle, generateBundleChecksum(bundle));

    expect(validateBundleIntegrity(bundle, signedMetadata)).toBe(true);
  });

  it('validateBundleIntegrity returns false for tampered bundle', () => {
    const bundle = loadPeekContractFixture('peek-investigation-bundle-v1.json');
    const signedMetadata = signBundleMetadata(bundle, generateBundleChecksum(bundle));
    const tamperedBundle = clone(bundle);
    tamperedBundle.target.hwnd += 1;

    expect(validateBundleIntegrity(tamperedBundle, signedMetadata)).toBe(false);
  });

  it('stored artifacts include signed metadata', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-peek-signing-'));
    const bundle = loadPeekContractFixture('peek-investigation-bundle-v1.json');
    const bundlePath = path.join(tempDir, 'bundle.json');
    fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2), 'utf8');

    const storeSpy = vi.spyOn(database, 'storeArtifact').mockImplementation((artifact) => ({
      ...artifact,
      created_at: '2026-03-10T00:00:00.000Z',
      expires_at: '2026-04-09T00:00:00.000Z',
    }));

    const refs = storePeekArtifactsForTask('task-peek-signing', [{
      source: 'peek_diagnose',
      kind: 'bundle_json',
      name: 'bundle.json',
      path: bundlePath,
      mime_type: 'application/json',
      contract: {
        name: bundle.contract.name,
        version: bundle.contract.version,
      },
    }], {
      workflowId: 'wf-peek-signing',
      taskLabel: 'diagnose-ui',
    });

    expect(storeSpy).toHaveBeenCalledTimes(1);

    const storedArtifact = storeSpy.mock.calls[0][0];
    expect(storedArtifact).toEqual(expect.objectContaining({
      task_id: 'task-peek-signing',
      name: 'bundle.json',
      file_path: bundlePath,
    }));
    expect(storedArtifact.metadata).toEqual(expect.objectContaining({
      source: 'peek_diagnose',
      kind: 'bundle_json',
      workflow_id: 'wf-peek-signing',
      task_label: 'diagnose-ui',
      signed_metadata: expect.objectContaining({
        bundle_version: bundle.contract.version,
        checksum: generateBundleChecksum(bundle),
        algorithm: 'sha256',
        signer: 'torque-agent',
      }),
      integrity: {
        valid: true,
      },
    }));
    expect(validateBundleIntegrity(bundle, storedArtifact.metadata.signed_metadata)).toBe(true);
    expect(refs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        artifact_id: expect.any(String),
        path: bundlePath,
        task_id: 'task-peek-signing',
        task_label: 'diagnose-ui',
      }),
    ]));
  });
});
