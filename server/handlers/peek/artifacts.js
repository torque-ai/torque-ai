const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const database = require('../../database');
const { storeArtifact } = require('../../db/task-metadata');
const { getWorkflow, updateWorkflow } = require('../../db/workflow-engine');
const {
  attachPeekArtifactReferences: attachPeekArtifactReferencesToContainer,
  mergePeekArtifactReferences,
  normalizePeekArtifactReference,
} = require('../../contracts/peek');
const {
  getTorqueArtifactStorageRoot,
  inferPeekArtifactMimeType,
  sanitizePeekTargetKey,
} = require('./shared');
const { fireWebhookForEvent } = require('./webhook-outbound');
const logger = require('../../logger').child({ component: 'peek-artifacts' });

function canonicalizeBundleData(value) {
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : canonicalizeBundleData(item)));
  }

  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        if (value[key] !== undefined) {
          acc[key] = canonicalizeBundleData(value[key]);
        }
        return acc;
      }, {});
  }

  return value;
}

function generateBundleChecksum(bundleData) {
  const serializedBundle = JSON.stringify(canonicalizeBundleData(bundleData) ?? null);
  return crypto.createHash('sha256').update(serializedBundle).digest('hex');
}

function signBundleMetadata(bundle, checksum) {
  return {
    bundle_version: bundle?.bundle_version ?? bundle?.contract?.version ?? null,
    checksum,
    algorithm: 'sha256',
    signed_at: new Date().toISOString(),
    signer: 'torque-agent',
  };
}

function validateBundleIntegrity(bundle, metadata) {
  const envelope = metadata && typeof metadata === 'object' && metadata.signed_metadata
    ? metadata.signed_metadata
    : metadata;
  if (!bundle || typeof bundle !== 'object' || !envelope || typeof envelope !== 'object') {
    return false;
  }

  if (envelope.algorithm !== 'sha256' || typeof envelope.checksum !== 'string' || !envelope.checksum.trim()) {
    return false;
  }

  return generateBundleChecksum(bundle) === envelope.checksum;
}

function attachPeekArtifactReferences(container, refs) {
  return attachPeekArtifactReferencesToContainer(container, refs);
}

function storePeekArtifactsForTask(taskId, refs, context = {}) {
  const storedRefs = [];

  for (const ref of refs || []) {
    const normalizedRef = normalizePeekArtifactReference(ref);
    if (!normalizedRef) {
      continue;
    }

    const artifactPath = normalizedRef.path;
    if (!fs.existsSync(artifactPath)) {
      logger.info(`[peek-artifacts] persisted artifact missing for task ${taskId}: ${artifactPath}`);
      continue;
    }

    const stats = fs.statSync(artifactPath);
    if (!stats.isFile()) {
      continue;
    }

    const artifactBuffer = fs.readFileSync(artifactPath);
    const checksum = crypto.createHash('sha256').update(artifactBuffer).digest('hex');
    let signedMetadata = null;
    let integrity = null;
    let evidenceState = null;
    let missingEvidenceFields = [];
    let evidenceSufficiency = null;

    if (normalizedRef.kind === 'bundle_json') {
      try {
        const bundleData = JSON.parse(artifactBuffer.toString('utf8'));
        const bundleChecksum = generateBundleChecksum(bundleData);
        evidenceSufficiency = bundleData?.evidence_sufficiency && typeof bundleData.evidence_sufficiency === 'object'
          ? bundleData.evidence_sufficiency
          : classifyEvidenceSufficiency(bundleData);
        evidenceState = typeof bundleData?.evidence_state === 'string' && bundleData.evidence_state.trim()
          ? bundleData.evidence_state.trim()
          : (evidenceSufficiency.sufficient ? 'complete' : 'insufficient');
        missingEvidenceFields = Array.isArray(bundleData?.missing_evidence_fields)
          ? bundleData.missing_evidence_fields.filter((field) => typeof field === 'string' && field.trim())
          : (evidenceSufficiency.sufficient ? [] : [...(evidenceSufficiency.missing || [])]);
        const bundleMetadataSource = bundleData && typeof bundleData === 'object'
          ? {
              ...bundleData,
              contract: bundleData.contract || normalizedRef.contract || null,
            }
          : bundleData;
        signedMetadata = signBundleMetadata(bundleMetadataSource, bundleChecksum);
        integrity = {
          valid: validateBundleIntegrity(bundleData, signedMetadata),
        };
      } catch (err) {
        logger.info(`[peek-artifacts] bundle signing failed for task ${taskId}: ${artifactPath} (${err.message})`);
      }
    }

    const workflowId = context.workflowId || normalizedRef.workflow_id || null;
    const taskLabel = context.taskLabel || normalizedRef.task_label || null;
    const artifact = storeArtifact({
      id: crypto.randomUUID(),
      task_id: taskId,
      name: normalizedRef.name || path.basename(artifactPath),
      file_path: artifactPath,
      mime_type: inferPeekArtifactMimeType(artifactPath),
      size_bytes: stats.size,
      checksum,
      metadata: {
        source: 'peek_diagnose',
        kind: normalizedRef.kind,
        name: normalizedRef.name,
        host: normalizedRef.host,
        target: normalizedRef.target,
        workflow_id: workflowId,
        task_label: taskLabel,
        contract: normalizedRef.contract,
        evidence_state: evidenceState,
        missing_evidence_fields: missingEvidenceFields,
        evidence_sufficiency: evidenceSufficiency,
        ...(signedMetadata ? { signed_metadata: signedMetadata } : {}),
        ...(integrity ? { integrity } : {}),
      },
    });

    storedRefs.push({
      ...normalizedRef,
      artifact_id: artifact.id,
      path: artifact.file_path,
      mime_type: artifact.mime_type || normalizedRef.mime_type,
      task_id: taskId,
      workflow_id: workflowId,
      task_label: taskLabel,
    });
  }

  if (storedRefs.length > 0 && context?.policyProof) {
    try {
      const recordPolicyProof = typeof database.formatPolicyProof === 'function'
        ? database.formatPolicyProof
        : database.recordPolicyProofAudit;
      if (typeof recordPolicyProof === 'function') {
        recordPolicyProof({
          surface: 'artifact_persistence',
          policy_family: 'peek',
          proof: context.policyProof,
          context: {
            task_id: taskId,
            workflow_id: context.workflowId || storedRefs[0]?.workflow_id || null,
            action: 'store_artifacts',
            artifact_count: storedRefs.length,
          },
        });
      }
    } catch (err) {
      logger.warn(`Policy proof audit recording failed: ${err.message}`);
    }
  }

  const finalRefs = mergePeekArtifactReferences([], storedRefs);
  const storedBundleRefs = storedRefs.filter((ref) => ref && ref.kind === 'bundle_json');

  if (storedBundleRefs.length > 0) {
    fireWebhookForEvent('peek.bundle.created', {
      task_id: taskId,
    }).catch(() => {});
  }

  return finalRefs;
}

function persistPeekResultReferences(context = {}, refs) {
  const normalizedRefs = mergePeekArtifactReferences([], refs);
  if (normalizedRefs.length === 0) {
    return normalizedRefs;
  }

  let finalRefs = normalizedRefs;
  if (context.taskId) {
    try {
      finalRefs = storePeekArtifactsForTask(context.taskId, normalizedRefs, context);
      if (finalRefs.length > 0) {
        database.updateTask(context.taskId, {
          metadata: attachPeekArtifactReferences(context.task?.metadata, finalRefs),
        });
      }
    } catch (err) {
      logger.info(`[peek-artifacts] task artifact persistence failed for ${context.taskId}: ${err.message}`);
    }
  }

  if (context.workflowId) {
    try {
      const workflow = getWorkflow(context.workflowId);
      if (workflow) {
        updateWorkflow(context.workflowId, {
          context: attachPeekArtifactReferences(workflow.context, finalRefs),
        });
      }
    } catch (err) {
      logger.info(`[peek-artifacts] workflow artifact persistence failed for ${context.workflowId}: ${err.message}`);
    }
  }

  return finalRefs;
}

function hasPeekEvidenceValue(value) {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === 'object') {
    return Object.keys(value).length > 0;
  }
  return true;
}

function getPeekSnapshotEvidenceFields(bundleData) {
  switch (bundleData?.app_type) {
    case 'wpf':
      return ['visual_tree', 'property_bag'];
    case 'win32':
      return ['hwnd_metadata', 'class_name_chain'];
    case 'electron':
    case 'electron_webview':
      return ['devtools_protocol', 'dom_snapshot'];
    default:
      return ['visual_tree', 'property_bag', 'hwnd_metadata', 'class_name_chain', 'devtools_protocol', 'dom_snapshot'];
  }
}

function getPeekPrimarySnapshotField(bundleData) {
  switch (bundleData?.app_type) {
    case 'wpf':
      return 'visual_tree';
    case 'win32':
      return 'class_name_chain';
    case 'electron':
    case 'electron_webview':
      return 'dom_snapshot';
    default:
      return null;
  }
}

function isPeekRichEvidenceBundle(bundleData) {
  if (!bundleData || typeof bundleData !== 'object') {
    return false;
  }

  const snapshotFields = ['visual_tree', 'property_bag', 'hwnd_metadata', 'class_name_chain', 'devtools_protocol', 'dom_snapshot'];
  return typeof bundleData.app_type === 'string'
    || Object.prototype.hasOwnProperty.call(bundleData, 'capture_data')
    || Object.prototype.hasOwnProperty.call(bundleData, 'metadata')
    || snapshotFields.some((field) => Object.prototype.hasOwnProperty.call(bundleData, field));
}

function classifyEvidenceSufficiency(bundleData) {
  const missing = [];
  const usesRichEvidenceFields = isPeekRichEvidenceBundle(bundleData);

  if (usesRichEvidenceFields
    ? !hasPeekEvidenceValue(bundleData?.capture_data)
    : !hasPeekEvidenceValue(bundleData?.evidence?.screenshot)) {
    missing.push('capture_data');
  }

  if (usesRichEvidenceFields
    ? !hasPeekEvidenceValue(bundleData?.metadata)
    : !(hasPeekEvidenceValue(bundleData?.runtime) && hasPeekEvidenceValue(bundleData?.target))) {
    missing.push('metadata');
  }

  const primarySnapshotField = getPeekPrimarySnapshotField(bundleData);
  if (usesRichEvidenceFields) {
    if (primarySnapshotField && !hasPeekEvidenceValue(bundleData?.[primarySnapshotField])) {
      missing.push(primarySnapshotField);
    }

    const snapshotFields = getPeekSnapshotEvidenceFields(bundleData);
    const hasSnapshot = snapshotFields.some((field) => hasPeekEvidenceValue(bundleData?.[field]));
    if (!hasSnapshot) {
      for (const field of snapshotFields) {
        if (!hasPeekEvidenceValue(bundleData?.[field]) && !missing.includes(field)) {
          missing.push(field);
        }
      }
    }
  } else if (!hasPeekEvidenceValue(bundleData?.evidence?.elements?.tree)) {
    missing.push('visual_tree');
  }

  if (missing.length === 0) {
    return { sufficient: true };
  }

  return {
    sufficient: false,
    missing,
    confidence: 'low',
  };
}

function applyEvidenceStateToBundle(bundleData, evidenceSufficiency) {
  if (!bundleData || typeof bundleData !== 'object') {
    return bundleData;
  }

  const evidenceState = evidenceSufficiency?.sufficient ? 'complete' : 'insufficient';
  bundleData.evidence_state = evidenceState;
  bundleData.evidence_sufficiency = evidenceSufficiency?.sufficient
    ? { sufficient: true }
    : {
        sufficient: false,
        missing: Array.isArray(evidenceSufficiency?.missing) ? [...evidenceSufficiency.missing] : [],
        confidence: evidenceSufficiency?.confidence || 'low',
      };
  bundleData.missing_evidence_fields = evidenceState === 'insufficient'
    ? [...bundleData.evidence_sufficiency.missing]
    : [];

  return bundleData;
}

function buildPeekFallbackPersistOutputDir(args = {}) {
  const root = getTorqueArtifactStorageRoot();
  const targetValue = args.process || args.title || 'window';
  const targetKey = sanitizePeekTargetKey(targetValue, 'peek-diagnose');
  // SECURITY (M7): Use crypto.randomUUID() instead of Math.random()
  const runId = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const outputDir = path.join(root, '_adhoc', 'peek-diagnose', runId, targetKey);
  fs.mkdirSync(outputDir, { recursive: true });
  return outputDir;
}

function ensurePeekBundlePersistence(bundleData, outputDir, args = {}) {
  if (!bundleData || typeof bundleData !== 'object') {
    return null;
  }

  const artifacts = bundleData.artifacts && typeof bundleData.artifacts === 'object'
    ? bundleData.artifacts
    : (bundleData.artifacts = {
        persisted: false,
        bundle_path: null,
        artifact_report_path: null,
        signed: false,
      });

  const existingBundlePath = typeof artifacts.bundle_path === 'string' && artifacts.bundle_path.trim()
    ? artifacts.bundle_path.trim()
    : null;
  const shouldPersist = bundleData.evidence_state === 'insufficient'
    || !!existingBundlePath
    || !!outputDir;

  if (!shouldPersist) {
    return null;
  }

  const targetOutputDir = outputDir || buildPeekFallbackPersistOutputDir(args);
  const bundlePath = existingBundlePath || path.join(targetOutputDir, 'bundle.json');
  fs.mkdirSync(path.dirname(bundlePath), { recursive: true });

  artifacts.persisted = true;
  artifacts.bundle_path = bundlePath;
  if (typeof artifacts.artifact_report_path !== 'string') {
    artifacts.artifact_report_path = artifacts.artifact_report_path || null;
  }
  if (typeof artifacts.signed !== 'boolean') {
    artifacts.signed = false;
  }

  fs.writeFileSync(bundlePath, JSON.stringify(bundleData, null, 2), 'utf8');

  return bundlePath;
}

function createPeekArtifactsHandlers() {
  return {
    applyEvidenceStateToBundle,
    attachPeekArtifactReferences,
    buildPeekFallbackPersistOutputDir,
    canonicalizeBundleData,
    classifyEvidenceSufficiency,
    ensurePeekBundlePersistence,
    generateBundleChecksum,
    getPeekPrimarySnapshotField,
    getPeekSnapshotEvidenceFields,
    hasPeekEvidenceValue,
    isPeekRichEvidenceBundle,
    persistPeekResultReferences,
    signBundleMetadata,
    storePeekArtifactsForTask,
    validateBundleIntegrity,
  };
}

module.exports = {
  applyEvidenceStateToBundle,
  attachPeekArtifactReferences,
  buildPeekFallbackPersistOutputDir,
  canonicalizeBundleData,
  classifyEvidenceSufficiency,
  ensurePeekBundlePersistence,
  generateBundleChecksum,
  getPeekPrimarySnapshotField,
  getPeekSnapshotEvidenceFields,
  hasPeekEvidenceValue,
  isPeekRichEvidenceBundle,
  persistPeekResultReferences,
  signBundleMetadata,
  storePeekArtifactsForTask,
  validateBundleIntegrity,
  createPeekArtifactsHandlers,
};
