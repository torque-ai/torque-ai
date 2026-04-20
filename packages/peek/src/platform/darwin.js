'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const BasePlatformAdapter = require('./base');

const OSASCRIPT_ARGS = Object.freeze(['-l', 'JavaScript', '-e']);
const DEFAULT_CAPABILITIES = Object.freeze(['capture', 'compare', 'interact', 'launch', 'windows']);
const MIME_TYPES = Object.freeze({
  png: 'image/png',
  jpeg: 'image/jpeg',
});

const LIST_WINDOWS_SCRIPT = `
ObjC.import('stdlib');

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function readWindowId(windowRef) {
  try {
    const id = toNumber(windowRef.id());
    return id === null ? undefined : id;
  } catch (_) {
    return undefined;
  }
}

function normalizeGeometry(position, size) {
  const x = toNumber(position && position[0]);
  const y = toNumber(position && position[1]);
  const width = toNumber(size && size[0]);
  const height = toNumber(size && size[1]);

  if (x === null || y === null || width === null || height === null) return null;
  if (width <= 0 || height <= 0) return null;

  return { x, y, width, height };
}

function listWindows() {
  const systemEvents = Application('System Events');
  const windows = [];

  for (const processRef of systemEvents.applicationProcesses()) {
    try {
      if (!processRef.visible()) continue;
      const processName = String(processRef.name() || '');
      const pid = toNumber(processRef.unixId());

      for (const windowRef of processRef.windows()) {
        try {
          const title = String(windowRef.name() || '');
          const geometry = normalizeGeometry(windowRef.position(), windowRef.size());
          if (!geometry) continue;

          const entry = {
            title,
            process: processName,
            pid,
            geometry,
          };
          const id = readWindowId(windowRef);
          if (id !== undefined) entry.id = id;
          windows.push(entry);
        } catch (_) {}
      }
    } catch (_) {}
  }

  return windows;
}

JSON.stringify({ platform: 'darwin', windows: listWindows() });
`;

const RESOLVE_WINDOW_SCRIPT = `
ObjC.import('stdlib');
ObjC.import('Foundation');

function readInput() {
  const raw = $.getenv('PEEK_INPUT');
  if (!raw) return {};
  return JSON.parse(ObjC.unwrap($.NSString.stringWithUTF8String(raw)));
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function readWindowId(windowRef) {
  try {
    const id = toNumber(windowRef.id());
    return id === null ? undefined : id;
  } catch (_) {
    return undefined;
  }
}

function normalizeGeometry(position, size) {
  const x = toNumber(position && position[0]);
  const y = toNumber(position && position[1]);
  const width = toNumber(size && size[0]);
  const height = toNumber(size && size[1]);

  if (x === null || y === null || width === null || height === null) return null;
  if (width <= 0 || height <= 0) return null;

  return { x, y, width, height };
}

function collectWindows() {
  const systemEvents = Application('System Events');
  const windows = [];

  for (const processRef of systemEvents.applicationProcesses()) {
    try {
      if (!processRef.visible()) continue;
      const processName = String(processRef.name() || '');
      const pid = toNumber(processRef.unixId());

      for (const windowRef of processRef.windows()) {
        try {
          const title = String(windowRef.name() || '');
          const geometry = normalizeGeometry(windowRef.position(), windowRef.size());
          if (!geometry) continue;

          const entry = {
            title,
            process: processName,
            pid,
            geometry,
          };
          const id = readWindowId(windowRef);
          if (id !== undefined) entry.id = id;
          windows.push(entry);
        } catch (_) {}
      }
    } catch (_) {}
  }

  return windows;
}

function normalize(value) {
  return String(value || '').toLowerCase();
}

function matchesWindow(windowInfo, request) {
  if (request.window_id !== undefined && request.window_id !== null && request.window_id !== '') {
    return String(windowInfo.id) === String(request.window_id);
  }

  if (request.pid !== undefined && request.pid !== null && request.pid !== '') {
    return Number(windowInfo.pid) === Number(request.pid);
  }

  const mode = normalize(request.mode || 'title');
  const name = normalize(request.name);
  if (!name) return false;

  if (mode === 'process') {
    const processName = normalize(windowInfo.process);
    return processName === name || processName + '.app' === name || processName.includes(name);
  }

  return normalize(windowInfo.title).includes(name);
}

const request = readInput();
const match = collectWindows().find((windowInfo) => matchesWindow(windowInfo, request));
if (!match) {
  throw new Error('Window not found: ' + (request.mode || 'title') + ' ' + (request.name || request.window_id || request.pid || ''));
}

JSON.stringify({ platform: 'darwin', window: match });
`;

const INTERACTION_SCRIPT = `
ObjC.import('stdlib');
ObjC.import('Foundation');

function readInput() {
  const raw = $.getenv('PEEK_INPUT');
  if (!raw) return {};
  return JSON.parse(ObjC.unwrap($.NSString.stringWithUTF8String(raw)));
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalize(value) {
  return String(value || '').toLowerCase();
}

function readWindowId(windowRef) {
  try {
    const id = toNumber(windowRef.id());
    return id === null ? undefined : id;
  } catch (_) {
    return undefined;
  }
}

function geometryFor(windowRef) {
  const position = windowRef.position();
  const size = windowRef.size();
  return {
    x: Number(position[0]),
    y: Number(position[1]),
    width: Number(size[0]),
    height: Number(size[1]),
  };
}

function matchesProcess(processRef, request) {
  if (request.pid !== undefined && request.pid !== null && request.pid !== '') {
    return Number(processRef.unixId()) === Number(request.pid);
  }

  const mode = normalize(request.mode || 'title');
  const name = normalize(request.name);
  if (!name || mode !== 'process') return true;

  const processName = normalize(processRef.name());
  return processName === name || processName + '.app' === name || processName.includes(name);
}

function matchesWindow(processRef, windowRef, request) {
  const windowId = readWindowId(windowRef);
  if (request.window_id !== undefined && request.window_id !== null && request.window_id !== '') {
    return String(windowId) === String(request.window_id);
  }

  if (!matchesProcess(processRef, request)) return false;

  const mode = normalize(request.mode || 'title');
  const name = normalize(request.name);
  if (!name || mode === 'process') return true;

  return normalize(windowRef.name()).includes(name);
}

function findTarget(request) {
  const systemEvents = Application('System Events');

  for (const processRef of systemEvents.applicationProcesses()) {
    try {
      if (!processRef.visible()) continue;
      if (!matchesProcess(processRef, request)) continue;

      for (const windowRef of processRef.windows()) {
        if (matchesWindow(processRef, windowRef, request)) {
          return { systemEvents, processRef, windowRef };
        }
      }
    } catch (_) {}
  }

  throw new Error('Window target not found: ' + (request.mode || 'title') + ' ' + (request.name || request.window_id || request.pid || ''));
}

function focusTarget(request) {
  if (!request.name && !request.window_id && request.pid === undefined) return null;

  const target = findTarget(request);
  target.processRef.frontmost = true;
  delay(0.1);
  return target;
}

function modifierName(key) {
  const normalized = normalize(key);
  if (normalized === 'command' || normalized === 'cmd' || normalized === 'meta') return 'command down';
  if (normalized === 'shift') return 'shift down';
  if (normalized === 'option' || normalized === 'alt') return 'option down';
  if (normalized === 'control' || normalized === 'ctrl') return 'control down';
  return null;
}

function keyCodeFor(key) {
  const normalized = normalize(key);
  const codes = {
    backspace: 51,
    delete: 51,
    forwarddelete: 117,
    tab: 48,
    enter: 36,
    return: 36,
    escape: 53,
    esc: 53,
    space: 49,
    left: 123,
    right: 124,
    down: 125,
    up: 126,
    home: 115,
    end: 119,
    pageup: 116,
    pagedown: 121,
    f1: 122,
    f2: 120,
    f3: 99,
    f4: 118,
    f5: 96,
    f6: 97,
    f7: 98,
    f8: 100,
    f9: 101,
    f10: 109,
    f11: 103,
    f12: 111,
    f13: 105,
    f14: 107,
    f15: 113,
    f16: 106,
    f17: 64,
    f18: 79,
    f19: 80,
    f20: 90,
  };

  if (codes[normalized] !== undefined) return codes[normalized];
  throw new Error('Unsupported key: ' + key);
}

function commandOptions(modifiers) {
  return modifiers.length > 0 ? { using: modifiers } : {};
}

function sendHotkey(systemEvents, keys) {
  if (!Array.isArray(keys) || keys.length === 0) throw new Error('Hotkey requires at least one key');

  const modifiers = [];
  let key = null;
  for (const part of keys) {
    const modifier = modifierName(part);
    if (modifier) modifiers.push(modifier);
    else key = String(part);
  }

  if (!key) throw new Error('Hotkey requires a non-modifier key');
  if (key.length === 1) {
    systemEvents.keystroke(key.toLowerCase(), commandOptions(modifiers));
  } else {
    systemEvents.keyCode(keyCodeFor(key), commandOptions(modifiers));
  }
}

function appWithStandardAdditions() {
  const app = Application.currentApplication();
  app.includeStandardAdditions = true;
  return app;
}

const request = readInput();
const action = normalize(request.action);
const systemEvents = Application('System Events');
let target = null;
let response = { success: true, action };

switch (action) {
  case 'click':
    target = focusTarget(request);
    {
      const clickOptions = { at: [Number(request.x), Number(request.y)] };
      if (normalize(request.button) === 'right') clickOptions.using = ['control down'];
      systemEvents.click(clickOptions);
      if (request.double) systemEvents.click(clickOptions);
    }
    response = { success: true, action, x: Number(request.x), y: Number(request.y), button: request.button || 'left' };
    break;
  case 'drag':
    target = focusTarget(request);
    systemEvents.drag({ from: [Number(request.from_x), Number(request.from_y)], to: [Number(request.to_x), Number(request.to_y)] });
    response = { success: true, action };
    break;
  case 'type':
    target = focusTarget(request);
    systemEvents.keystroke(String(request.text || ''));
    response = { success: true, action, length: String(request.text || '').length };
    break;
  case 'scroll':
    target = focusTarget(request);
    if (Number(request.delta) < 0) systemEvents.scrollDown(Math.max(1, Math.ceil(Math.abs(Number(request.delta)) / 120)));
    else systemEvents.scrollUp(Math.max(1, Math.ceil(Math.abs(Number(request.delta)) / 120)));
    response = { success: true, action, delta: Number(request.delta) };
    break;
  case 'hotkey':
    target = focusTarget(request);
    sendHotkey(systemEvents, request.keys);
    response = { success: true, action, keys: request.keys };
    break;
  case 'focus':
    target = focusTarget(request);
    response = { success: true, action, rect: geometryFor(target.windowRef) };
    break;
  case 'move':
    target = findTarget(request);
    target.windowRef.position = [Number(request.x), Number(request.y)];
    response = { success: true, action, rect: geometryFor(target.windowRef) };
    break;
  case 'resize':
    target = findTarget(request);
    target.windowRef.size = [Number(request.width), Number(request.height)];
    response = { success: true, action, rect: geometryFor(target.windowRef) };
    break;
  case 'maximize':
    target = findTarget(request);
    target.windowRef.actions.byName('AXZoom').perform();
    response = { success: true, action, rect: geometryFor(target.windowRef) };
    break;
  case 'minimize':
    target = findTarget(request);
    target.windowRef.attributes.byName('AXMinimized').value = true;
    response = { success: true, action };
    break;
  case 'clipboard': {
    const operation = normalize(request.operation || 'get');
    const app = appWithStandardAdditions();
    if (operation === 'set') {
      app.setTheClipboardTo(String(request.text || ''));
      response = { success: true, action, operation, length: String(request.text || '').length };
    } else if (operation === 'get') {
      const text = String(app.theClipboard());
      response = { success: true, action, operation, text, length: text.length };
    } else {
      throw new Error('Unsupported clipboard action: ' + operation);
    }
    break;
  }
  default:
    throw new Error('Unsupported interaction action: ' + action);
}

JSON.stringify(response);
`;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeOutputText(output) {
  const text = Buffer.isBuffer(output) ? output.toString('utf8') : String(output || '');
  return text.replace(/^\uFEFF/, '').trim();
}

function parseJsonOutput(output, fallback) {
  const text = normalizeOutputText(output);
  if (!text) return fallback;

  try {
    return JSON.parse(text);
  } catch (error) {
    error.message = `Invalid osascript JSON output: ${error.message}`;
    error.output = text;
    throw error;
  }
}

function assertFiniteNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new TypeError(`${name} must be a finite number`);
  }
  return number;
}

function assertPositiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return number;
}

function optionalPositiveInteger(value, name) {
  if (value === undefined || value === null || value === '') return undefined;
  return assertPositiveInteger(Number(value), name);
}

function assertString(value, name) {
  if (typeof value !== 'string') {
    throw new TypeError(`${name} must be a string`);
  }
  return value;
}

function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function normalizeImageFormat(value = 'png') {
  const format = String(value || 'png').toLowerCase();
  if (format === 'jpg') return 'jpeg';
  if (format !== 'png' && format !== 'jpeg') {
    throw new TypeError('format must be png, jpeg, or jpg');
  }
  return format;
}

function normalizeQuality(value = 80) {
  if (value === undefined || value === null || value === '') return 80;
  const quality = Number(value);
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) {
    throw new TypeError('quality must be an integer from 1 to 100');
  }
  return quality;
}

function normalizeCrop(crop) {
  if (crop === undefined || crop === null || crop === '') return undefined;

  if (typeof crop === 'string') {
    const parts = crop.split(',').map((part) => Number(part.trim()));
    if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
      throw new TypeError('crop must be "x,y,w,h" or an object');
    }
    return {
      x: parts[0],
      y: parts[1],
      w: assertPositiveInteger(parts[2], 'crop.w'),
      h: assertPositiveInteger(parts[3], 'crop.h'),
    };
  }

  if (!isPlainObject(crop)) {
    throw new TypeError('crop must be "x,y,w,h" or an object');
  }

  const width = crop.w ?? crop.width;
  const height = crop.h ?? crop.height;
  return {
    x: assertFiniteNumber(crop.x, 'crop.x'),
    y: assertFiniteNumber(crop.y, 'crop.y'),
    w: assertPositiveInteger(Number(width), 'crop.w'),
    h: assertPositiveInteger(Number(height), 'crop.h'),
  };
}

function normalizeTarget(options = {}, fallbackMode = 'title') {
  const source = isPlainObject(options.window)
    ? { ...options, ...options.window }
    : { ...options };

  if (typeof options.window === 'string' && !source.name && !source.title && !source.process) {
    source.name = options.window;
    source.mode = source.mode || fallbackMode;
  }

  const windowId = source.window_id ?? source.windowId ?? source.hwnd;
  if (windowId !== undefined && windowId !== null && windowId !== '') {
    return { mode: 'window', window_id: String(windowId) };
  }

  if (source.pid !== undefined && source.pid !== null && source.pid !== '') {
    return { mode: 'pid', pid: assertPositiveInteger(Number(source.pid), 'pid') };
  }

  if (source.process) {
    return { mode: 'process', name: assertNonEmptyString(String(source.process), 'process') };
  }

  if (source.title) {
    return { mode: 'title', name: assertNonEmptyString(String(source.title), 'title') };
  }

  if (source.name) {
    return {
      mode: String(source.mode || fallbackMode).toLowerCase(),
      name: assertNonEmptyString(String(source.name), 'name'),
    };
  }

  return {};
}

function normalizeCaptureOptions(options = {}) {
  const target = normalizeTarget(options, options.mode === 'process' ? 'process' : 'title');
  const mode = target.window_id ? 'window' : String(options.mode || target.mode || 'screen').toLowerCase();
  const normalized = {
    mode,
    ...target,
    format: normalizeImageFormat(options.format),
    quality: normalizeQuality(options.quality),
  };

  const maxWidth = optionalPositiveInteger(options.max_width ?? options.maxWidth, 'max_width');
  if (maxWidth !== undefined) normalized.max_width = maxWidth;

  const crop = normalizeCrop(options.crop);
  if (crop) normalized.crop = crop;

  if (normalized.mode !== 'screen' && !normalized.window_id && !normalized.name && normalized.pid === undefined) {
    throw new TypeError('window capture requires name, process, title, pid, or window_id');
  }

  return normalized;
}

function normalizeButton(button = 'left') {
  const normalized = String(button || 'left').toLowerCase();
  if (!['left', 'right', 'middle'].includes(normalized)) {
    throw new TypeError('button must be left, right, or middle');
  }
  return normalized;
}

function normalizeClickOptions(options = {}) {
  return {
    ...normalizeTarget(options),
    x: assertFiniteNumber(options.x, 'x'),
    y: assertFiniteNumber(options.y, 'y'),
    button: normalizeButton(options.button),
    double: Boolean(options.double),
  };
}

function normalizeDragOptions(options = {}) {
  return {
    ...normalizeTarget(options),
    from_x: assertFiniteNumber(options.from_x ?? options.fromX, 'from_x'),
    from_y: assertFiniteNumber(options.from_y ?? options.fromY, 'from_y'),
    to_x: assertFiniteNumber(options.to_x ?? options.toX, 'to_x'),
    to_y: assertFiniteNumber(options.to_y ?? options.toY, 'to_y'),
    duration_ms: Math.max(0, Number(options.duration_ms ?? options.duration ?? 100)),
  };
}

function normalizeTypeOptions(options = {}) {
  return {
    ...normalizeTarget(options),
    text: assertString(options.text ?? '', 'text'),
  };
}

function normalizeScrollOptions(options = {}) {
  const normalized = {
    ...normalizeTarget(options),
    delta: assertFiniteNumber(options.delta, 'delta'),
  };

  if (options.x !== undefined && options.x !== null) normalized.x = assertFiniteNumber(options.x, 'x');
  if (options.y !== undefined && options.y !== null) normalized.y = assertFiniteNumber(options.y, 'y');
  return normalized;
}

function normalizeHotkeyOptions(options = {}) {
  const rawKeys = Array.isArray(options.keys)
    ? options.keys
    : assertNonEmptyString(String(options.keys || ''), 'keys').split('+');
  const keys = rawKeys.map((key, index) => assertNonEmptyString(String(key).trim(), `keys[${index}]`));
  return {
    ...normalizeTarget(options),
    keys,
  };
}

function normalizeWindowActionOptions(options = {}) {
  const target = normalizeTarget(options);
  if (!target.window_id && !target.name && target.pid === undefined) {
    throw new TypeError('window action requires name, process, title, window, pid, or window_id');
  }
  return target;
}

function normalizeMoveOptions(options = {}) {
  return {
    ...normalizeWindowActionOptions(options),
    x: assertFiniteNumber(options.x, 'x'),
    y: assertFiniteNumber(options.y, 'y'),
  };
}

function normalizeResizeOptions(options = {}) {
  return {
    ...normalizeWindowActionOptions(options),
    width: assertPositiveInteger(Number(options.width), 'width'),
    height: assertPositiveInteger(Number(options.height), 'height'),
  };
}

function normalizeClipboardOptions(options = {}) {
  const operation = String(options.action || options.operation || 'get').toLowerCase();
  if (!['get', 'set'].includes(operation)) {
    throw new TypeError('clipboard action must be get or set');
  }

  const normalized = { operation };
  if (operation === 'set') {
    normalized.text = assertString(options.text ?? '', 'text');
  }
  return normalized;
}

function formatRect(rect) {
  const x = Math.round(rect.x);
  const y = Math.round(rect.y);
  const width = Math.round(rect.width ?? rect.w);
  const height = Math.round(rect.height ?? rect.h);
  if (width <= 0 || height <= 0) {
    throw new Error('Capture rectangle width and height must be positive');
  }
  return `${x},${y},${width},${height}`;
}

function buildCaptureRect(request, targetWindow) {
  if (request.mode === 'screen') {
    if (!request.crop) return null;
    return {
      x: request.crop.x,
      y: request.crop.y,
      width: request.crop.w,
      height: request.crop.h,
    };
  }

  if (!targetWindow || !isPlainObject(targetWindow.geometry)) return null;

  const geometry = targetWindow.geometry;
  if (!request.crop) {
    return {
      x: geometry.x,
      y: geometry.y,
      width: geometry.width,
      height: geometry.height,
    };
  }

  return {
    x: Number(geometry.x) + request.crop.x,
    y: Number(geometry.y) + request.crop.y,
    width: request.crop.w,
    height: request.crop.h,
  };
}

function screencaptureFormat(format) {
  return format === 'jpeg' ? 'jpg' : 'png';
}

function buildScreencaptureArgs(request, targetWindow, outputFile) {
  const args = ['-x', '-t', screencaptureFormat(request.format)];

  if (request.window_id) {
    args.push('-l', String(request.window_id));
  } else {
    const rect = buildCaptureRect(request, targetWindow);
    if (rect) args.push('-R', formatRect(rect));
  }

  args.push(outputFile);
  return args;
}

function readPngDimensions(buffer) {
  if (buffer.length < 24 || buffer.toString('ascii', 1, 4) !== 'PNG') return null;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function isJpegStartOfFrame(marker) {
  return (marker >= 0xC0 && marker <= 0xC3)
    || (marker >= 0xC5 && marker <= 0xC7)
    || (marker >= 0xC9 && marker <= 0xCB)
    || (marker >= 0xCD && marker <= 0xCF);
}

function readJpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xFF || buffer[1] !== 0xD8) return null;

  let offset = 2;
  while (offset + 4 < buffer.length) {
    if (buffer[offset] !== 0xFF) {
      offset += 1;
      continue;
    }

    const marker = buffer[offset + 1];
    offset += 2;
    if (marker === 0xD9 || marker === 0xDA) break;
    if (offset + 2 > buffer.length) break;

    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    if (isJpegStartOfFrame(marker)) {
      return {
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
      };
    }
    offset += length;
  }

  return null;
}

function readImageDimensions(buffer, format) {
  const dimensions = format === 'jpeg' ? readJpegDimensions(buffer) : readPngDimensions(buffer);
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) {
    throw new Error('Unable to read captured image dimensions');
  }
  return dimensions;
}

function normalizeSharpCrop(crop) {
  return {
    left: Math.max(0, Math.round(crop.x)),
    top: Math.max(0, Math.round(crop.y)),
    width: Math.round(crop.w),
    height: Math.round(crop.h),
  };
}

class DarwinPlatformAdapter extends BasePlatformAdapter {
  constructor(options = {}) {
    super({
      ...options,
      platform: 'darwin',
      name: options.name || 'macOS',
      capabilities: options.capabilities || DEFAULT_CAPABILITIES,
    });
    this.osascriptCommand = options.osascriptCommand || 'osascript';
    this.screencaptureCommand = options.screencaptureCommand || 'screencapture';
    this.imageProcessor = options.imageProcessor || null;
  }

  runJxa(script, input = {}, options = {}) {
    const env = {
      ...process.env,
      ...(options.env || {}),
      PEEK_INPUT: JSON.stringify(input || {}),
    };

    return this.execTool(this.osascriptCommand, [...OSASCRIPT_ARGS, script], {
      ...options,
      env,
    });
  }

  runJxaJson(script, input = {}, options = {}, fallback = null) {
    return parseJsonOutput(this.runJxa(script, input, options), fallback);
  }

  async listWindows(options = {}) {
    const result = this.runJxaJson(LIST_WINDOWS_SCRIPT, options, {}, { windows: [] });
    return Array.isArray(result) ? result : result.windows || [];
  }

  resolveWindow(request) {
    const result = this.runJxaJson(RESOLVE_WINDOW_SCRIPT, request);
    const windowInfo = result && result.window ? result.window : result;
    if (!isPlainObject(windowInfo) || !isPlainObject(windowInfo.geometry)) {
      throw new Error('macOS window lookup did not return geometry');
    }
    return windowInfo;
  }

  loadImageProcessor() {
    if (this.imageProcessor) return this.imageProcessor;

    try {
      this.imageProcessor = require('sharp');
      return this.imageProcessor;
    } catch (error) {
      error.message = `Image resizing or post-capture cropping requires sharp: ${error.message}`;
      throw error;
    }
  }

  async transformImage(buffer, request, options = {}) {
    const dimensions = readImageDimensions(buffer, request.format);
    const needsCrop = Boolean(options.crop);
    const needsResize = request.max_width && dimensions.width > request.max_width;

    if (!needsCrop && !needsResize) {
      return { buffer, ...dimensions };
    }

    const sharp = this.loadImageProcessor();
    let pipeline = sharp(buffer);

    if (needsCrop) {
      pipeline = pipeline.extract(normalizeSharpCrop(options.crop));
    }

    if (needsResize) {
      pipeline = pipeline.resize({ width: request.max_width });
    }

    pipeline = request.format === 'jpeg'
      ? pipeline.jpeg({ quality: request.quality })
      : pipeline.png();

    const transformed = await pipeline.toBuffer();
    return {
      buffer: transformed,
      ...readImageDimensions(transformed, request.format),
    };
  }

  async withTempCaptureFile(format, callback) {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'peek-darwin-'));
    const tempFile = path.join(tempDir, `capture.${screencaptureFormat(format)}`);

    try {
      return await callback(tempFile);
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  }

  async capture(options = {}) {
    const request = normalizeCaptureOptions(options);
    const targetWindow = request.mode !== 'screen' && !request.window_id
      ? this.resolveWindow(request)
      : null;

    return this.withTempCaptureFile(request.format, async (tempFile) => {
      this.execTool(this.screencaptureCommand, buildScreencaptureArgs(request, targetWindow, tempFile));

      const rawBuffer = await fs.promises.readFile(tempFile);
      if (rawBuffer.length === 0) {
        throw new Error('macOS capture did not return image data');
      }

      const postCaptureCrop = request.window_id ? request.crop : undefined;
      const image = await this.transformImage(rawBuffer, request, { crop: postCaptureCrop });

      return {
        image: image.buffer.toString('base64'),
        mode: request.mode === 'screen' ? 'screen' : 'window',
        title: targetWindow ? targetWindow.title : null,
        process: targetWindow ? targetWindow.process : null,
        pid: targetWindow ? targetWindow.pid : null,
        window_id: request.window_id || (targetWindow ? targetWindow.id : undefined),
        geometry: targetWindow ? targetWindow.geometry : null,
        width: image.width,
        height: image.height,
        size_bytes: image.buffer.length,
        format: request.format,
        mime_type: MIME_TYPES[request.format],
        annotated_image: null,
        annotated_mime_type: 'image/png',
      };
    });
  }

  async runInteraction(action, payload = {}, options = {}) {
    const result = this.runJxaJson(INTERACTION_SCRIPT, { action, ...payload }, options);
    if (!result || result.success !== true) {
      throw new Error(`macOS interaction failed: ${action}`);
    }
    return result;
  }

  async click(options = {}) {
    return this.runInteraction('click', normalizeClickOptions(options));
  }

  async drag(options = {}) {
    return this.runInteraction('drag', normalizeDragOptions(options));
  }

  async type(options = {}) {
    return this.runInteraction('type', normalizeTypeOptions(options));
  }

  async scroll(options = {}) {
    return this.runInteraction('scroll', normalizeScrollOptions(options));
  }

  async hotkey(options = {}) {
    return this.runInteraction('hotkey', normalizeHotkeyOptions(options));
  }

  async focus(options = {}) {
    return this.runInteraction('focus', normalizeWindowActionOptions(options));
  }

  async move(options = {}) {
    return this.runInteraction('move', normalizeMoveOptions(options));
  }

  async resize(options = {}) {
    return this.runInteraction('resize', normalizeResizeOptions(options));
  }

  async maximize(options = {}) {
    return this.runInteraction('maximize', normalizeWindowActionOptions(options));
  }

  async minimize(options = {}) {
    return this.runInteraction('minimize', normalizeWindowActionOptions(options));
  }

  async clipboard(options = {}) {
    return this.runInteraction('clipboard', normalizeClipboardOptions(options));
  }
}

module.exports = DarwinPlatformAdapter;
