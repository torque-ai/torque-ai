'use strict';

const { WPF_FIXTURE } = require('../contracts/peek-fixtures');
const {
  canonicalizeBundleData,
  generateBundleChecksum,
  signBundleMetadata,
  validateBundleIntegrity,
} = require('../plugins/snapscope/handlers/artifacts');
const {
  FEDERATION_PROTOCOL_VERSION,
  exportBundle,
  importBundle,
  resolveConflict,
} = require('../plugins/snapscope/handlers/federation');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

describe('peek federation helpers', () => {
  it('exportBundle wraps bundle in federation envelope', () => {
    const bundle = clone(WPF_FIXTURE);
    const expectedBundle = canonicalizeBundleData(bundle);

    const envelope = exportBundle(bundle, {
      instance_id: 'torque-a',
      environment: 'staging',
      trust_level: 'trusted',
    });

    expect(envelope).toEqual(expect.objectContaining({
      federation_protocol: FEDERATION_PROTOCOL_VERSION,
      envelope_type: 'peek_bundle_export',
      source_instance: 'torque-a',
      source_environment: 'staging',
      bundle: expectedBundle,
      trust_chain: expect.objectContaining({
        signer: 'torque-agent',
        trust_level: 'trusted',
        verified_at_export: true,
      }),
    }));
    expect(Number.isNaN(Date.parse(envelope.exported_at))).toBe(false);
  });

  it('exportBundle validates bundle contract first', () => {
    const invalidBundle = clone(WPF_FIXTURE);
    delete invalidBundle.artifacts;

    expect(() => exportBundle(invalidBundle)).toThrow(/Bundle contract invalid:/);
  });

  it('exportBundle includes checksum and signed metadata', () => {
    const bundle = clone(WPF_FIXTURE);
    const expectedBundle = canonicalizeBundleData(bundle);
    const expectedChecksum = generateBundleChecksum(expectedBundle);
    const expectedMetadata = signBundleMetadata(expectedBundle, expectedChecksum);

    const envelope = exportBundle(bundle);

    expect(envelope.integrity).toEqual(expect.objectContaining({
      checksum: expectedChecksum,
      algorithm: 'sha256',
      signed_metadata: expect.objectContaining({
        bundle_version: expectedMetadata.bundle_version,
        checksum: expectedMetadata.checksum,
        algorithm: expectedMetadata.algorithm,
        signer: expectedMetadata.signer,
      }),
    }));
    expect(Number.isNaN(Date.parse(envelope.integrity.signed_metadata.signed_at))).toBe(false);
    expect(validateBundleIntegrity(envelope.bundle, envelope.integrity.signed_metadata)).toBe(true);
  });

  it('importBundle accepts valid envelope and returns bundle', () => {
    const envelope = exportBundle(clone(WPF_FIXTURE), {
      instance_id: 'torque-remote',
      environment: 'prod',
      trust_level: 'partner',
    });

    const result = importBundle(envelope);

    expect(result).toEqual(expect.objectContaining({
      accepted: true,
      bundle: envelope.bundle,
      source_instance: 'torque-remote',
      source_environment: 'prod',
      trust_level: 'partner',
    }));
    expect(Number.isNaN(Date.parse(result.imported_at))).toBe(false);
  });

  it('importBundle rejects invalid protocol version', () => {
    const envelope = exportBundle(clone(WPF_FIXTURE));
    envelope.federation_protocol = '9.9.9';

    expect(() => importBundle(envelope)).toThrow('Unsupported protocol version: 9.9.9');
  });

  it('importBundle rejects invalid envelope type', () => {
    const envelope = exportBundle(clone(WPF_FIXTURE));
    envelope.envelope_type = 'other_bundle_export';

    expect(() => importBundle(envelope)).toThrow('Unsupported envelope type: other_bundle_export');
  });

  it('importBundle rejects bundles failing contract validation', () => {
    const envelope = exportBundle(clone(WPF_FIXTURE));
    delete envelope.bundle.result;

    const result = importBundle(envelope);

    expect(result).toEqual({
      accepted: false,
      reason: expect.stringContaining('Contract validation failed:'),
      errors: expect.arrayContaining(['result must be an object']),
    });
  });

  it('importBundle rejects bundles failing integrity check', () => {
    const envelope = exportBundle(clone(WPF_FIXTURE));
    envelope.bundle.target.hwnd += 1;

    const result = importBundle(envelope);

    expect(result).toEqual({
      accepted: false,
      reason: 'Bundle integrity check failed',
    });
    expect(validateBundleIntegrity(envelope.bundle, envelope.integrity.signed_metadata)).toBe(false);
  });

  it('round-trips bundle export and import successfully', () => {
    const originalBundle = clone(WPF_FIXTURE);
    const envelope = exportBundle(originalBundle, {
      instance_id: 'torque-a',
      environment: 'local',
    });

    const result = importBundle(envelope);

    expect(result.accepted).toBe(true);
    expect(result.bundle).toEqual(canonicalizeBundleData(originalBundle));
    expect(result.source_instance).toBe('torque-a');
    expect(generateBundleChecksum(result.bundle)).toBe(envelope.integrity.checksum);
  });

  it('resolveConflict picks most recent bundle', () => {
    const localBundle = clone(WPF_FIXTURE);
    const remoteBundle = clone(WPF_FIXTURE);
    localBundle.created_at = '2026-03-10T10:00:00.000Z';
    remoteBundle.created_at = '2026-03-10T12:00:00.000Z';

    const result = resolveConflict(localBundle, remoteBundle);

    expect(result.winner).toBe('remote');
    expect(result.chosen).toBe(remoteBundle);
  });

  it('resolveConflict flags conflict for review', () => {
    const localBundle = clone(WPF_FIXTURE);
    const remoteBundle = clone(WPF_FIXTURE);
    localBundle.created_at = '2026-03-10T12:00:00.000Z';
    remoteBundle.created_at = '2026-03-10T10:00:00.000Z';

    const result = resolveConflict(localBundle, remoteBundle);

    expect(result.conflict).toEqual({
      local_created_at: '2026-03-10T12:00:00.000Z',
      remote_created_at: '2026-03-10T10:00:00.000Z',
      resolution_strategy: 'most_recent_wins',
      requires_review: true,
    });
    expect(result.winner).toBe('local');
  });

  it('FEDERATION_PROTOCOL_VERSION is pinned to 0.1.0', () => {
    expect(FEDERATION_PROTOCOL_VERSION).toBe('0.1.0');
  });
});
