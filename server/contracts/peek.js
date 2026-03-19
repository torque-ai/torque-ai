'use strict';

const fs = require('fs');
const path = require('path');

const PEEK_CAPABILITIES_CONTRACT = Object.freeze({
  name: 'peek_capabilities',
  version: 1,
});

const PEEK_INVESTIGATION_BUNDLE_CONTRACT = Object.freeze({
  name: 'peek_investigation_bundle',
  version: 1,
});

const PEEK_CONTRACT_CATALOG = Object.freeze({
  capabilities: PEEK_CAPABILITIES_CONTRACT,
  investigation_bundle: PEEK_INVESTIGATION_BUNDLE_CONTRACT,
});

const PEEK_CAPABILITIES_ROUTES = Object.freeze({
  health: '/health',
  investigation_bundle: '/diagnose',
});

const PEEK_AUTHORITATIVE_VERSION_SOURCE = 'peek_server.__version__';
const PEEK_AUTHORITATIVE_PACKAGE_ROOT = 'tools/peek-server';
const PEEK_FIRST_SLICE_NAME = 'first';
const PEEK_FIRST_SLICE_HOST_PLATFORMS = Object.freeze(['windows']);
const PEEK_FIRST_SLICE_APP_TYPES = Object.freeze(['wpf', 'win32', 'electron_webview']);
const PEEK_FIRST_SLICE_CANONICAL_TOOL_NAME = 'peek_diagnose';
const PEEK_FIRST_SLICE_CANONICAL_HANDLER_NAME = 'handlePeekDiagnose';

const PEEK_DIAGNOSE_TOOL_INPUT_KEYS = Object.freeze([
  'process',
  'title',
  'host',
  'screenshot',
  'annotate',
  'text_content',
  'elements',
  'element_depth',
  'measurements',
  'crop_element',
  'format',
  'quality',
  'max_width',
  'timeout_seconds',
]);

const PEEK_DIAGNOSE_REQUEST_FIELDS = Object.freeze([
  'mode',
  'name',
  'screenshot',
  'annotate',
  'text_content',
  'elements',
  'element_depth',
  'measurements',
  'crop_element',
  'format',
  'quality',
  'max_width',
]);

const PEEK_CONTRACT_FIXTURE_DIR = path.join(__dirname, '..', 'tests', 'fixtures', 'contracts');
const PEEK_RESULT_REFERENCE_SOURCE = PEEK_FIRST_SLICE_CANONICAL_TOOL_NAME;
const PEEK_BUNDLE_REFERENCE_METADATA_KEY = 'peek';
const PEEK_BUNDLE_REFERENCE_COLLECTION_KEY = 'bundle_references';
const PEEK_BUNDLE_ARTIFACT_SPECS = Object.freeze([
  Object.freeze({
    kind: 'bundle_json',
    artifactKey: 'bundle_path',
    defaultName: 'bundle.json',
    mimeType: 'application/json',
  }),
  Object.freeze({
    kind: 'artifact_report',
    artifactKey: 'artifact_report_path',
    defaultName: 'artifact-report.json',
    mimeType: 'application/json',
  }),
]);
const PROOF_SURFACE_CATALOG = Object.freeze({
  recovery_execution: 'Policy proof attached during recovery action execution',
  artifact_persistence: 'Policy proof attached when artifacts are persisted to storage',
  capture_analysis: 'Policy proof attached when capture analysis completes',
  bundle_creation: 'Policy proof attached when a peek evidence bundle is created',
});
const PEEK_SENSOR_TYPES = Object.freeze({
  performance_counters: Object.freeze({
    name: 'performance_counters',
    description: 'Process CPU, memory, and handle metrics captured alongside the screenshot',
    fields: Object.freeze(['cpu_percent', 'memory_bytes', 'handle_count', 'thread_count', 'uptime_seconds']),
    optional: true,
  }),
  accessibility_tree_diff: Object.freeze({
    name: 'accessibility_tree_diff',
    description: 'UIA tree diff before and after a recovery action',
    fields: Object.freeze([
      'before_tree_hash',
      'after_tree_hash',
      'diff_summary',
      'nodes_added',
      'nodes_removed',
      'nodes_changed',
    ]),
    optional: true,
  }),
});
const PEEK_CAPTURE_PROVIDERS = Object.freeze({
  win32: Object.freeze({
    name: 'win32',
    description: 'Windows desktop capture via PrintWindow, DXGI, GDI',
    platforms: Object.freeze(['windows']),
    capabilities: Object.freeze(['window_capture', 'element_tree', 'accessibility', 'dpi_aware']),
    status: 'implemented',
  }),
  x11: Object.freeze({
    name: 'x11',
    description: 'Linux X11 capture via XGetImage or import',
    platforms: Object.freeze(['linux']),
    capabilities: Object.freeze(['window_capture', 'element_tree']),
    status: 'planned',
  }),
  wayland: Object.freeze({
    name: 'wayland',
    description: 'Linux Wayland capture via portal screenshot API',
    platforms: Object.freeze(['linux']),
    capabilities: Object.freeze(['window_capture']),
    status: 'planned',
  }),
  macos: Object.freeze({
    name: 'macos',
    description: 'macOS capture via CGWindowListCreateImage + Accessibility API',
    platforms: Object.freeze(['darwin']),
    capabilities: Object.freeze(['window_capture', 'element_tree', 'accessibility']),
    status: 'planned',
  }),
  browser: Object.freeze({
    name: 'browser',
    description: 'Browser capture via Chrome DevTools Protocol (Playwright/Puppeteer)',
    platforms: Object.freeze(['windows', 'linux', 'darwin']),
    capabilities: Object.freeze(['window_capture', 'dom_tree', 'network_interception']),
    status: 'planned',
  }),
});

const PEEK_PLATFORM_SUPPORT_MATRIX = Object.freeze({
  windows: Object.freeze({
    supported: true,
    providers: Object.freeze(['win32', 'browser']),
    app_types: Object.freeze(['wpf', 'win32', 'electron_webview', 'winforms', 'qt']),
    slice: 'first',
  }),
  linux: Object.freeze({
    supported: false,
    providers: Object.freeze(['x11', 'wayland', 'browser']),
    app_types: Object.freeze(['qt', 'gtk']),
    slice: null,
    prerequisite: 'DS-06',
  }),
  darwin: Object.freeze({
    supported: false,
    providers: Object.freeze(['macos', 'browser']),
    app_types: Object.freeze(['cocoa', 'qt', 'electron_webview']),
    slice: null,
    prerequisite: 'DS-06',
  }),
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function loadPeekContractFixture(fileName) {
  const fixturePath = path.join(PEEK_CONTRACT_FIXTURE_DIR, fileName);
  try {
    return JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  } catch (err) {
    throw new Error(`loadPeekContractFixture: failed to load "${fileName}" from ${PEEK_CONTRACT_FIXTURE_DIR} — ${err.message}`);
  }
}

function buildPeekContractCatalog() {
  return {
    capabilities: { ...PEEK_CAPABILITIES_CONTRACT },
    investigation_bundle: { ...PEEK_INVESTIGATION_BUNDLE_CONTRACT },
  };
}

function getPeekFirstSliceCanonicalEntry() {
  return {
    flow: 'diagnose_bundle',
    slice: PEEK_FIRST_SLICE_NAME,
    tool_name: PEEK_FIRST_SLICE_CANONICAL_TOOL_NAME,
    handler_name: PEEK_FIRST_SLICE_CANONICAL_HANDLER_NAME,
    upstream_route: PEEK_CAPABILITIES_ROUTES.investigation_bundle,
    contract: { ...PEEK_INVESTIGATION_BUNDLE_CONTRACT },
  };
}

function normalizeCapturePlatform(platform) {
  return typeof platform === 'string' ? platform.trim().toLowerCase() : '';
}

function getCaptureProvidersForPlatform(platform) {
  const normalizedPlatform = normalizeCapturePlatform(platform);
  const platformEntry = PEEK_PLATFORM_SUPPORT_MATRIX[normalizedPlatform];
  if (!platformEntry) {
    return [];
  }

  return platformEntry.providers
    .map((providerName) => PEEK_CAPTURE_PROVIDERS[providerName])
    .filter(Boolean);
}

function isPlatformSupported(platform) {
  const normalizedPlatform = normalizeCapturePlatform(platform);
  return PEEK_PLATFORM_SUPPORT_MATRIX[normalizedPlatform]?.supported === true;
}

function expectObject(payload, key, errors, prefix) {
  const value = payload[key];
  if (!isPlainObject(value)) {
    errors.push(`${qualify(prefix, key)} must be an object`);
    return null;
  }
  return value;
}

function expectType(payload, key, expectedType, errors, prefix) {
  const value = payload[key];
  if (typeof value !== expectedType) {
    errors.push(`${qualify(prefix, key)} must be a ${expectedType}`);
  }
}

function expectNullableType(payload, key, expectedType, errors, prefix) {
  const value = payload[key];
  if (value !== null && value !== undefined && typeof value !== expectedType) {
    errors.push(`${qualify(prefix, key)} must be a ${expectedType} or null`);
  }
}

function expectEqual(payload, key, expectedValue, errors, prefix) {
  if (payload[key] !== expectedValue) {
    errors.push(`${qualify(prefix, key)} must equal ${JSON.stringify(expectedValue)}`);
  }
}

function expectStringList(payload, key, errors, prefix) {
  const value = payload[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    errors.push(`${qualify(prefix, key)} must be a list of strings`);
  }
}

function validateImageBlob(payload, key, errors) {
  const blob = payload[key];
  if (!isPlainObject(blob)) {
    errors.push(`evidence.${key} must be an object`);
    return;
  }

  if (typeof blob.present !== 'boolean') {
    errors.push(`evidence.${key}.present must be a bool`);
  }
  if (blob.encoding !== null && blob.encoding !== undefined && typeof blob.encoding !== 'string') {
    errors.push(`evidence.${key}.encoding must be a string or null`);
  }
  if (blob.mime_type !== null && blob.mime_type !== undefined && typeof blob.mime_type !== 'string') {
    errors.push(`evidence.${key}.mime_type must be a string or null`);
  }
  if (blob.data !== null && blob.data !== undefined && typeof blob.data !== 'string') {
    errors.push(`evidence.${key}.data must be a string or null`);
  }
}

function qualify(prefix, key) {
  return prefix ? `${prefix}.${key}` : key;
}

function validatePeekCapabilitiesEnvelope(payload) {
  const errors = [];
  if (!isPlainObject(payload)) {
    return ['payload must be an object'];
  }

  const contract = expectObject(payload, 'contract', errors);
  const slice = expectObject(payload, 'slice', errors);
  const routes = expectObject(payload, 'routes', errors);
  const versioning = expectObject(payload, 'versioning', errors);
  const features = expectObject(payload, 'features', errors);

  if (contract) {
    expectEqual(contract, 'name', PEEK_CAPABILITIES_CONTRACT.name, errors, 'contract');
    expectEqual(contract, 'version', PEEK_CAPABILITIES_CONTRACT.version, errors, 'contract');
  }

  if (slice) {
    expectEqual(slice, 'name', PEEK_FIRST_SLICE_NAME, errors, 'slice');
    expectStringList(slice, 'supported_host_platforms', errors, 'slice');
    expectStringList(slice, 'supported_app_types', errors, 'slice');
  }

  if (routes) {
    expectEqual(routes, 'health', PEEK_CAPABILITIES_ROUTES.health, errors, 'routes');
    expectEqual(routes, 'investigation_bundle', PEEK_CAPABILITIES_ROUTES.investigation_bundle, errors, 'routes');
  }

  if (versioning) {
    expectType(versioning, 'runtime_version', 'string', errors, 'versioning');
    expectEqual(versioning, 'version_source', PEEK_AUTHORITATIVE_VERSION_SOURCE, errors, 'versioning');
    expectEqual(versioning, 'package_root', PEEK_AUTHORITATIVE_PACKAGE_ROOT, errors, 'versioning');
  }

  if (features) {
    for (const [featureName, featurePayload] of Object.entries(features)) {
      if (!isPlainObject(featurePayload)) {
        errors.push(`features.${featureName} must be an object`);
        continue;
      }

      if (typeof featurePayload.status !== 'string') {
        errors.push(`features.${featureName}.status must be a string`);
      }
      if (Object.prototype.hasOwnProperty.call(featurePayload, 'routes')) {
        expectStringList(featurePayload, 'routes', errors, `features.${featureName}`);
      }
      if (Object.prototype.hasOwnProperty.call(featurePayload, 'backlog_id')) {
        expectType(featurePayload, 'backlog_id', 'string', errors, `features.${featureName}`);
      }
      if (Object.prototype.hasOwnProperty.call(featurePayload, 'persisted_artifacts')) {
        expectType(featurePayload, 'persisted_artifacts', 'boolean', errors, `features.${featureName}`);
      }
    }
  }

  return errors;
}

function validatePeekInvestigationBundleEnvelope(payload) {
  const errors = [];
  if (!isPlainObject(payload)) {
    return ['payload must be an object'];
  }

  const contract = expectObject(payload, 'contract', errors);
  const runtime = expectObject(payload, 'runtime', errors);
  const request = expectObject(payload, 'request', errors);
  const target = expectObject(payload, 'target', errors);
  const result = expectObject(payload, 'result', errors);
  const artifacts = expectObject(payload, 'artifacts', errors);
  const evidence = expectObject(payload, 'evidence', errors);

  expectEqual(payload, 'kind', 'diagnose', errors);
  expectEqual(payload, 'slice', PEEK_FIRST_SLICE_NAME, errors);
  expectType(payload, 'created_at', 'string', errors);

  if (contract) {
    expectEqual(contract, 'name', PEEK_INVESTIGATION_BUNDLE_CONTRACT.name, errors, 'contract');
    expectEqual(contract, 'version', PEEK_INVESTIGATION_BUNDLE_CONTRACT.version, errors, 'contract');
  }

  if (runtime) {
    expectEqual(runtime, 'name', 'peek-server', errors, 'runtime');
    expectType(runtime, 'version', 'string', errors, 'runtime');
    expectType(runtime, 'platform', 'string', errors, 'runtime');
    expectEqual(runtime, 'package_root', PEEK_AUTHORITATIVE_PACKAGE_ROOT, errors, 'runtime');
  }

  if (request) {
    expectEqual(request, 'route', PEEK_CAPABILITIES_ROUTES.investigation_bundle, errors, 'request');
    expectObject(request, 'options', errors, 'request');
  }

  if (target) {
    expectType(target, 'hwnd', 'number', errors, 'target');
    const locator = expectObject(target, 'locator', errors, 'target');
    if (locator) {
      expectType(locator, 'type', 'string', errors, 'target.locator');
      if (!Object.prototype.hasOwnProperty.call(locator, 'value')) {
        errors.push('target.locator.value is required');
      }
    }
  }

  if (result) {
    expectType(result, 'success', 'boolean', errors, 'result');
    if (
      Object.prototype.hasOwnProperty.call(result, 'error') &&
      result.error !== null &&
      typeof result.error !== 'string'
    ) {
      errors.push('result.error must be a string or null');
    }
    if (!Array.isArray(result.warnings)) {
      errors.push('result.warnings must be a list');
    }
  }

  if (artifacts) {
    expectType(artifacts, 'persisted', 'boolean', errors, 'artifacts');
    expectNullableType(artifacts, 'bundle_path', 'string', errors, 'artifacts');
    expectNullableType(artifacts, 'artifact_report_path', 'string', errors, 'artifacts');
    expectType(artifacts, 'signed', 'boolean', errors, 'artifacts');
  }

  if (evidence) {
    validateImageBlob(evidence, 'screenshot', errors);
    validateImageBlob(evidence, 'annotated_screenshot', errors);

    const elements = expectObject(evidence, 'elements', errors, 'evidence');
    if (elements) {
      expectType(elements, 'count', 'number', errors, 'evidence.elements');
      if (!Array.isArray(elements.tree)) {
        errors.push('evidence.elements.tree must be a list');
      }
    }

    if (
      Object.prototype.hasOwnProperty.call(evidence, 'measurements') &&
      evidence.measurements !== null &&
      !isPlainObject(evidence.measurements)
    ) {
      errors.push('evidence.measurements must be an object or null');
    }

    if (
      Object.prototype.hasOwnProperty.call(evidence, 'text_content') &&
      evidence.text_content !== null &&
      !isPlainObject(evidence.text_content)
    ) {
      errors.push('evidence.text_content must be an object or null');
    }

    if (!Array.isArray(evidence.annotation_index)) {
      errors.push('evidence.annotation_index must be a list');
    }
  }

  return errors;
}

function buildPeekDiagnosePayload(args) {
  const payload = {};

  if (args.process) {
    payload.mode = 'process';
    payload.name = args.process;
  } else if (args.title) {
    payload.mode = 'title';
    payload.name = args.title;
  } else {
    throw new Error('peek_diagnose requires process or title');
  }

  if (args.screenshot !== undefined) payload.screenshot = !!args.screenshot;
  payload.annotate = args.annotate !== false;
  if (args.elements !== undefined) payload.elements = !!args.elements;
  if (args.element_depth != null) payload.element_depth = args.element_depth;
  if (args.measurements !== undefined) payload.measurements = !!args.measurements;
  if (args.text_content !== undefined) payload.text_content = !!args.text_content;
  if (args.crop_element) payload.crop_element = args.crop_element;
  if (args.format) payload.format = args.format;
  if (args.quality != null) payload.quality = args.quality;
  if (args.max_width != null) payload.max_width = args.max_width;

  return payload;
}

function normalizePeekHealthStatus(healthPayload) {
  const rawStatus = typeof healthPayload?.status === 'string'
    ? healthPayload.status.trim().toLowerCase()
    : '';

  if (!rawStatus || rawStatus === 'ok') {
    return 'healthy';
  }

  return rawStatus;
}

function getPeekBundleContractSummary(bundle) {
  if (!isPlainObject(bundle) || !isPlainObject(bundle.contract)) {
    return null;
  }

  return {
    name: bundle.contract.name || null,
    version: bundle.contract.version ?? null,
    slice: typeof bundle.slice === 'string' ? bundle.slice : null,
    created_at: typeof bundle.created_at === 'string' ? bundle.created_at : null,
    persisted: typeof bundle.artifacts?.persisted === 'boolean' ? bundle.artifacts.persisted : null,
    signed: typeof bundle.artifacts?.signed === 'boolean' ? bundle.artifacts.signed : null,
  };
}

function normalizePeekArtifactReference(reference) {
  if (!isPlainObject(reference)) {
    return null;
  }

  const pathValue = typeof reference.path === 'string' && reference.path.trim()
    ? reference.path.trim()
    : null;
  if (!pathValue) {
    return null;
  }

  const contract = isPlainObject(reference.contract)
    ? {
        name: typeof reference.contract.name === 'string' ? reference.contract.name : null,
        version: reference.contract.version ?? null,
        slice: typeof reference.contract.slice === 'string' ? reference.contract.slice : null,
        created_at: typeof reference.contract.created_at === 'string' ? reference.contract.created_at : null,
        persisted: typeof reference.contract.persisted === 'boolean' ? reference.contract.persisted : null,
        signed: typeof reference.contract.signed === 'boolean' ? reference.contract.signed : null,
      }
    : null;

  return {
    source: typeof reference.source === 'string' ? reference.source : PEEK_RESULT_REFERENCE_SOURCE,
    kind: typeof reference.kind === 'string' ? reference.kind : null,
    name: typeof reference.name === 'string' && reference.name.trim() ? reference.name.trim() : path.basename(pathValue),
    path: pathValue,
    mime_type: typeof reference.mime_type === 'string' ? reference.mime_type : null,
    artifact_id: typeof reference.artifact_id === 'string' ? reference.artifact_id : null,
    task_id: typeof reference.task_id === 'string' ? reference.task_id : null,
    workflow_id: typeof reference.workflow_id === 'string' ? reference.workflow_id : null,
    host: typeof reference.host === 'string' ? reference.host : null,
    target: typeof reference.target === 'string' ? reference.target : null,
    task_label: typeof reference.task_label === 'string' ? reference.task_label : null,
    contract,
  };
}

function buildPeekBundleArtifactReferences(bundle, extra = {}) {
  if (!isPlainObject(bundle) || !isPlainObject(bundle.artifacts)) {
    return [];
  }

  const contract = getPeekBundleContractSummary(bundle);
  const refs = [];
  for (const spec of PEEK_BUNDLE_ARTIFACT_SPECS) {
    const artifactPath = bundle.artifacts[spec.artifactKey];
    if (typeof artifactPath !== 'string' || !artifactPath.trim()) {
      continue;
    }

    const ref = normalizePeekArtifactReference({
      source: PEEK_RESULT_REFERENCE_SOURCE,
      kind: spec.kind,
      name: spec.defaultName,
      path: artifactPath,
      mime_type: spec.mimeType,
      artifact_id: extra.artifact_id ?? null,
      task_id: extra.task_id ?? null,
      workflow_id: extra.workflow_id ?? null,
      host: extra.host ?? null,
      target: extra.target ?? null,
      task_label: extra.task_label ?? null,
      contract,
    });
    if (ref) {
      refs.push(ref);
    }
  }
  return refs;
}

function mergePeekArtifactReferences(existingRefs, nextRefs) {
  const merged = [];
  const seen = new Set();

  for (const ref of [...(existingRefs || []), ...(nextRefs || [])]) {
    const normalized = normalizePeekArtifactReference(ref);
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

function getPeekArtifactReferences(container) {
  if (!isPlainObject(container)) {
    return [];
  }

  const peekBlock = isPlainObject(container[PEEK_BUNDLE_REFERENCE_METADATA_KEY])
    ? container[PEEK_BUNDLE_REFERENCE_METADATA_KEY]
    : null;
  const refs = Array.isArray(peekBlock?.[PEEK_BUNDLE_REFERENCE_COLLECTION_KEY])
    ? peekBlock[PEEK_BUNDLE_REFERENCE_COLLECTION_KEY]
    : [];
  return mergePeekArtifactReferences([], refs);
}

function attachPeekArtifactReferences(container, refs) {
  const normalizedRefs = mergePeekArtifactReferences(getPeekArtifactReferences(container), refs);
  if (normalizedRefs.length === 0) {
    return isPlainObject(container) ? { ...container } : {};
  }

  const base = isPlainObject(container) ? { ...container } : {};
  const peekBlock = isPlainObject(base[PEEK_BUNDLE_REFERENCE_METADATA_KEY])
    ? { ...base[PEEK_BUNDLE_REFERENCE_METADATA_KEY] }
    : {};
  peekBlock[PEEK_BUNDLE_REFERENCE_COLLECTION_KEY] = normalizedRefs;
  base[PEEK_BUNDLE_REFERENCE_METADATA_KEY] = peekBlock;
  return base;
}

function isPeekTaskArtifactRecord(artifact) {
  return isPlainObject(artifact)
    && isPlainObject(artifact.metadata)
    && artifact.metadata.source === PEEK_RESULT_REFERENCE_SOURCE
    && typeof artifact.file_path === 'string'
    && artifact.file_path.trim().length > 0;
}

function buildPeekArtifactReferencesFromTaskArtifacts(artifacts, extra = {}) {
  const refs = [];
  for (const artifact of artifacts || []) {
    if (!isPeekTaskArtifactRecord(artifact)) {
      continue;
    }

    const ref = normalizePeekArtifactReference({
      ...artifact.metadata,
      artifact_id: artifact.id,
      path: artifact.file_path,
      mime_type: artifact.mime_type || artifact.metadata.mime_type || null,
      task_id: artifact.task_id || artifact.metadata.task_id || extra.task_id || null,
      workflow_id: artifact.metadata.workflow_id || extra.workflow_id || null,
      task_label: artifact.metadata.task_label || extra.task_label || null,
      name: artifact.name || artifact.metadata.name || null,
    });
    if (ref) {
      refs.push(ref);
    }
  }
  return mergePeekArtifactReferences([], refs);
}

function formatPeekArtifactReferenceSection(refs, options = {}) {
  const normalizedRefs = mergePeekArtifactReferences([], refs);
  if (normalizedRefs.length === 0) {
    return '';
  }

  const heading = typeof options.heading === 'string' && options.heading.trim()
    ? options.heading.trim()
    : '### Bundle Artifacts';
  const lines = [heading];

  for (const ref of normalizedRefs) {
    const label = ref.task_label ? `${ref.task_label}: ` : '';
    const details = [];
    if (ref.artifact_id) {
      details.push(`artifact ${ref.artifact_id.substring(0, 8)}`);
    }
    if (ref.contract?.name && ref.contract?.version != null) {
      details.push(`${ref.contract.name} v${ref.contract.version}`);
    }
    const suffix = details.length > 0 ? ` (${details.join(', ')})` : '';
    lines.push(`- ${label}${ref.name || ref.kind || 'artifact'}: ${ref.path}${suffix}`);
  }

  return `\n${lines.join('\n')}\n`;
}

module.exports = {
  PEEK_AUTHORITATIVE_PACKAGE_ROOT,
  PEEK_AUTHORITATIVE_VERSION_SOURCE,
  PEEK_BUNDLE_CONTRACT: PEEK_INVESTIGATION_BUNDLE_CONTRACT,
  PEEK_BUNDLE_REFERENCE_COLLECTION_KEY,
  PEEK_BUNDLE_REFERENCE_METADATA_KEY,
  PEEK_CAPTURE_PROVIDERS,
  PEEK_SENSOR_TYPES,
  PROOF_SURFACE_CATALOG,
  PEEK_BUNDLE_REQUEST_FIELDS: PEEK_DIAGNOSE_REQUEST_FIELDS,
  PEEK_CAPABILITIES_CONTRACT,
  PEEK_CAPABILITIES_ROUTES,
  PEEK_CONTRACT_CATALOG,
  PEEK_CONTRACT_FIXTURE_DIR,
  PEEK_DIAGNOSE_REQUEST_FIELDS,
  PEEK_DIAGNOSE_TOOL_INPUT_KEYS,
  PEEK_FIRST_SLICE_APP_TYPES,
  PEEK_FIRST_SLICE_CANONICAL_HANDLER_NAME,
  PEEK_FIRST_SLICE_CANONICAL_TOOL_NAME,
  PEEK_FIRST_SLICE_HOST_PLATFORMS,
  PEEK_FIRST_SLICE_NAME,
  PEEK_INVESTIGATION_BUNDLE_CONTRACT,
  PEEK_PLATFORM_SUPPORT_MATRIX,
  attachPeekArtifactReferences,
  buildPeekArtifactReferencesFromTaskArtifacts,
  buildPeekBundleArtifactReferences,
  buildPeekContractCatalog,
  buildPeekDiagnosePayload,
  formatPeekArtifactReferenceSection,
  getCaptureProvidersForPlatform,
  getPeekBundleContractSummary,
  getPeekArtifactReferences,
  getPeekFirstSliceCanonicalEntry,
  isPlatformSupported,
  isPeekTaskArtifactRecord,
  loadPeekContractFixture,
  mergePeekArtifactReferences,
  normalizePeekHealthStatus,
  normalizePeekArtifactReference,
  validatePeekCapabilitiesEnvelope,
  validatePeekInvestigationBundleEnvelope,
};
