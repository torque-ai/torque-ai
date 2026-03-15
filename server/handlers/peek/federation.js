'use strict';

const crypto = require('crypto');
const { validatePeekInvestigationBundleEnvelope } = require('../../contracts/peek');
const {
  signBundleMetadata,
  validateBundleIntegrity,
  canonicalizeBundleData,
  generateBundleChecksum,
} = require('./artifacts');
const logger = require('../../logger').child({ component: 'peek-federation' });

const FEDERATION_PROTOCOL_VERSION = '0.1.0';
const EXPORT_ENVELOPE_TYPE = 'peek_bundle_export';

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function compareDigest(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') {
    return false;
  }

  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function getBundleTimestamp(bundle) {
  const timestamp = Date.parse(bundle?.created_at ?? '');
  return Number.isFinite(timestamp) ? timestamp : 0;
}

/**
 * Export a bundle for federation - wraps it in a signed federation envelope.
 */
function exportBundle(bundle, options = {}) {
  if (!isObject(bundle)) {
    throw new Error('Bundle is required');
  }

  const exportedBundle = canonicalizeBundleData(bundle);
  const contractErrors = validatePeekInvestigationBundleEnvelope(exportedBundle);
  if (contractErrors.length > 0) {
    throw new Error(`Bundle contract invalid: ${contractErrors.join(', ')}`);
  }

  const checksum = generateBundleChecksum(exportedBundle);
  const signedMetadata = signBundleMetadata(exportedBundle, checksum);

  return {
    federation_protocol: FEDERATION_PROTOCOL_VERSION,
    envelope_type: EXPORT_ENVELOPE_TYPE,
    exported_at: new Date().toISOString(),
    source_instance: normalizeString(options.instance_id, 'unknown'),
    source_environment: normalizeString(options.environment, 'local'),
    bundle: exportedBundle,
    integrity: {
      checksum,
      algorithm: 'sha256',
      signed_metadata: signedMetadata,
    },
    trust_chain: {
      signer: 'torque-agent',
      trust_level: normalizeString(options.trust_level, 'local'),
      verified_at_export: true,
    },
  };
}

/**
 * Import a federated bundle - verify integrity and trust before accepting.
 */
function importBundle(envelope) {
  if (!isObject(envelope)) {
    throw new Error('Federation envelope required');
  }
  if (envelope.federation_protocol !== FEDERATION_PROTOCOL_VERSION) {
    throw new Error(`Unsupported protocol version: ${envelope.federation_protocol}`);
  }
  if (envelope.envelope_type !== EXPORT_ENVELOPE_TYPE) {
    throw new Error(`Unsupported envelope type: ${envelope.envelope_type}`);
  }

  const bundle = envelope.bundle;
  if (!isObject(bundle)) {
    throw new Error('Envelope contains no bundle');
  }

  const contractErrors = validatePeekInvestigationBundleEnvelope(bundle);
  if (contractErrors.length > 0) {
    logger.warn(`Rejected federated bundle from ${normalizeString(envelope.source_instance, 'unknown')}: contract validation failed`);
    return {
      accepted: false,
      reason: `Contract validation failed: ${contractErrors.join(', ')}`,
      errors: contractErrors,
    };
  }

  const integrity = isObject(envelope.integrity) ? envelope.integrity : {};
  const checksum = generateBundleChecksum(bundle);
  const signedMetadata = integrity.signed_metadata;
  const integrityValid = integrity.algorithm === 'sha256'
    && compareDigest(integrity.checksum, checksum)
    && compareDigest(signedMetadata?.checksum, checksum)
    && validateBundleIntegrity(bundle, signedMetadata);

  if (!integrityValid) {
    logger.warn(`Rejected federated bundle from ${normalizeString(envelope.source_instance, 'unknown')}: integrity check failed`);
    return { accepted: false, reason: 'Bundle integrity check failed' };
  }

  return {
    accepted: true,
    bundle,
    source_instance: normalizeString(envelope.source_instance, 'unknown'),
    source_environment: normalizeString(envelope.source_environment, 'local'),
    trust_level: normalizeString(envelope.trust_chain?.trust_level, 'untrusted'),
    imported_at: new Date().toISOString(),
  };
}

/**
 * Resolve conflicts when two instances have different versions of a bundle for the same target.
 * Strategy: most recent wins, but flag the conflict for review.
 */
function resolveConflict(localBundle, remoteBundle) {
  const localTime = getBundleTimestamp(localBundle);
  const remoteTime = getBundleTimestamp(remoteBundle);
  const remoteWins = remoteTime > localTime;

  return {
    winner: remoteWins ? 'remote' : 'local',
    chosen: remoteWins ? remoteBundle : localBundle,
    conflict: {
      local_created_at: localBundle?.created_at ?? null,
      remote_created_at: remoteBundle?.created_at ?? null,
      resolution_strategy: 'most_recent_wins',
      requires_review: true,
    },
  };
}

module.exports = {
  FEDERATION_PROTOCOL_VERSION,
  exportBundle,
  importBundle,
  resolveConflict,
};
