'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const BasePlatformAdapter = require('./base');

const DEFAULT_CAPABILITIES = Object.freeze(['capture', 'compare', 'interact', 'launch', 'windows']);
const MIME_TYPES = Object.freeze({
  png: 'image/png',
  jpeg: 'image/jpeg',
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeOutputText(output) {
  const text = Buffer.isBuffer(output) ? output.toString('utf8') : String(output || '');
  return text.replace(/^\uFEFF/, '').trim();
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

  const windowId = source.window_id ?? source.windowId ?? source.id ?? source.hwnd;
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

function xdotoolButton(button) {
  if (button === 'right') return '3';
  if (button === 'middle') return '2';
  return '1';
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

function parseWindowIds(output) {
  return normalizeOutputText(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseShellOutput(output) {
  const values = {};
  for (const line of normalizeOutputText(output).split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index <= 0) continue;
    values[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return values;
}

function parseGeometry(output) {
  const values = parseShellOutput(output);
  const x = Number(values.X);
  const y = Number(values.Y);
  const width = Number(values.WIDTH);
  const height = Number(values.HEIGHT);

  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return null;
  }

  return { x, y, width, height };
}

function parseXpropValue(output, propertyName) {
  const text = normalizeOutputText(output);
  const line = text.split(/\r?\n/).find((candidate) => candidate.startsWith(`${propertyName}(`));
  if (!line) return null;

  const index = line.indexOf('=');
  return index === -1 ? null : line.slice(index + 1).trim();
}

function parseWindowClass(output) {
  const value = parseXpropValue(output, 'WM_CLASS');
  if (!value) return null;

  const matches = [...value.matchAll(/"([^"]*)"/g)].map((match) => match[1]).filter(Boolean);
  if (matches.length > 1) return matches[matches.length - 1];
  return matches[0] || null;
}

function parseWindowPid(output) {
  const value = parseXpropValue(output, '_NET_WM_PID');
  if (!value) return null;

  const match = value.match(/\d+/);
  if (!match) return null;

  const pid = Number(match[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function parseWindowRole(output) {
  const value = parseXpropValue(output, 'WM_WINDOW_ROLE');
  if (!value) return null;

  const match = value.match(/"([^"]*)"/);
  return match ? match[1] : value;
}

function formatGeometry(rect) {
  const width = Math.round(rect.width ?? rect.w);
  const height = Math.round(rect.height ?? rect.h);
  const x = Math.round(rect.x);
  const y = Math.round(rect.y);

  if (width <= 0 || height <= 0) {
    throw new Error('Capture rectangle width and height must be positive');
  }

  return `${width}x${height}+${x}+${y}`;
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

  if (!request.crop) {
    return targetWindow.geometry;
  }

  return {
    x: Number(targetWindow.geometry.x) + request.crop.x,
    y: Number(targetWindow.geometry.y) + request.crop.y,
    width: request.crop.w,
    height: request.crop.h,
  };
}

function captureExtension(format) {
  return format === 'jpeg' ? 'jpg' : 'png';
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

function normalizeKeyForXdotool(key) {
  const normalized = String(key).trim();
  const lower = normalized.toLowerCase();
  const map = {
    control: 'ctrl',
    command: 'super',
    cmd: 'super',
    meta: 'super',
    option: 'alt',
    escape: 'Escape',
    esc: 'Escape',
    enter: 'Return',
    return: 'Return',
    space: 'space',
    pageup: 'Page_Up',
    pagedown: 'Page_Down',
    arrowleft: 'Left',
    left: 'Left',
    arrowright: 'Right',
    right: 'Right',
    arrowup: 'Up',
    up: 'Up',
    arrowdown: 'Down',
    down: 'Down',
  };

  return map[lower] || normalized;
}

function keyComboForXdotool(keys) {
  return keys.map(normalizeKeyForXdotool).join('+');
}

function isCommandMissing(error) {
  return error && (error.code === 'ENOENT' || error.errno === 'ENOENT');
}

function isSearchMiss(error) {
  return error && !isCommandMissing(error) && Number(error.status) === 1;
}

class LinuxPlatformAdapter extends BasePlatformAdapter {
  constructor(options = {}) {
    super({
      ...options,
      platform: 'linux',
      name: options.name || 'Linux',
      capabilities: options.capabilities || DEFAULT_CAPABILITIES,
    });
    this.xdotoolCommand = options.xdotoolCommand || 'xdotool';
    this.xpropCommand = options.xpropCommand || 'xprop';
    this.maimCommand = options.maimCommand || 'maim';
    this.importCommand = options.importCommand || 'import';
    this.whichCommand = options.whichCommand || 'which';
    this.screenshotCommand = options.screenshotCommand || null;
    this.imageProcessor = options.imageProcessor || null;
  }

  commandExists(command) {
    try {
      this.execTool(this.whichCommand, [command], { stdio: 'ignore' });
      return true;
    } catch (_error) {
      return false;
    }
  }

  resolveScreenshotTool() {
    if (this.screenshotCommand) return this.screenshotCommand;
    if (this.commandExists(this.maimCommand)) return this.maimCommand;
    if (this.commandExists(this.importCommand)) return this.importCommand;
    return this.maimCommand;
  }

  runSearch(args) {
    try {
      return parseWindowIds(this.execTool(this.xdotoolCommand, args));
    } catch (error) {
      if (isSearchMiss(error)) return [];
      throw error;
    }
  }

  listWindowIds() {
    return this.runSearch(['search', '--onlyvisible', '--name', '.']);
  }

  getWindowName(windowId) {
    try {
      return normalizeOutputText(this.execTool(this.xdotoolCommand, ['getwindowname', String(windowId)]));
    } catch (_error) {
      return '';
    }
  }

  getWindowPid(windowId, xpropOutput = '') {
    try {
      const pid = Number(normalizeOutputText(this.execTool(this.xdotoolCommand, ['getwindowpid', String(windowId)])));
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch (_error) {}

    return parseWindowPid(xpropOutput);
  }

  getWindowGeometry(windowId) {
    try {
      return parseGeometry(this.execTool(this.xdotoolCommand, ['getwindowgeometry', '--shell', String(windowId)]));
    } catch (_error) {
      return null;
    }
  }

  getWindowProperties(windowId) {
    try {
      return normalizeOutputText(this.execTool(this.xpropCommand, ['-id', String(windowId)]));
    } catch (_error) {
      return '';
    }
  }

  describeWindow(windowId) {
    const id = String(windowId).trim();
    if (!id) return null;

    const geometry = this.getWindowGeometry(id);
    if (!geometry) return null;

    const xpropOutput = this.getWindowProperties(id);
    const title = this.getWindowName(id);
    const processName = parseWindowClass(xpropOutput);
    const pid = this.getWindowPid(id, xpropOutput);
    const windowRole = parseWindowRole(xpropOutput);

    const entry = {
      id,
      window_id: id,
      title,
      process: processName || '',
      pid,
      geometry,
    };

    if (windowRole) entry.role = windowRole;
    return entry;
  }

  async listWindows() {
    const windows = [];
    for (const windowId of this.listWindowIds()) {
      const windowInfo = this.describeWindow(windowId);
      if (windowInfo) windows.push(windowInfo);
    }
    return windows;
  }

  searchTarget(request) {
    if (request.window_id) return [String(request.window_id)];
    if (request.pid !== undefined) {
      return this.runSearch(['search', '--onlyvisible', '--pid', String(request.pid)]);
    }

    const mode = String(request.mode || 'title').toLowerCase();
    const name = assertNonEmptyString(String(request.name || ''), 'name');
    if (mode === 'process') {
      const classMatches = this.runSearch(['search', '--onlyvisible', '--class', name]);
      if (classMatches.length > 0) return classMatches;
    }

    return this.runSearch(['search', '--onlyvisible', '--name', name]);
  }

  resolveWindow(request) {
    const windowIds = this.searchTarget(request);
    for (const windowId of windowIds) {
      const windowInfo = this.describeWindow(windowId);
      if (windowInfo) return windowInfo;
    }

    throw new Error(`Window not found: ${request.mode || 'title'} ${request.name || request.window_id || request.pid || ''}`.trim());
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
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'peek-linux-'));
    const tempFile = path.join(tempDir, `capture.${captureExtension(format)}`);

    try {
      return await callback(tempFile);
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  }

  buildMaimArgs(request, targetWindow, outputFile) {
    const args = ['-f', captureExtension(request.format)];
    const rect = buildCaptureRect(request, targetWindow);

    if (request.mode !== 'screen' && targetWindow && !request.crop) {
      args.push('-i', String(targetWindow.window_id || targetWindow.id));
    } else if (rect) {
      args.push('-g', formatGeometry(rect));
    }

    args.push(outputFile);
    return args;
  }

  buildImportArgs(request, targetWindow, outputFile) {
    const args = [];
    const rect = buildCaptureRect(request, targetWindow);

    if (rect && (request.mode === 'screen' || request.crop)) {
      args.push('-window', 'root', '-crop', formatGeometry(rect));
    } else if (request.mode !== 'screen' && targetWindow) {
      args.push('-window', String(targetWindow.window_id || targetWindow.id));
    } else {
      args.push('-window', 'root');
    }

    args.push(outputFile);
    return args;
  }

  captureArgsForTool(tool, request, targetWindow, outputFile) {
    if (path.basename(tool) === path.basename(this.importCommand)) {
      return this.buildImportArgs(request, targetWindow, outputFile);
    }

    return this.buildMaimArgs(request, targetWindow, outputFile);
  }

  async capture(options = {}) {
    const request = normalizeCaptureOptions(options);
    const targetWindow = request.mode === 'screen' ? null : this.resolveWindow(request);
    const screenshotTool = this.resolveScreenshotTool();

    return this.withTempCaptureFile(request.format, async (tempFile) => {
      const args = this.captureArgsForTool(screenshotTool, request, targetWindow, tempFile);
      this.execTool(screenshotTool, args);

      const rawBuffer = await fs.promises.readFile(tempFile);
      if (rawBuffer.length === 0) {
        throw new Error('Linux capture did not return image data');
      }

      const image = await this.transformImage(rawBuffer, request);

      return {
        image: image.buffer.toString('base64'),
        mode: request.mode === 'screen' ? 'screen' : 'window',
        title: targetWindow ? targetWindow.title : null,
        process: targetWindow ? targetWindow.process : null,
        pid: targetWindow ? targetWindow.pid : null,
        window_id: targetWindow ? targetWindow.window_id : request.window_id,
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

  maybeActivateTarget(payload) {
    if (!payload.window_id && !payload.name && payload.pid === undefined) return null;

    const targetWindow = this.resolveWindow(payload);
    this.execTool(this.xdotoolCommand, ['windowactivate', '--sync', String(targetWindow.window_id)]);
    return targetWindow;
  }

  async click(options = {}) {
    const payload = normalizeClickOptions(options);
    this.maybeActivateTarget(payload);

    const args = ['mousemove', String(payload.x), String(payload.y), 'click'];
    if (payload.double) args.push('--repeat', '2');
    args.push(xdotoolButton(payload.button));

    this.execTool(this.xdotoolCommand, args);
    return {
      success: true,
      action: 'click',
      x: payload.x,
      y: payload.y,
      button: payload.button,
    };
  }

  async drag(options = {}) {
    const payload = normalizeDragOptions(options);
    this.maybeActivateTarget(payload);

    this.execTool(this.xdotoolCommand, [
      'mousemove',
      String(payload.from_x),
      String(payload.from_y),
      'mousedown',
      '1',
      'mousemove',
      String(payload.to_x),
      String(payload.to_y),
      'mouseup',
      '1',
    ]);

    return { success: true, action: 'drag' };
  }

  async type(options = {}) {
    const payload = normalizeTypeOptions(options);
    this.maybeActivateTarget(payload);

    this.execTool(this.xdotoolCommand, ['type', '--clearmodifiers', '--', payload.text]);
    return {
      success: true,
      action: 'type',
      length: payload.text.length,
    };
  }

  async scroll(options = {}) {
    const payload = normalizeScrollOptions(options);
    this.maybeActivateTarget(payload);

    if (payload.x !== undefined && payload.y !== undefined) {
      this.execTool(this.xdotoolCommand, ['mousemove', String(payload.x), String(payload.y)]);
    }

    const button = payload.delta < 0 ? '5' : '4';
    const repeat = String(Math.max(1, Math.ceil(Math.abs(payload.delta) / 120)));
    this.execTool(this.xdotoolCommand, ['click', '--repeat', repeat, button]);
    return {
      success: true,
      action: 'scroll',
      delta: payload.delta,
    };
  }

  async hotkey(options = {}) {
    const payload = normalizeHotkeyOptions(options);
    this.maybeActivateTarget(payload);

    this.execTool(this.xdotoolCommand, ['key', keyComboForXdotool(payload.keys)]);
    return {
      success: true,
      action: 'hotkey',
      keys: payload.keys,
    };
  }

  async focus(options = {}) {
    const targetWindow = this.maybeActivateTarget(normalizeWindowActionOptions(options));
    return {
      success: true,
      action: 'focus',
      rect: targetWindow ? targetWindow.geometry : null,
    };
  }

  async move(options = {}) {
    const payload = normalizeMoveOptions(options);
    const targetWindow = this.resolveWindow(payload);
    this.execTool(this.xdotoolCommand, [
      'windowmove',
      String(targetWindow.window_id),
      String(payload.x),
      String(payload.y),
    ]);

    return { success: true, action: 'move' };
  }

  async resize(options = {}) {
    const payload = normalizeResizeOptions(options);
    const targetWindow = this.resolveWindow(payload);
    this.execTool(this.xdotoolCommand, [
      'windowsize',
      String(targetWindow.window_id),
      String(payload.width),
      String(payload.height),
    ]);

    return { success: true, action: 'resize' };
  }

  async maximize(options = {}) {
    const targetWindow = this.resolveWindow(normalizeWindowActionOptions(options));
    this.execTool(this.xdotoolCommand, [
      'windowsize',
      String(targetWindow.window_id),
      '100%',
      '100%',
      'windowmove',
      String(targetWindow.window_id),
      '0',
      '0',
    ]);

    return { success: true, action: 'maximize' };
  }

  async minimize(options = {}) {
    const targetWindow = this.resolveWindow(normalizeWindowActionOptions(options));
    this.execTool(this.xdotoolCommand, ['windowminimize', String(targetWindow.window_id)]);
    return { success: true, action: 'minimize' };
  }

  runClipboardWithXclip(payload) {
    if (payload.operation === 'set') {
      this.execTool('xclip', ['-selection', 'clipboard', '-in'], { input: payload.text });
      return {
        success: true,
        action: 'clipboard',
        operation: 'set',
        length: payload.text.length,
      };
    }

    const text = normalizeOutputText(this.execTool('xclip', ['-selection', 'clipboard', '-out']));
    return {
      success: true,
      action: 'clipboard',
      operation: 'get',
      text,
      length: text.length,
    };
  }

  runClipboardWithXsel(payload) {
    if (payload.operation === 'set') {
      this.execTool('xsel', ['--clipboard', '--input'], { input: payload.text });
      return {
        success: true,
        action: 'clipboard',
        operation: 'set',
        length: payload.text.length,
      };
    }

    const text = normalizeOutputText(this.execTool('xsel', ['--clipboard', '--output']));
    return {
      success: true,
      action: 'clipboard',
      operation: 'get',
      text,
      length: text.length,
    };
  }

  async clipboard(options = {}) {
    const payload = normalizeClipboardOptions(options);

    try {
      return this.runClipboardWithXclip(payload);
    } catch (error) {
      if (!isCommandMissing(error)) throw error;
    }

    try {
      return this.runClipboardWithXsel(payload);
    } catch (error) {
      if (!isCommandMissing(error)) throw error;
    }

    throw new Error('Linux clipboard requires xclip or xsel');
  }
}

module.exports = LinuxPlatformAdapter;
