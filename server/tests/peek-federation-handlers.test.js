import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const crypto = require('crypto');

const MODULE_PATH = require.resolve('../handlers/peek/federation');
const FIXED_TIME = '2026-03-12T19:00:00.000Z';
const FIXED_DIGEST = 'a'.repeat(64);

let currentModules = {};

vi.mock('../contracts/peek', () => currentModules.contracts);
vi.mock('../handlers/peek/artifacts', () => currentModules.artifacts);
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

function loadFederation() {
  vi.resetModules();
  vi.doMock('../contracts/peek', () => currentModules.contracts);
  vi.doMock('../handlers/peek/artifacts', () => currentModules.artifacts);
  vi.doMock('../logger', () => currentModules.logger);

  installCjsModuleMock('../contracts/peek', currentModules.contracts);
  installCjsModuleMock('../handlers/peek/artifacts', currentModules.artifacts);
  installCjsModuleMock('../logger', currentModules.logger);

  delete require.cache[MODULE_PATH];
  return require('../handlers/peek/federation');
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

function createBundle(overrides = {}) {
  return {
    contract: {
      name: 'peek_investigation_bundle',
      version: 2,
    },
    bundle_version: 2,
    created_at: '2026-03-10T10:00:00.000Z',
    metadata: {
      title: 'Calculator',
    },
    result: {
      success: true,
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

function createSignedMetadata(checksum = FIXED_DIGEST, overrides = {}) {
  return {
    bundle_version: 2,
    checksum,
    algorithm: 'sha256',
    signed_at: FIXED_TIME,
    signer: 'torque-agent',
    ...overrides,
  };
}

function createContractsMock(overrides = {}) {
  return {
    validatePeekInvestigationBundleEnvelope: vi.fn(() => []),
    ...overrides,
  };
}

function createArtifactsMock(overrides = {}) {
  return {
    canonicalizeBundleData: vi.fn((bundle) => ({
      ...bundle,
      canonicalized: true,
    })),
    generateBundleChecksum: vi.fn(() => FIXED_DIGEST),
    signBundleMetadata: vi.fn((bundle, checksum) => createSignedMetadata(checksum, {
      bundle_version: bundle?.bundle_version ?? bundle?.contract?.version ?? null,
    })),
    validateBundleIntegrity: vi.fn(() => true),
    ...overrides,
  };
}

function createEnvelope(overrides = {}) {
  const base = {
    federation_protocol: '0.1.0',
    envelope_type: 'peek_bundle_export',
    exported_at: '2026-03-12T18:30:00.000Z',
    source_instance: 'remote-west',
    source_environment: 'prod',
    bundle: createBundle(),
    integrity: {
      checksum: FIXED_DIGEST,
      algorithm: 'sha256',
      signed_metadata: createSignedMetadata(),
    },
    trust_chain: {
      signer: 'torque-agent',
      trust_level: 'partner',
      verified_at_export: true,
    },
  };

  return {
    ...base,
    ...overrides,
    bundle: Object.prototype.hasOwnProperty.call(overrides, 'bundle')
      ? overrides.bundle
      : base.bundle,
    integrity: Object.prototype.hasOwnProperty.call(overrides, 'integrity')
      ? {
          ...base.integrity,
          ...overrides.integrity,
          signed_metadata: Object.prototype.hasOwnProperty.call(overrides.integrity || {}, 'signed_metadata')
            ? {
                ...base.integrity.signed_metadata,
                ...overrides.integrity.signed_metadata,
              }
            : base.integrity.signed_metadata,
        }
      : base.integrity,
    trust_chain: Object.prototype.hasOwnProperty.call(overrides, 'trust_chain')
      ? {
          ...base.trust_chain,
          ...overrides.trust_chain,
        }
      : base.trust_chain,
  };
}

function setupHarness(options = {}) {
  const loggerMock = createLoggerMock();
  const contracts = createContractsMock(options.contracts);
  const artifacts = createArtifactsMock(options.artifacts);

  currentModules = {
    contracts,
    artifacts,
    logger: loggerMock.module,
  };

  const federation = loadFederation();

  return {
    federation,
    contracts,
    artifacts,
    loggerMock,
  };
}

describe('peek/federation exported handlers', () => {
  let harness;
  let federation;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_TIME));
    harness = setupHarness();
    federation = harness.federation;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.resetModules();
    currentModules = {};
    delete require.cache[MODULE_PATH];
    harness = null;
    federation = null;
  });

  it('registers the peek-federation logger component', () => {
    expect(harness.loggerMock.module.child).toHaveBeenCalledWith({
      component: 'peek-federation',
    });
  });

  describe('exportBundle', () => {
    it('rejects missing bundle payloads', () => {
      expect(() => federation.exportBundle(null)).toThrow('Bundle is required');
    });

    it('rejects array bundle payloads', () => {
      expect(() => federation.exportBundle([])).toThrow('Bundle is required');
    });

    it('canonicalizes the bundle before validation, checksumming, and signing', () => {
      const canonicalBundle = createBundle({
        canonicalized: true,
        metadata: {
          title: 'Canonical Calculator',
        },
      });
      harness = setupHarness({
        artifacts: {
          canonicalizeBundleData: vi.fn(() => canonicalBundle),
          generateBundleChecksum: vi.fn(() => 'b'.repeat(64)),
          signBundleMetadata: vi.fn((bundle, checksum) => createSignedMetadata(checksum, {
            bundle_version: bundle.bundle_version,
          })),
        },
      });
      federation = harness.federation;
      const bundle = createBundle({
        metadata: {
          title: 'Original Calculator',
        },
      });

      const envelope = federation.exportBundle(bundle, {
        instance_id: 'torque-west',
        environment: 'staging',
        trust_level: 'trusted',
      });

      expect(harness.artifacts.canonicalizeBundleData).toHaveBeenCalledWith(bundle);
      expect(harness.contracts.validatePeekInvestigationBundleEnvelope).toHaveBeenCalledWith(canonicalBundle);
      expect(harness.artifacts.generateBundleChecksum).toHaveBeenCalledWith(canonicalBundle);
      expect(harness.artifacts.signBundleMetadata).toHaveBeenCalledWith(canonicalBundle, 'b'.repeat(64));
      expect(envelope.bundle).toBe(canonicalBundle);
      expect(envelope.integrity).toEqual({
        checksum: 'b'.repeat(64),
        algorithm: 'sha256',
        signed_metadata: createSignedMetadata('b'.repeat(64)),
      });
    });

    it('throws when the canonicalized bundle fails contract validation', () => {
      harness = setupHarness({
        contracts: {
          validatePeekInvestigationBundleEnvelope: vi.fn(() => [
            'bundle_version must be a number',
            'artifacts must be an object',
          ]),
        },
      });
      federation = harness.federation;

      expect(() => federation.exportBundle(createBundle())).toThrow(
        'Bundle contract invalid: bundle_version must be a number, artifacts must be an object',
      );
      expect(harness.artifacts.generateBundleChecksum).not.toHaveBeenCalled();
      expect(harness.artifacts.signBundleMetadata).not.toHaveBeenCalled();
    });

    it('stores explicit instance, environment, and trust metadata', () => {
      const envelope = federation.exportBundle(createBundle(), {
        instance_id: 'torque-east',
        environment: 'partner',
        trust_level: 'verified',
      });

      expect(envelope).toEqual(expect.objectContaining({
        federation_protocol: '0.1.0',
        envelope_type: 'peek_bundle_export',
        source_instance: 'torque-east',
        source_environment: 'partner',
        trust_chain: expect.objectContaining({
          signer: 'torque-agent',
          trust_level: 'verified',
          verified_at_export: true,
        }),
      }));
    });

    it('trims string federation metadata before writing the envelope', () => {
      const envelope = federation.exportBundle(createBundle(), {
        instance_id: '  torque-south  ',
        environment: '  qa  ',
        trust_level: '  delegated  ',
      });

      expect(envelope.source_instance).toBe('torque-south');
      expect(envelope.source_environment).toBe('qa');
      expect(envelope.trust_chain.trust_level).toBe('delegated');
    });

    it('falls back to unknown, local, and local when federation metadata is blank', () => {
      const envelope = federation.exportBundle(createBundle(), {
        instance_id: '   ',
        environment: '',
        trust_level: null,
      });

      expect(envelope.source_instance).toBe('unknown');
      expect(envelope.source_environment).toBe('local');
      expect(envelope.trust_chain.trust_level).toBe('local');
    });

    it('timestamps the export envelope with the current clock', () => {
      const envelope = federation.exportBundle(createBundle());

      expect(envelope.exported_at).toBe(FIXED_TIME);
    });
  });

  describe('importBundle', () => {
    it('rejects non-object federation envelopes', () => {
      expect(() => federation.importBundle(null)).toThrow('Federation envelope required');
      expect(() => federation.importBundle([])).toThrow('Federation envelope required');
      expect(() => federation.importBundle('bundle')).toThrow('Federation envelope required');
    });

    it('throws on unsupported protocol versions', () => {
      expect(() => federation.importBundle(createEnvelope({
        federation_protocol: '9.9.9',
      }))).toThrow('Unsupported protocol version: 9.9.9');
    });

    it('throws on unsupported envelope types', () => {
      expect(() => federation.importBundle(createEnvelope({
        envelope_type: 'peek_bundle_sync',
      }))).toThrow('Unsupported envelope type: peek_bundle_sync');
    });

    it('throws when the envelope bundle is missing or invalid', () => {
      expect(() => federation.importBundle(createEnvelope({
        bundle: null,
      }))).toThrow('Envelope contains no bundle');
      expect(() => federation.importBundle(createEnvelope({
        bundle: [],
      }))).toThrow('Envelope contains no bundle');
    });

    it('returns contract validation failures and logs the normalized source instance', () => {
      harness = setupHarness({
        contracts: {
          validatePeekInvestigationBundleEnvelope: vi.fn(() => [
            'result must be an object',
            'artifacts must be an object',
          ]),
        },
      });
      federation = harness.federation;

      const result = federation.importBundle(createEnvelope({
        source_instance: '   ',
      }));

      expect(result).toEqual({
        accepted: false,
        reason: 'Contract validation failed: result must be an object, artifacts must be an object',
        errors: ['result must be an object', 'artifacts must be an object'],
      });
      expect(harness.artifacts.generateBundleChecksum).not.toHaveBeenCalled();
      expect(harness.loggerMock.instance.warn).toHaveBeenCalledWith(
        'Rejected federated bundle from unknown: contract validation failed',
      );
    });

    it('accepts valid federated bundles and returns normalized source metadata', () => {
      const envelope = createEnvelope({
        source_instance: '  torque-remote  ',
        source_environment: '  staging  ',
        trust_chain: {
          trust_level: '  trusted  ',
        },
      });

      const result = federation.importBundle(envelope);

      expect(result).toEqual({
        accepted: true,
        bundle: envelope.bundle,
        source_instance: 'torque-remote',
        source_environment: 'staging',
        trust_level: 'trusted',
        imported_at: FIXED_TIME,
      });
      expect(harness.contracts.validatePeekInvestigationBundleEnvelope).toHaveBeenCalledWith(envelope.bundle);
      expect(harness.artifacts.generateBundleChecksum).toHaveBeenCalledWith(envelope.bundle);
      expect(harness.artifacts.validateBundleIntegrity).toHaveBeenCalledWith(
        envelope.bundle,
        envelope.integrity.signed_metadata,
      );
    });

    it('falls back to unknown, local, and untrusted on accepted imports with missing source metadata', () => {
      const result = federation.importBundle(createEnvelope({
        source_instance: '   ',
        source_environment: '',
        trust_chain: {
          trust_level: null,
        },
      }));

      expect(result.source_instance).toBe('unknown');
      expect(result.source_environment).toBe('local');
      expect(result.trust_level).toBe('untrusted');
    });

    it('rejects envelopes that do not declare sha256 integrity', () => {
      const result = federation.importBundle(createEnvelope({
        integrity: {
          algorithm: 'md5',
        },
      }));

      expect(result).toEqual({
        accepted: false,
        reason: 'Bundle integrity check failed',
      });
      expect(harness.artifacts.validateBundleIntegrity).not.toHaveBeenCalled();
      expect(harness.loggerMock.instance.warn).toHaveBeenCalledWith(
        'Rejected federated bundle from remote-west: integrity check failed',
      );
    });

    it('rejects envelopes when integrity metadata is missing entirely', () => {
      const result = federation.importBundle({
        ...createEnvelope(),
        integrity: null,
      });

      expect(result).toEqual({
        accepted: false,
        reason: 'Bundle integrity check failed',
      });
      expect(harness.artifacts.validateBundleIntegrity).not.toHaveBeenCalled();
      expect(harness.loggerMock.instance.warn).toHaveBeenCalledWith(
        'Rejected federated bundle from remote-west: integrity check failed',
      );
    });

    it('rejects checksum length mismatches without calling timingSafeEqual', () => {
      const timingSafeEqualSpy = vi.spyOn(crypto, 'timingSafeEqual');

      const result = federation.importBundle(createEnvelope({
        integrity: {
          checksum: 'short',
        },
      }));

      expect(result).toEqual({
        accepted: false,
        reason: 'Bundle integrity check failed',
      });
      expect(timingSafeEqualSpy).not.toHaveBeenCalled();
      expect(harness.artifacts.validateBundleIntegrity).not.toHaveBeenCalled();
    });

    it('rejects signed metadata checksum mismatches and skips bundle validation', () => {
      const timingSafeEqualSpy = vi.spyOn(crypto, 'timingSafeEqual');

      const result = federation.importBundle(createEnvelope({
        integrity: {
          checksum: FIXED_DIGEST,
          signed_metadata: {
            checksum: 'b'.repeat(64),
          },
        },
      }));

      expect(result).toEqual({
        accepted: false,
        reason: 'Bundle integrity check failed',
      });
      expect(timingSafeEqualSpy).toHaveBeenCalledTimes(2);
      expect(harness.artifacts.validateBundleIntegrity).not.toHaveBeenCalled();
    });

    it('rejects non-string signed metadata checksums after the first digest comparison', () => {
      const timingSafeEqualSpy = vi.spyOn(crypto, 'timingSafeEqual');

      const result = federation.importBundle(createEnvelope({
        integrity: {
          signed_metadata: {
            checksum: 42,
          },
        },
      }));

      expect(result).toEqual({
        accepted: false,
        reason: 'Bundle integrity check failed',
      });
      expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1);
      expect(harness.artifacts.validateBundleIntegrity).not.toHaveBeenCalled();
    });

    it('rejects envelopes when bundle integrity validation fails after digest comparison', () => {
      harness = setupHarness({
        artifacts: {
          validateBundleIntegrity: vi.fn(() => false),
        },
      });
      federation = harness.federation;

      const result = federation.importBundle(createEnvelope({
        source_instance: '  remote-fail  ',
      }));

      expect(result).toEqual({
        accepted: false,
        reason: 'Bundle integrity check failed',
      });
      expect(harness.artifacts.validateBundleIntegrity).toHaveBeenCalledTimes(1);
      expect(harness.loggerMock.instance.warn).toHaveBeenCalledWith(
        'Rejected federated bundle from remote-fail: integrity check failed',
      );
    });

    it('uses timingSafeEqual for both digest comparisons on successful imports', () => {
      const timingSafeEqualSpy = vi.spyOn(crypto, 'timingSafeEqual');

      const result = federation.importBundle(createEnvelope());

      expect(result.accepted).toBe(true);
      expect(timingSafeEqualSpy).toHaveBeenCalledTimes(2);
    });

    it('logs integrity failures against the missing-instance fallback name', () => {
      const result = federation.importBundle(createEnvelope({
        source_instance: '',
        integrity: {
          algorithm: 'sha256',
          checksum: 'short',
        },
      }));

      expect(result).toEqual({
        accepted: false,
        reason: 'Bundle integrity check failed',
      });
      expect(harness.loggerMock.instance.warn).toHaveBeenCalledWith(
        'Rejected federated bundle from unknown: integrity check failed',
      );
    });
  });

  describe('resolveConflict', () => {
    it('selects the remote bundle when it is newer', () => {
      const localBundle = createBundle({
        created_at: '2026-03-10T10:00:00.000Z',
      });
      const remoteBundle = createBundle({
        created_at: '2026-03-10T12:00:00.000Z',
      });

      const result = federation.resolveConflict(localBundle, remoteBundle);

      expect(result.winner).toBe('remote');
      expect(result.chosen).toBe(remoteBundle);
    });

    it('keeps the local bundle when timestamps are identical', () => {
      const localBundle = createBundle({
        created_at: '2026-03-10T12:00:00.000Z',
      });
      const remoteBundle = createBundle({
        created_at: '2026-03-10T12:00:00.000Z',
      });

      const result = federation.resolveConflict(localBundle, remoteBundle);

      expect(result.winner).toBe('local');
      expect(result.chosen).toBe(localBundle);
    });

    it('treats invalid timestamps as zero and keeps the local bundle on ties', () => {
      const localBundle = createBundle({
        created_at: 'invalid-date',
      });
      const remoteBundle = createBundle({
        created_at: null,
      });

      const result = federation.resolveConflict(localBundle, remoteBundle);

      expect(result.winner).toBe('local');
      expect(result.chosen).toBe(localBundle);
    });

    it('records conflict metadata and nulls missing timestamps', () => {
      const result = federation.resolveConflict(createBundle({
        created_at: undefined,
      }), createBundle({
        created_at: '2026-03-10T12:00:00.000Z',
      }));

      expect(result.conflict).toEqual({
        local_created_at: null,
        remote_created_at: '2026-03-10T12:00:00.000Z',
        resolution_strategy: 'most_recent_wins',
        requires_review: true,
      });
    });
  });

  it('keeps the federation protocol version pinned to 0.1.0', () => {
    expect(federation.FEDERATION_PROTOCOL_VERSION).toBe('0.1.0');
  });
});
