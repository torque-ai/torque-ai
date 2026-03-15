import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const PEEK_MODULE_PATH = require.resolve('../contracts/peek');

function loadPeekModuleWithInternals() {
  const source = fs.readFileSync(PEEK_MODULE_PATH, 'utf8');
  const requireFromModule = createRequire(PEEK_MODULE_PATH);
  const exportedModule = { exports: {} };
  const appendedSource = `
module.exports.__testInternals = {
  isPlainObject,
  normalizeCapturePlatform,
  expectObject,
  expectType,
  expectNullableType,
  expectEqual,
  expectStringList,
  validateImageBlob,
  qualify,
};
`;
  const compiled = new Function(
    'require',
    'module',
    'exports',
    '__filename',
    '__dirname',
    `${source}\n${appendedSource}`,
  );
  compiled(
    requireFromModule,
    exportedModule,
    exportedModule.exports,
    PEEK_MODULE_PATH,
    path.dirname(PEEK_MODULE_PATH),
  );
  return exportedModule.exports;
}

describe('contracts/peek', () => {
  let peek;
  let internals;
  let capabilitiesFixture;
  let bundleFixture;

  beforeEach(() => {
    vi.restoreAllMocks();
    peek = loadPeekModuleWithInternals();
    internals = peek.__testInternals;
    capabilitiesFixture = peek.loadPeekContractFixture('peek-capabilities-v1.json');
    bundleFixture = peek.loadPeekContractFixture('peek-investigation-bundle-v1.json');
  });

  describe('contract constants', () => {
    it('exports the capability, bundle, and catalog contracts with version 1', () => {
      expect(peek.PEEK_CAPABILITIES_CONTRACT).toEqual({
        name: 'peek_capabilities',
        version: 1,
      });
      expect(peek.PEEK_INVESTIGATION_BUNDLE_CONTRACT).toEqual({
        name: 'peek_investigation_bundle',
        version: 1,
      });
      expect(peek.PEEK_BUNDLE_CONTRACT).toBe(peek.PEEK_INVESTIGATION_BUNDLE_CONTRACT);
      expect(peek.PEEK_CONTRACT_CATALOG).toEqual({
        capabilities: peek.PEEK_CAPABILITIES_CONTRACT,
        investigation_bundle: peek.PEEK_INVESTIGATION_BUNDLE_CONTRACT,
      });
    });

    it('pins the authoritative version and fixture roots', () => {
      expect(peek.PEEK_AUTHORITATIVE_VERSION_SOURCE).toBe('peek_server.__version__');
      expect(peek.PEEK_AUTHORITATIVE_PACKAGE_ROOT).toBe('tools/peek-server');
      expect(peek.PEEK_CONTRACT_FIXTURE_DIR).toBe(
        path.join(path.dirname(PEEK_MODULE_PATH), '..', 'tests', 'fixtures', 'contracts'),
      );
      expect(fs.existsSync(peek.PEEK_CONTRACT_FIXTURE_DIR)).toBe(true);
    });

    it('keeps the capabilities routes frozen and aligned with the diagnose surface', () => {
      expect(peek.PEEK_CAPABILITIES_ROUTES).toEqual({
        health: '/health',
        investigation_bundle: '/diagnose',
      });
      expect(Object.isFrozen(peek.PEEK_CAPABILITIES_ROUTES)).toBe(true);
    });
  });

  describe('first-slice constants', () => {
    it('exports the first slice identity and canonical handler names', () => {
      expect(peek.PEEK_FIRST_SLICE_NAME).toBe('first');
      expect(peek.PEEK_FIRST_SLICE_CANONICAL_TOOL_NAME).toBe('peek_diagnose');
      expect(peek.PEEK_FIRST_SLICE_CANONICAL_HANDLER_NAME).toBe('handlePeekDiagnose');
    });

    it('exports the supported first-slice host platforms and app types', () => {
      expect(peek.PEEK_FIRST_SLICE_HOST_PLATFORMS).toEqual(['windows']);
      expect(peek.PEEK_FIRST_SLICE_APP_TYPES).toEqual(['wpf', 'win32', 'electron_webview']);
      expect(Object.isFrozen(peek.PEEK_FIRST_SLICE_HOST_PLATFORMS)).toBe(true);
      expect(Object.isFrozen(peek.PEEK_FIRST_SLICE_APP_TYPES)).toBe(true);
    });

    it('returns a canonical first-slice entry with a copied contract object', () => {
      const entry = peek.getPeekFirstSliceCanonicalEntry();

      expect(entry).toEqual({
        flow: 'diagnose_bundle',
        slice: 'first',
        tool_name: 'peek_diagnose',
        handler_name: 'handlePeekDiagnose',
        upstream_route: '/diagnose',
        contract: {
          name: 'peek_investigation_bundle',
          version: 1,
        },
      });
      expect(entry.contract).not.toBe(peek.PEEK_INVESTIGATION_BUNDLE_CONTRACT);
    });
  });

  describe('diagnose action field definitions', () => {
    it('exports the full tool input key list in the expected order', () => {
      expect(peek.PEEK_DIAGNOSE_TOOL_INPUT_KEYS).toEqual([
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
    });

    it('exports the supported request fields and aliases them through PEEK_BUNDLE_REQUEST_FIELDS', () => {
      expect(peek.PEEK_DIAGNOSE_REQUEST_FIELDS).toEqual([
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
      expect(peek.PEEK_BUNDLE_REQUEST_FIELDS).toBe(peek.PEEK_DIAGNOSE_REQUEST_FIELDS);
      expect(peek.PEEK_DIAGNOSE_REQUEST_FIELDS).not.toContain('host');
      expect(peek.PEEK_DIAGNOSE_REQUEST_FIELDS).not.toContain('timeout_seconds');
    });

    it('builds a process-mode payload and omits unsupported transport-only fields', () => {
      expect(peek.buildPeekDiagnosePayload({
        process: 'Taskmgr',
        host: 'omen',
        screenshot: false,
        annotate: true,
        elements: true,
        element_depth: 4,
        measurements: false,
        text_content: true,
        crop_element: 'Save',
        format: 'png',
        quality: 72,
        max_width: 1440,
        timeout_seconds: 45,
      })).toEqual({
        mode: 'process',
        name: 'Taskmgr',
        screenshot: false,
        annotate: true,
        elements: true,
        element_depth: 4,
        measurements: false,
        text_content: true,
        crop_element: 'Save',
        format: 'png',
        quality: 72,
        max_width: 1440,
      });
    });

    it('builds a title-mode payload and defaults annotate to true', () => {
      expect(peek.buildPeekDiagnosePayload({
        title: 'Calculator',
        elements: false,
      })).toEqual({
        mode: 'title',
        name: 'Calculator',
        annotate: true,
        elements: false,
      });
    });

    it('throws when neither process nor title is provided', () => {
      expect(() => peek.buildPeekDiagnosePayload({ annotate: false })).toThrow(
        'peek_diagnose requires process or title',
      );
    });
  });

  describe('PROOF_SURFACE_CATALOG', () => {
    it('defines the expected four proof surfaces and descriptions', () => {
      expect(peek.PROOF_SURFACE_CATALOG).toEqual({
        recovery_execution: 'Policy proof attached during recovery action execution',
        artifact_persistence: 'Policy proof attached when artifacts are persisted to storage',
        capture_analysis: 'Policy proof attached when capture analysis completes',
        bundle_creation: 'Policy proof attached when a peek evidence bundle is created',
      });
    });

    it('is frozen and every description is a non-empty sentence', () => {
      expect(Object.isFrozen(peek.PROOF_SURFACE_CATALOG)).toBe(true);
      for (const description of Object.values(peek.PROOF_SURFACE_CATALOG)) {
        expect(description).toEqual(expect.any(String));
        expect(description).toContain('Policy proof attached');
        expect(description.length).toBeGreaterThan(20);
      }
    });
  });

  describe('PEEK_SENSOR_TYPES', () => {
    it('exports a frozen catalog with frozen sensor entries and field lists', () => {
      expect(Object.keys(peek.PEEK_SENSOR_TYPES)).toEqual([
        'performance_counters',
        'accessibility_tree_diff',
      ]);
      expect(Object.isFrozen(peek.PEEK_SENSOR_TYPES)).toBe(true);
      expect(Object.isFrozen(peek.PEEK_SENSOR_TYPES.performance_counters)).toBe(true);
      expect(Object.isFrozen(peek.PEEK_SENSOR_TYPES.performance_counters.fields)).toBe(true);
      expect(Object.isFrozen(peek.PEEK_SENSOR_TYPES.accessibility_tree_diff)).toBe(true);
      expect(Object.isFrozen(peek.PEEK_SENSOR_TYPES.accessibility_tree_diff.fields)).toBe(true);
    });

    it('describes the performance counter evidence schema', () => {
      expect(peek.PEEK_SENSOR_TYPES.performance_counters).toEqual({
        name: 'performance_counters',
        description: 'Process CPU, memory, and handle metrics captured alongside the screenshot',
        fields: ['cpu_percent', 'memory_bytes', 'handle_count', 'thread_count', 'uptime_seconds'],
        optional: true,
      });
    });

    it('describes the accessibility tree diff evidence schema', () => {
      expect(peek.PEEK_SENSOR_TYPES.accessibility_tree_diff).toEqual({
        name: 'accessibility_tree_diff',
        description: 'UIA tree diff before and after a recovery action',
        fields: [
          'before_tree_hash',
          'after_tree_hash',
          'diff_summary',
          'nodes_added',
          'nodes_removed',
          'nodes_changed',
        ],
        optional: true,
      });
    });
  });

  describe('capture providers and platform support', () => {
    it('exports the full provider catalog with name-key alignment', () => {
      expect(Object.keys(peek.PEEK_CAPTURE_PROVIDERS)).toEqual([
        'win32',
        'x11',
        'wayland',
        'macos',
        'browser',
      ]);
      for (const [providerName, provider] of Object.entries(peek.PEEK_CAPTURE_PROVIDERS)) {
        expect(provider.name).toBe(providerName);
        expect(provider.platforms.length).toBeGreaterThan(0);
        expect(provider.capabilities.length).toBeGreaterThan(0);
      }
    });

    it('defines the expected win32 provider contract', () => {
      expect(peek.PEEK_CAPTURE_PROVIDERS.win32).toEqual({
        name: 'win32',
        description: 'Windows desktop capture via PrintWindow, DXGI, GDI',
        platforms: ['windows'],
        capabilities: ['window_capture', 'element_tree', 'accessibility', 'dpi_aware'],
        status: 'implemented',
      });
    });

    it('defines the expected browser provider contract', () => {
      expect(peek.PEEK_CAPTURE_PROVIDERS.browser).toEqual({
        name: 'browser',
        description: 'Browser capture via Chrome DevTools Protocol (Playwright/Puppeteer)',
        platforms: ['windows', 'linux', 'darwin'],
        capabilities: ['window_capture', 'dom_tree', 'network_interception'],
        status: 'planned',
      });
    });

    it('defines windows as the only currently supported first-slice platform', () => {
      expect(peek.PEEK_PLATFORM_SUPPORT_MATRIX.windows).toEqual({
        supported: true,
        providers: ['win32', 'browser'],
        app_types: ['wpf', 'win32', 'electron_webview', 'winforms', 'qt'],
        slice: 'first',
      });
      expect(peek.PEEK_PLATFORM_SUPPORT_MATRIX.linux).toMatchObject({
        supported: false,
        prerequisite: 'DS-06',
      });
      expect(peek.PEEK_PLATFORM_SUPPORT_MATRIX.darwin).toMatchObject({
        supported: false,
        prerequisite: 'DS-06',
      });
    });

    it('normalizes platform names when returning provider objects', () => {
      expect(peek.getCaptureProvidersForPlatform('  WINDOWS  ').map((provider) => provider.name)).toEqual([
        'win32',
        'browser',
      ]);
      expect(peek.getCaptureProvidersForPlatform('Linux').map((provider) => provider.name)).toEqual([
        'x11',
        'wayland',
        'browser',
      ]);
    });

    it('returns no providers for unsupported or unknown platforms', () => {
      expect(peek.getCaptureProvidersForPlatform('freebsd')).toEqual([]);
      expect(peek.getCaptureProvidersForPlatform(null)).toEqual([]);
    });

    it('reports platform support using the normalized support matrix keys', () => {
      expect(peek.isPlatformSupported(' windows ')).toBe(true);
      expect(peek.isPlatformSupported('LINUX')).toBe(false);
      expect(peek.isPlatformSupported('freebsd')).toBe(false);
      expect(peek.isPlatformSupported(undefined)).toBe(false);
    });
  });

  describe('loadPeekContractFixture', () => {
    it('loads the published capabilities fixture from the contract fixture directory', () => {
      const readFileSpy = vi.spyOn(fs, 'readFileSync');
      const payload = peek.loadPeekContractFixture('peek-capabilities-v1.json');

      expect(readFileSpy).toHaveBeenCalledWith(
        path.join(peek.PEEK_CONTRACT_FIXTURE_DIR, 'peek-capabilities-v1.json'),
        'utf8',
      );
      expect(payload.contract).toEqual(peek.PEEK_CAPABILITIES_CONTRACT);
    });

    it('loads the published bundle fixture from the contract fixture directory', () => {
      const payload = peek.loadPeekContractFixture('peek-investigation-bundle-v1.json');

      expect(payload.contract).toEqual(peek.PEEK_INVESTIGATION_BUNDLE_CONTRACT);
      expect(payload.request.route).toBe('/diagnose');
    });

    it('throws when the fixture file is missing', () => {
      expect(() => peek.loadPeekContractFixture('missing-fixture.json')).toThrow();
    });
  });

  describe('buildPeekContractCatalog', () => {
    it('returns a value-equal catalog that matches the exported catalog constants', () => {
      expect(peek.buildPeekContractCatalog()).toEqual(peek.PEEK_CONTRACT_CATALOG);
    });

    it('returns fresh top-level and contract objects on each call', () => {
      const first = peek.buildPeekContractCatalog();
      const second = peek.buildPeekContractCatalog();

      expect(first).not.toBe(second);
      expect(first.capabilities).not.toBe(second.capabilities);
      expect(first.investigation_bundle).not.toBe(second.investigation_bundle);

      first.capabilities.version = 2;
      expect(second.capabilities.version).toBe(1);
    });
  });

  describe('normalizePeekHealthStatus', () => {
    it('maps missing, empty, and ok statuses to healthy', () => {
      expect(peek.normalizePeekHealthStatus(undefined)).toBe('healthy');
      expect(peek.normalizePeekHealthStatus({ status: '  ' })).toBe('healthy');
      expect(peek.normalizePeekHealthStatus({ status: 'ok' })).toBe('healthy');
    });

    it('trims and lowercases non-ok statuses', () => {
      expect(peek.normalizePeekHealthStatus({ status: ' DEGRADED ' })).toBe('degraded');
      expect(peek.normalizePeekHealthStatus({ status: 'Unhealthy' })).toBe('unhealthy');
    });
  });

  describe('test-only internal helpers', () => {
    describe('isPlainObject', () => {
      it('returns true only for plain non-array objects', () => {
        expect(internals.isPlainObject({ a: 1 })).toBe(true);
        expect(internals.isPlainObject(Object.create(null))).toBe(true);
        expect(internals.isPlainObject([])).toBe(false);
        expect(internals.isPlainObject(null)).toBe(false);
        expect(internals.isPlainObject('value')).toBe(false);
      });
    });

    describe('normalizeCapturePlatform', () => {
      it('normalizes string inputs and collapses non-strings to empty strings', () => {
        expect(internals.normalizeCapturePlatform('  WINDOWS  ')).toBe('windows');
        expect(internals.normalizeCapturePlatform('Darwin')).toBe('darwin');
        expect(internals.normalizeCapturePlatform(42)).toBe('');
        expect(internals.normalizeCapturePlatform(null)).toBe('');
      });
    });

    describe('expectObject', () => {
      it('returns the object when the key contains a plain object', () => {
        const errors = [];
        const value = internals.expectObject({ contract: { version: 1 } }, 'contract', errors, 'payload');

        expect(value).toEqual({ version: 1 });
        expect(errors).toEqual([]);
      });

      it('pushes a qualified error when the key is not a plain object', () => {
        const errors = [];
        const value = internals.expectObject({ contract: [] }, 'contract', errors, 'payload');

        expect(value).toBeNull();
        expect(errors).toEqual(['payload.contract must be an object']);
      });
    });

    describe('expectType', () => {
      it('pushes an error when the value has the wrong type', () => {
        const errors = [];
        internals.expectType({ runtime_version: 19 }, 'runtime_version', 'string', errors, 'versioning');

        expect(errors).toEqual(['versioning.runtime_version must be a string']);
      });
    });

    describe('expectNullableType', () => {
      it('allows null and undefined but rejects the wrong non-null type', () => {
        const errors = [];

        internals.expectNullableType({ bundle_path: null }, 'bundle_path', 'string', errors, 'artifacts');
        internals.expectNullableType({ bundle_path: undefined }, 'bundle_path', 'string', errors, 'artifacts');
        internals.expectNullableType({ bundle_path: 123 }, 'bundle_path', 'string', errors, 'artifacts');

        expect(errors).toEqual(['artifacts.bundle_path must be a string or null']);
      });
    });

    describe('expectEqual', () => {
      it('pushes a JSON-stringified equality error when a value differs', () => {
        const errors = [];
        internals.expectEqual({ route: '/peek' }, 'route', '/diagnose', errors, 'request');

        expect(errors).toEqual(['request.route must equal "/diagnose"']);
      });
    });

    describe('expectStringList', () => {
      it('pushes an error when the value is not a list of strings', () => {
        const errors = [];
        internals.expectStringList({ routes: ['/diagnose', 1] }, 'routes', errors, 'feature');

        expect(errors).toEqual(['feature.routes must be a list of strings']);
      });
    });

    describe('validateImageBlob', () => {
      it('accepts a valid image blob payload', () => {
        const errors = [];
        internals.validateImageBlob({
          screenshot: {
            present: true,
            encoding: 'base64',
            mime_type: 'image/png',
            data: 'YWJj',
          },
        }, 'screenshot', errors);

        expect(errors).toEqual([]);
      });

      it('collects every type error for an invalid image blob payload', () => {
        const errors = [];
        internals.validateImageBlob({
          screenshot: {
            present: 'yes',
            encoding: 1,
            mime_type: 2,
            data: 3,
          },
        }, 'screenshot', errors);

        expect(errors).toEqual([
          'evidence.screenshot.present must be a bool',
          'evidence.screenshot.encoding must be a string or null',
          'evidence.screenshot.mime_type must be a string or null',
          'evidence.screenshot.data must be a string or null',
        ]);
      });
    });

    describe('qualify', () => {
      it('prefixes nested keys and leaves root keys untouched', () => {
        expect(internals.qualify('runtime', 'version')).toBe('runtime.version');
        expect(internals.qualify('', 'version')).toBe('version');
      });
    });
  });

  describe('validatePeekCapabilitiesEnvelope', () => {
    it('accepts the published capabilities fixture', () => {
      expect(peek.validatePeekCapabilitiesEnvelope(capabilitiesFixture)).toEqual([]);
    });

    it('rejects non-object payloads', () => {
      expect(peek.validatePeekCapabilitiesEnvelope(null)).toEqual(['payload must be an object']);
    });

    it('reports contract, slice, routes, versioning, and feature schema violations', () => {
      capabilitiesFixture.contract.name = 'wrong_contract';
      capabilitiesFixture.contract.version = '1';
      capabilitiesFixture.slice.name = 'second';
      capabilitiesFixture.slice.supported_host_platforms = 'windows';
      capabilitiesFixture.slice.supported_app_types = ['wpf', 1];
      capabilitiesFixture.routes.health = '/ready';
      capabilitiesFixture.routes.investigation_bundle = 5;
      capabilitiesFixture.versioning.runtime_version = 19;
      capabilitiesFixture.versioning.version_source = 'other';
      capabilitiesFixture.versioning.package_root = 'wrong/root';
      capabilitiesFixture.features.window_process_discovery = 'supported';
      capabilitiesFixture.features.screenshot_capture = {
        status: true,
        routes: ['/peek', 5],
        backlog_id: 9,
        persisted_artifacts: 'yes',
      };

      const errors = peek.validatePeekCapabilitiesEnvelope(capabilitiesFixture);

      expect(errors).toContain('contract.name must equal "peek_capabilities"');
      expect(errors).toContain('contract.version must equal 1');
      expect(errors).toContain('slice.name must equal "first"');
      expect(errors).toContain('slice.supported_host_platforms must be a list of strings');
      expect(errors).toContain('slice.supported_app_types must be a list of strings');
      expect(errors).toContain('routes.health must equal "/health"');
      expect(errors).toContain('routes.investigation_bundle must equal "/diagnose"');
      expect(errors).toContain('versioning.runtime_version must be a string');
      expect(errors).toContain('versioning.version_source must equal "peek_server.__version__"');
      expect(errors).toContain('versioning.package_root must equal "tools/peek-server"');
      expect(errors).toContain('features.window_process_discovery must be an object');
      expect(errors).toContain('features.screenshot_capture.status must be a string');
      expect(errors).toContain('features.screenshot_capture.routes must be a list of strings');
      expect(errors).toContain('features.screenshot_capture.backlog_id must be a string');
      expect(errors).toContain('features.screenshot_capture.persisted_artifacts must be a boolean');
    });
  });

  describe('validatePeekInvestigationBundleEnvelope', () => {
    it('accepts the published bundle fixture', () => {
      expect(peek.validatePeekInvestigationBundleEnvelope(bundleFixture)).toEqual([]);
    });

    it('rejects non-object payloads', () => {
      expect(peek.validatePeekInvestigationBundleEnvelope(null)).toEqual(['payload must be an object']);
    });

    it('reports invalid top-level, contract, runtime, and request fields', () => {
      bundleFixture.kind = 'capture';
      bundleFixture.slice = 'second';
      bundleFixture.created_at = 1;
      bundleFixture.contract.name = 'wrong_bundle';
      bundleFixture.contract.version = '1';
      bundleFixture.runtime.name = 'other-runtime';
      bundleFixture.runtime.version = 19;
      bundleFixture.runtime.platform = 42;
      bundleFixture.runtime.package_root = 'bad/root';
      bundleFixture.request.route = '/peek';
      bundleFixture.request.options = [];

      const errors = peek.validatePeekInvestigationBundleEnvelope(bundleFixture);

      expect(errors).toContain('kind must equal "diagnose"');
      expect(errors).toContain('slice must equal "first"');
      expect(errors).toContain('created_at must be a string');
      expect(errors).toContain('contract.name must equal "peek_investigation_bundle"');
      expect(errors).toContain('contract.version must equal 1');
      expect(errors).toContain('runtime.name must equal "peek-server"');
      expect(errors).toContain('runtime.version must be a string');
      expect(errors).toContain('runtime.platform must be a string');
      expect(errors).toContain('runtime.package_root must equal "tools/peek-server"');
      expect(errors).toContain('request.route must equal "/diagnose"');
      expect(errors).toContain('request.options must be an object');
    });

    it('reports invalid target, result, and artifact fields', () => {
      bundleFixture.target.hwnd = '1001';
      bundleFixture.target.locator = {
        type: 5,
      };
      bundleFixture.result.success = 'yes';
      bundleFixture.result.error = 404;
      bundleFixture.result.warnings = 'none';
      bundleFixture.artifacts.persisted = 'true';
      bundleFixture.artifacts.bundle_path = 7;
      bundleFixture.artifacts.artifact_report_path = {};
      bundleFixture.artifacts.signed = 'false';

      const errors = peek.validatePeekInvestigationBundleEnvelope(bundleFixture);

      expect(errors).toContain('target.hwnd must be a number');
      expect(errors).toContain('target.locator.type must be a string');
      expect(errors).toContain('target.locator.value is required');
      expect(errors).toContain('result.success must be a boolean');
      expect(errors).toContain('result.error must be a string or null');
      expect(errors).toContain('result.warnings must be a list');
      expect(errors).toContain('artifacts.persisted must be a boolean');
      expect(errors).toContain('artifacts.bundle_path must be a string or null');
      expect(errors).toContain('artifacts.artifact_report_path must be a string or null');
      expect(errors).toContain('artifacts.signed must be a boolean');
    });

    it('reports invalid evidence structures and image blob fields', () => {
      bundleFixture.evidence.screenshot.present = 'yes';
      bundleFixture.evidence.screenshot.encoding = 1;
      bundleFixture.evidence.annotated_screenshot = 'invalid';
      bundleFixture.evidence.elements.count = 'two';
      bundleFixture.evidence.elements.tree = 'tree';
      bundleFixture.evidence.measurements = [];
      bundleFixture.evidence.text_content = [];
      bundleFixture.evidence.annotation_index = 'bad-index';

      const errors = peek.validatePeekInvestigationBundleEnvelope(bundleFixture);

      expect(errors).toContain('evidence.screenshot.present must be a bool');
      expect(errors).toContain('evidence.screenshot.encoding must be a string or null');
      expect(errors).toContain('evidence.annotated_screenshot must be an object');
      expect(errors).toContain('evidence.elements.count must be a number');
      expect(errors).toContain('evidence.elements.tree must be a list');
      expect(errors).toContain('evidence.measurements must be an object or null');
      expect(errors).toContain('evidence.text_content must be an object or null');
      expect(errors).toContain('evidence.annotation_index must be a list');
    });
  });

  describe('getPeekBundleContractSummary', () => {
    it('extracts the normalized contract summary from a valid bundle', () => {
      expect(peek.getPeekBundleContractSummary(bundleFixture)).toEqual({
        name: 'peek_investigation_bundle',
        version: 1,
        slice: 'first',
        created_at: '2026-03-10T00:00:00Z',
        persisted: false,
        signed: false,
      });
    });

    it('returns null when the bundle or contract is missing', () => {
      expect(peek.getPeekBundleContractSummary(null)).toBeNull();
      expect(peek.getPeekBundleContractSummary({})).toBeNull();
    });
  });

  describe('artifact reference helpers', () => {
    describe('normalizePeekArtifactReference', () => {
      it('normalizes paths, default names, source, and contract summaries', () => {
        expect(peek.normalizePeekArtifactReference({
          kind: 'bundle_json',
          path: '  C:/artifacts/bundle.json  ',
          contract: {
            name: 'peek_investigation_bundle',
            version: 1,
            slice: 'first',
            created_at: '2026-03-10T00:00:00Z',
            persisted: true,
            signed: false,
          },
        })).toEqual({
          source: 'peek_diagnose',
          kind: 'bundle_json',
          name: 'bundle.json',
          path: 'C:/artifacts/bundle.json',
          mime_type: null,
          artifact_id: null,
          task_id: null,
          workflow_id: null,
          host: null,
          target: null,
          task_label: null,
          contract: {
            name: 'peek_investigation_bundle',
            version: 1,
            slice: 'first',
            created_at: '2026-03-10T00:00:00Z',
            persisted: true,
            signed: false,
          },
        });
      });

      it('returns null for non-objects or blank paths', () => {
        expect(peek.normalizePeekArtifactReference(null)).toBeNull();
        expect(peek.normalizePeekArtifactReference({ path: '   ' })).toBeNull();
      });
    });

    describe('buildPeekBundleArtifactReferences', () => {
      it('builds bundle and artifact report references from a persisted bundle', () => {
        bundleFixture.artifacts.persisted = true;
        bundleFixture.artifacts.bundle_path = 'C:/artifacts/bundle.json';
        bundleFixture.artifacts.artifact_report_path = 'C:/artifacts/artifact-report.json';
        bundleFixture.artifacts.signed = true;

        expect(peek.buildPeekBundleArtifactReferences(bundleFixture, {
          artifact_id: 'artifact-1',
          task_id: 'task-1',
          workflow_id: 'wf-1',
          host: 'omen',
          target: 'Calculator',
          task_label: 'diagnose',
        })).toEqual([
          expect.objectContaining({
            kind: 'bundle_json',
            name: 'bundle.json',
            path: 'C:/artifacts/bundle.json',
            artifact_id: 'artifact-1',
            task_id: 'task-1',
            workflow_id: 'wf-1',
            host: 'omen',
            target: 'Calculator',
            task_label: 'diagnose',
            contract: expect.objectContaining({
              name: 'peek_investigation_bundle',
              signed: true,
            }),
          }),
          expect.objectContaining({
            kind: 'artifact_report',
            name: 'artifact-report.json',
            path: 'C:/artifacts/artifact-report.json',
          }),
        ]);
      });

      it('returns no references when the bundle has no persisted artifact paths', () => {
        expect(peek.buildPeekBundleArtifactReferences(bundleFixture)).toEqual([]);
        expect(peek.buildPeekBundleArtifactReferences({ artifacts: null })).toEqual([]);
      });
    });

    describe('mergePeekArtifactReferences', () => {
      it('deduplicates references on kind, artifact id, path, task id, and workflow id', () => {
        const merged = peek.mergePeekArtifactReferences(
          [
            { kind: 'bundle_json', artifact_id: 'artifact-1', path: 'C:/bundle.json', task_id: 'task-1' },
          ],
          [
            { kind: 'bundle_json', artifact_id: 'artifact-1', path: 'C:/bundle.json', task_id: 'task-1' },
            { kind: 'artifact_report', artifact_id: 'artifact-1', path: 'C:/artifact-report.json', task_id: 'task-1' },
          ],
        );

        expect(merged).toHaveLength(2);
        expect(merged.map((ref) => ref.kind)).toEqual(['bundle_json', 'artifact_report']);
      });

      it('filters invalid references while normalizing valid ones', () => {
        expect(peek.mergePeekArtifactReferences(
          [{ path: '   ' }],
          [{ kind: 'bundle_json', path: ' C:/bundle.json ' }],
        )).toEqual([
          expect.objectContaining({
            kind: 'bundle_json',
            path: 'C:/bundle.json',
          }),
        ]);
      });
    });

    describe('getPeekArtifactReferences', () => {
      it('extracts and normalizes references from the peek metadata block', () => {
        const refs = peek.getPeekArtifactReferences({
          peek: {
            bundle_references: [
              { kind: 'bundle_json', path: ' C:/bundle.json ' },
              { kind: 'bundle_json', path: 'C:/bundle.json' },
            ],
          },
        });

        expect(refs).toEqual([
          expect.objectContaining({
            kind: 'bundle_json',
            path: 'C:/bundle.json',
          }),
        ]);
      });

      it('returns an empty list when the container does not expose peek metadata', () => {
        expect(peek.getPeekArtifactReferences(null)).toEqual([]);
        expect(peek.getPeekArtifactReferences({ peek: {} })).toEqual([]);
      });
    });

    describe('attachPeekArtifactReferences', () => {
      it('merges references into a cloned container while preserving unrelated metadata', () => {
        const container = {
          existing: true,
          peek: {
            bundle_references: [
              { kind: 'bundle_json', path: 'C:/bundle.json' },
            ],
            retained: 'value',
          },
        };

        const next = peek.attachPeekArtifactReferences(container, [
          { kind: 'bundle_json', path: 'C:/bundle.json' },
          { kind: 'artifact_report', path: 'C:/artifact-report.json' },
        ]);

        expect(next).not.toBe(container);
        expect(next.peek).not.toBe(container.peek);
        expect(next.peek.retained).toBe('value');
        expect(next.peek.bundle_references).toHaveLength(2);
        expect(container.peek.bundle_references).toHaveLength(1);
      });

      it('returns a shallow clone of the base container when there are no normalized refs', () => {
        const container = { existing: true };
        const next = peek.attachPeekArtifactReferences(container, [{ path: '   ' }]);

        expect(next).toEqual(container);
        expect(next).not.toBe(container);
      });
    });

    describe('isPeekTaskArtifactRecord', () => {
      it('returns true only for task artifacts with peek metadata and a file path', () => {
        expect(peek.isPeekTaskArtifactRecord({
          metadata: { source: 'peek_diagnose' },
          file_path: 'C:/bundle.json',
        })).toBe(true);
        expect(peek.isPeekTaskArtifactRecord({
          metadata: { source: 'other' },
          file_path: 'C:/bundle.json',
        })).toBe(false);
        expect(peek.isPeekTaskArtifactRecord({
          metadata: { source: 'peek_diagnose' },
          file_path: '   ',
        })).toBe(false);
      });
    });

    describe('buildPeekArtifactReferencesFromTaskArtifacts', () => {
      it('maps valid task artifacts to normalized references and deduplicates them', () => {
        const refs = peek.buildPeekArtifactReferencesFromTaskArtifacts([
          {
            id: 'artifact-1',
            task_id: 'task-1',
            name: 'bundle.json',
            file_path: 'C:/bundle.json',
            mime_type: 'application/json',
            metadata: {
              source: 'peek_diagnose',
              kind: 'bundle_json',
              host: 'omen',
              target: 'Calculator',
              workflow_id: 'wf-1',
              task_label: 'diagnose',
              contract: {
                name: 'peek_investigation_bundle',
                version: 1,
              },
            },
          },
          {
            id: 'artifact-1',
            task_id: 'task-1',
            file_path: 'C:/bundle.json',
            metadata: {
              source: 'peek_diagnose',
              kind: 'bundle_json',
              workflow_id: 'wf-1',
            },
          },
        ]);

        expect(refs).toEqual([
          expect.objectContaining({
            artifact_id: 'artifact-1',
            kind: 'bundle_json',
            name: 'bundle.json',
            path: 'C:/bundle.json',
            task_id: 'task-1',
            workflow_id: 'wf-1',
            host: 'omen',
            target: 'Calculator',
            task_label: 'diagnose',
          }),
        ]);
      });

      it('ignores invalid artifacts and uses extra fallbacks for missing ids', () => {
        const refs = peek.buildPeekArtifactReferencesFromTaskArtifacts([
          {
            id: 'artifact-2',
            task_id: null,
            file_path: 'C:/report.json',
            metadata: {
              source: 'peek_diagnose',
              kind: 'artifact_report',
            },
          },
          {
            id: 'artifact-ignored',
            task_id: 'task-2',
            file_path: '',
            metadata: {
              source: 'peek_diagnose',
            },
          },
        ], {
          task_id: 'task-fallback',
          workflow_id: 'wf-fallback',
          task_label: 'peek-report',
        });

        expect(refs).toEqual([
          expect.objectContaining({
            artifact_id: 'artifact-2',
            kind: 'artifact_report',
            task_id: 'task-fallback',
            workflow_id: 'wf-fallback',
            task_label: 'peek-report',
          }),
        ]);
      });
    });

    describe('formatPeekArtifactReferenceSection', () => {
      it('returns an empty string when no references survive normalization', () => {
        expect(peek.formatPeekArtifactReferenceSection([])).toBe('');
        expect(peek.formatPeekArtifactReferenceSection([{ path: '   ' }])).toBe('');
      });

      it('renders a markdown section with heading, task labels, artifact ids, and contract versions', () => {
        const section = peek.formatPeekArtifactReferenceSection([
          {
            kind: 'bundle_json',
            name: 'bundle.json',
            path: 'C:/bundle.json',
            artifact_id: '12345678-90ab-cdef',
            task_label: 'diagnose',
            contract: {
              name: 'peek_investigation_bundle',
              version: 1,
            },
          },
        ], {
          heading: '### Peek Bundle Refs',
        });

        expect(section).toBe(
          '\n### Peek Bundle Refs\n- diagnose: bundle.json: C:/bundle.json (artifact 12345678, peek_investigation_bundle v1)\n',
        );
      });
    });
  });
});
