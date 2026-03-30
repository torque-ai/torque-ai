'use strict';

const { ErrorCodes, makeError } = require('../../../handlers/shared');
const {
  PEEK_FIRST_SLICE_APP_TYPES,
  PEEK_FIRST_SLICE_CANONICAL_TOOL_NAME,
  PEEK_FIRST_SLICE_HOST_PLATFORMS,
} = require('../../../contracts/peek');
const { resolvePeekHost, peekHttpGetWithRetry } = require('./shared');
const logger = require('../../../logger').child({ component: 'peek-onboarding' });

// ── Reference app-type catalog ──────────────────────────────────────────────

const APP_TYPE_CATALOG = Object.freeze({
  wpf: Object.freeze({
    label: 'WPF (Windows Presentation Foundation)',
    framework: 'WPF / .NET',
    detection_hint: 'HwndWrapper class names, UIAutomation tree with XAML control types',
    capabilities: Object.freeze({
      screenshot: true,
      annotated_screenshot: true,
      element_tree: true,
      text_content: true,
      measurements: true,
      automation_id: true,
      devtools_protocol: false,
      dom_snapshot: false,
    }),
    recommended_options: Object.freeze({
      elements: true,
      annotate: true,
      text_content: true,
      measurements: true,
      element_depth: 5,
    }),
    notes: 'Best coverage via UIAutomation. Set element_depth ≥ 5 for deep XAML trees.',
  }),
  win32: Object.freeze({
    label: 'Win32 / Native',
    framework: 'Win32 / MFC / ATL',
    detection_hint: 'Standard Win32 class names (Button, Edit, ListBox, #32770)',
    capabilities: Object.freeze({
      screenshot: true,
      annotated_screenshot: true,
      element_tree: true,
      text_content: true,
      measurements: true,
      automation_id: false,
      devtools_protocol: false,
      dom_snapshot: false,
    }),
    recommended_options: Object.freeze({
      elements: true,
      annotate: true,
      text_content: true,
      measurements: true,
      element_depth: 4,
    }),
    notes: 'Element tree may be shallow for owner-draw controls. OCR fallback recommended for custom-rendered content.',
  }),
  electron_webview: Object.freeze({
    label: 'Electron / WebView2',
    framework: 'Chromium-based (Electron, WebView2, CEF)',
    detection_hint: 'Chrome_WidgetWin_1 class name, DevTools Protocol available on debug port',
    capabilities: Object.freeze({
      screenshot: true,
      annotated_screenshot: true,
      element_tree: true,
      text_content: true,
      measurements: true,
      automation_id: false,
      devtools_protocol: true,
      dom_snapshot: true,
    }),
    recommended_options: Object.freeze({
      elements: true,
      annotate: true,
      text_content: true,
      measurements: true,
      element_depth: 6,
    }),
    notes: 'DOM snapshot provides richer structure than UIAutomation for web content. Enable DevTools Protocol for full inspection.',
  }),
});

// ── Handlers ────────────────────────────────────────────────────────────────

function handlePeekOnboard(args = {}) {
  const requestedType = typeof args.app_type === 'string' ? args.app_type.trim().toLowerCase() : null;

  if (requestedType && !APP_TYPE_CATALOG[requestedType]) {
    return makeError(
      ErrorCodes.INVALID_PARAM,
      `Unknown app type '${requestedType}'. Supported: ${PEEK_FIRST_SLICE_APP_TYPES.join(', ')}`,
    );
  }

  const types = requestedType
    ? { [requestedType]: APP_TYPE_CATALOG[requestedType] }
    : { ...APP_TYPE_CATALOG };

  const entries = Object.entries(types).map(([key, spec]) => ({
    app_type: key,
    label: spec.label,
    framework: spec.framework,
    detection_hint: spec.detection_hint,
    capabilities: { ...spec.capabilities },
    recommended_options: { ...spec.recommended_options },
    notes: spec.notes,
  }));

  return {
    success: true,
    slice: 'first',
    supported_platforms: [...PEEK_FIRST_SLICE_HOST_PLATFORMS],
    canonical_tool: PEEK_FIRST_SLICE_CANONICAL_TOOL_NAME,
    app_types: entries,
    onboarding_steps: [
      `1. Ensure a peek host is registered and healthy (use list_peek_hosts or peek_health_all).`,
      `2. Launch the target application on the peek host.`,
      `3. Run ${PEEK_FIRST_SLICE_CANONICAL_TOOL_NAME} with the process name to capture a diagnostic bundle.`,
      `4. Review the bundle's app_type to confirm framework detection.`,
      `5. Check evidence_sufficiency — if insufficient, adjust options or use peek_recovery.`,
      `6. Use peek_semantic_diff for ongoing regression detection against a baseline.`,
    ],
  };
}

async function handlePeekOnboardDetect(args = {}) {
  try {
    const resolvedHost = resolvePeekHost(args);
    if (resolvedHost.error) {
      return resolvedHost.error;
    }
    const { hostUrl } = resolvedHost;

    const process = typeof args.process === 'string' ? args.process.trim() : '';
    const title = typeof args.title === 'string' ? args.title.trim() : '';
    if (!process && !title) {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'Either process or title is required to detect app type.');
    }

    const timeoutMs = Number(args.timeout_seconds) > 0 ? args.timeout_seconds * 1000 : 15000;
    const query = process ? `process=${encodeURIComponent(process)}` : `title=${encodeURIComponent(title)}`;
    let windowInfo;
    try {
      windowInfo = await peekHttpGetWithRetry(`${hostUrl}/windows?${query}`, timeoutMs);
    } catch (err) {
      return makeError(ErrorCodes.OPERATION_FAILED, `Failed to query peek host: ${err.message}`);
    }

    if (windowInfo.error) {
      return makeError(ErrorCodes.OPERATION_FAILED, `Peek host error: ${windowInfo.error}`);
    }

    const windows = Array.isArray(windowInfo.data?.windows) ? windowInfo.data.windows
      : Array.isArray(windowInfo.data) ? windowInfo.data
      : [];

    if (windows.length === 0) {
      return {
        success: false,
        detected: false,
        message: `No windows found matching ${process ? `process '${process}'` : `title '${title}'`}.`,
        suggestion: 'Ensure the application is running on the peek host, then retry.',
      };
    }

    const win = windows[0];
    const className = typeof win.class_name === 'string' ? win.class_name : '';
    const detectedType = detectAppTypeFromClassName(className);
    const catalog = detectedType ? APP_TYPE_CATALOG[detectedType] : null;

    return {
      success: true,
      detected: !!detectedType,
      window: {
        title: win.title || win.window_title || '',
        process: win.process_name || process,
        class_name: className,
        hwnd: win.hwnd || null,
      },
      app_type: detectedType || 'unknown',
      catalog: catalog ? {
        label: catalog.label,
        framework: catalog.framework,
        capabilities: { ...catalog.capabilities },
        recommended_options: { ...catalog.recommended_options },
        notes: catalog.notes,
      } : null,
      next_step: detectedType
        ? `Run ${PEEK_FIRST_SLICE_CANONICAL_TOOL_NAME} with process '${win.process_name || process}' to capture a full diagnostic bundle.`
        : 'App type could not be auto-detected. Run peek_diagnose anyway — the peek server will classify the app type from the capture.',
    };
  } catch (err) {
    logger.warn(`Onboard detect failed: ${err.message}`);
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message);
  }
}

function detectAppTypeFromClassName(className) {
  if (!className) return null;
  if (/HwndWrapper\[/.test(className)) return 'wpf';
  if (/Chrome_WidgetWin_|Electron|CefBrowser/i.test(className)) return 'electron_webview';
  // Common Win32 class names
  if (/^#32770$|^Button$|^Edit$|^ListBox$|^ComboBox$|^Static$|^SysListView32$|^SysTreeView32$/i.test(className)) {
    return 'win32';
  }
  return null;
}

module.exports = {
  APP_TYPE_CATALOG,
  detectAppTypeFromClassName,
  handlePeekOnboard,
  handlePeekOnboardDetect,
};
